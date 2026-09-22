import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { DocumentStatus, FieldType, SigningStatus } from '@prisma/client';

import { apiSeedPendingDocument } from '../../fixtures/api-seeds';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

/**
 * Calls a tRPC mutation directly over HTTP, mirroring
 * partial-signed-pdf-download.spec.ts's own helper -- but returns the raw
 * response instead of asserting success, since several tests here need
 * to assert a REJECTION (wrong recipient, already-inserted, envelope not
 * pending, out-of-page geometry).
 */
const trpcMutation = (request: APIRequestContext, procedure: string, input: Record<string, unknown>) => {
  return request.post(`${WEBAPP_BASE_URL}/api/trpc/${procedure}`, {
    headers: {
      'content-type': 'application/json',
    },
    data: JSON.stringify({ json: input }),
  });
};

const VALID_GEOMETRY = { positionX: 20, positionY: 30, width: 25, height: 8 };

test.describe('field.repositionFieldWithToken', () => {
  test('a recipient can reposition/resize their own not-yet-inserted field, geometry is persisted, and an audit log entry is recorded attributing the recipient', async ({
    request,
  }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'reposition-owner@test.documenso.com', name: 'Reposition Owner' }],
      fieldsPerRecipient: [
        [
          {
            type: FieldType.NAME,
            page: 1,
            positionX: 5,
            positionY: 5,
            width: 15,
            height: 5,
            fieldMeta: { type: 'name', label: 'Full name', required: true },
          },
          // envelope.distribute requires every signer to have at least one
          // signature field -- unrelated to what this test exercises, but
          // required for the seed to succeed at all.
          { type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 30, width: 15, height: 5 },
        ],
      ],
    });

    const [recipient] = distributeResult.recipients;
    const field = envelope.fields.find((f) => f.recipientId === recipient.id && f.type === FieldType.NAME);

    if (!field) {
      throw new Error('Expected NAME field not found');
    }

    const res = await trpcMutation(request, 'field.repositionFieldWithToken', {
      token: recipient.token,
      fieldId: field.id,
      ...VALID_GEOMETRY,
    });

    expect(res.ok(), `reposition failed: ${await res.text()}`).toBeTruthy();

    const updatedField = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

    // Geometry persisted to the real Field row -- this is exactly what
    // seal-document.handler.ts reads fresh at sealing time, so this
    // assertion is the load-bearing proof that a reposition actually
    // reaches the PDF, not just the browser.
    expect(updatedField.positionX.toNumber()).toBeCloseTo(VALID_GEOMETRY.positionX);
    expect(updatedField.positionY.toNumber()).toBeCloseTo(VALID_GEOMETRY.positionY);
    expect(updatedField.width.toNumber()).toBeCloseTo(VALID_GEOMETRY.width);
    expect(updatedField.height.toNumber()).toBeCloseTo(VALID_GEOMETRY.height);

    // Never touched: type, recipientId, inserted, fieldMeta.
    expect(updatedField.type).toBe(FieldType.NAME);
    expect(updatedField.recipientId).toBe(recipient.id);
    expect(updatedField.inserted).toBe(false);
    expect(updatedField.fieldMeta).toEqual({ type: 'name', label: 'Full name', required: true });

    const auditLog = await prisma.documentAuditLog.findFirst({
      where: {
        envelopeId: envelope.id,
        type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_UPDATED,
      },
      orderBy: { createdAt: 'desc' },
    });

    expect(auditLog).not.toBeNull();
    // Attributed to the RECIPIENT, never a team user.
    expect(auditLog?.email).toBe(recipient.email);
    expect(auditLog?.userId).toBeNull();

    const auditData = auditLog?.data as { changes?: Array<{ type: string; from: unknown; to: unknown }> };
    expect(auditData.changes?.some((c) => c.type === 'POSITION')).toBe(true);
    expect(auditData.changes?.some((c) => c.type === 'DIMENSION')).toBe(true);
  });

  test('rejects repositioning a field that belongs to a different recipient', async ({ request }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [
        { email: 'reposition-a@test.documenso.com', name: 'Recipient A' },
        { email: 'reposition-b@test.documenso.com', name: 'Recipient B' },
      ],
      fieldsPerRecipient: [
        [{ type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 15, height: 5 }],
        [{ type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 20, width: 15, height: 5 }],
      ],
    });

    const [recipientA, recipientB] = distributeResult.recipients;
    const fieldBelongingToB = envelope.fields.find((f) => f.recipientId === recipientB.id);

    if (!fieldBelongingToB) {
      throw new Error('Expected field for recipient B not found');
    }

    // Recipient A's token, targeting recipient B's field.
    const res = await trpcMutation(request, 'field.repositionFieldWithToken', {
      token: recipientA.token,
      fieldId: fieldBelongingToB.id,
      ...VALID_GEOMETRY,
    });

    expect(res.ok()).toBeFalsy();

    const untouchedField = await prisma.field.findUniqueOrThrow({ where: { id: fieldBelongingToB.id } });
    expect(untouchedField.positionX.toNumber()).toBeCloseTo(5);
    expect(untouchedField.positionY.toNumber()).toBeCloseTo(20);
  });

  test('rejects repositioning once the field has already been inserted (finalized)', async ({ request }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'reposition-inserted@test.documenso.com', name: 'Inserted Field Signer' }],
      fieldsPerRecipient: [[{ type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 15, height: 5 }]],
    });

    const [recipient] = distributeResult.recipients;
    const field = envelope.fields.find((f) => f.recipientId === recipient.id);

    if (!field) {
      throw new Error('Expected field not found');
    }

    const signRes = await trpcMutation(request, 'field.signFieldWithToken', {
      token: recipient.token,
      fieldId: field.id,
      value: 'Signature',
    });
    expect(signRes.ok(), `sign failed: ${await signRes.text()}`).toBeTruthy();

    const repositionRes = await trpcMutation(request, 'field.repositionFieldWithToken', {
      token: recipient.token,
      fieldId: field.id,
      ...VALID_GEOMETRY,
    });

    expect(repositionRes.ok()).toBeFalsy();

    const untouchedField = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
    expect(untouchedField.positionX.toNumber()).toBeCloseTo(5);
    expect(untouchedField.inserted).toBe(true);
  });

  test('rejects repositioning once the recipient has already signed the whole document', async ({ request }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'reposition-signed@test.documenso.com', name: 'Signed Recipient' }],
      fieldsPerRecipient: [
        [
          { type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 15, height: 5 },
          { type: FieldType.NAME, page: 1, positionX: 5, positionY: 20, width: 15, height: 5 },
        ],
      ],
    });

    const [recipient] = distributeResult.recipients;
    const signatureField = envelope.fields.find(
      (f) => f.recipientId === recipient.id && f.type === FieldType.SIGNATURE,
    );
    const nameField = envelope.fields.find((f) => f.recipientId === recipient.id && f.type === FieldType.NAME);

    if (!signatureField || !nameField) {
      throw new Error('Expected fields not found');
    }

    // Insert every field, then mark the recipient SIGNED directly --
    // recipient.signingStatus === SIGNED is its own independent guard in
    // repositionFieldWithToken, on top of the per-field `inserted` check.
    await trpcMutation(request, 'field.signFieldWithToken', {
      token: recipient.token,
      fieldId: signatureField.id,
      value: 'Signature',
    });
    await trpcMutation(request, 'field.signFieldWithToken', {
      token: recipient.token,
      fieldId: nameField.id,
      value: 'Full Name',
    });

    await prisma.recipient.update({
      where: { id: recipient.id },
      data: { signingStatus: SigningStatus.SIGNED },
    });

    const res = await trpcMutation(request, 'field.repositionFieldWithToken', {
      token: recipient.token,
      fieldId: nameField.id,
      ...VALID_GEOMETRY,
    });

    expect(res.ok()).toBeFalsy();
  });

  test('rejects repositioning once the envelope is no longer PENDING (e.g. deleted)', async ({ request }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'reposition-deleted-envelope@test.documenso.com', name: 'Deleted Envelope Signer' }],
      fieldsPerRecipient: [[{ type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 15, height: 5 }]],
    });

    const [recipient] = distributeResult.recipients;
    const field = envelope.fields.find((f) => f.recipientId === recipient.id);

    if (!field) {
      throw new Error('Expected field not found');
    }

    await prisma.envelope.update({
      where: { id: envelope.id },
      data: { deletedAt: new Date() },
    });

    const res = await trpcMutation(request, 'field.repositionFieldWithToken', {
      token: recipient.token,
      fieldId: field.id,
      ...VALID_GEOMETRY,
    });

    expect(res.ok()).toBeFalsy();
  });

  test('rejects malformed/out-of-page geometry before it can be persisted', async ({ request }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'reposition-bad-geometry@test.documenso.com', name: 'Bad Geometry Signer' }],
      fieldsPerRecipient: [[{ type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 15, height: 5 }]],
    });

    const [recipient] = distributeResult.recipients;
    const field = envelope.fields.find((f) => f.recipientId === recipient.id);

    if (!field) {
      throw new Error('Expected field not found');
    }

    const outOfRangePositionRes = await trpcMutation(request, 'field.repositionFieldWithToken', {
      token: recipient.token,
      fieldId: field.id,
      positionX: 150,
      positionY: 30,
      width: 25,
      height: 8,
    });
    expect(outOfRangePositionRes.ok()).toBeFalsy();

    const extendsPastEdgeRes = await trpcMutation(request, 'field.repositionFieldWithToken', {
      token: recipient.token,
      fieldId: field.id,
      positionX: 90,
      positionY: 30,
      width: 25, // 90 + 25 > 100 -- would extend past the right edge of the page.
      height: 8,
    });
    expect(extendsPastEdgeRes.ok()).toBeFalsy();

    const untouchedField = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
    expect(untouchedField.positionX.toNumber()).toBeCloseTo(5);
    expect(untouchedField.positionY.toNumber()).toBeCloseTo(5);
  });

  test('a completed seal after a valid reposition flattens the PDF using the recipient-chosen geometry, not the original placement', async ({
    request,
  }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'reposition-seal@test.documenso.com', name: 'Seal Test Signer' }],
      fieldsPerRecipient: [[{ type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 15, height: 5 }]],
    });

    const [recipient] = distributeResult.recipients;
    const documentId = mapSecondaryIdToDocumentId(envelope.secondaryId);
    const field = envelope.fields.find((f) => f.recipientId === recipient.id);

    if (!field) {
      throw new Error('Expected field not found');
    }

    const repositionRes = await trpcMutation(request, 'field.repositionFieldWithToken', {
      token: recipient.token,
      fieldId: field.id,
      ...VALID_GEOMETRY,
    });
    expect(repositionRes.ok(), `reposition failed: ${await repositionRes.text()}`).toBeTruthy();

    await trpcMutation(request, 'field.signFieldWithToken', {
      token: recipient.token,
      fieldId: field.id,
      value: 'Signature',
    });
    await trpcMutation(request, 'recipient.completeDocumentWithToken', {
      token: recipient.token,
      documentId,
    });

    await expect(async () => {
      const dbEnvelope = await prisma.envelope.findUniqueOrThrow({ where: { id: envelope.id } });
      expect(dbEnvelope.status).toBe(DocumentStatus.COMPLETED);
    }).toPass({ timeout: 15_000 });

    // The Field row itself still reflects the recipient's chosen geometry
    // after sealing -- seal-document.handler.ts reads this table fresh,
    // so this is direct evidence the completed PDF was flattened using
    // the repositioned coordinates, not the original sender placement.
    const sealedField = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
    expect(sealedField.positionX.toNumber()).toBeCloseTo(VALID_GEOMETRY.positionX);
    expect(sealedField.positionY.toNumber()).toBeCloseTo(VALID_GEOMETRY.positionY);
  });

  test('two rapid repositions of the same field from the same token resolve deterministically (last write wins, no corruption)', async ({
    request,
  }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      recipients: [{ email: 'reposition-race@test.documenso.com', name: 'Race Condition Signer' }],
      fieldsPerRecipient: [[{ type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 15, height: 5 }]],
    });

    const [recipient] = distributeResult.recipients;
    const field = envelope.fields.find((f) => f.recipientId === recipient.id);

    if (!field) {
      throw new Error('Expected field not found');
    }

    const [resA, resB] = await Promise.all([
      trpcMutation(request, 'field.repositionFieldWithToken', {
        token: recipient.token,
        fieldId: field.id,
        positionX: 10,
        positionY: 10,
        width: 20,
        height: 6,
      }),
      trpcMutation(request, 'field.repositionFieldWithToken', {
        token: recipient.token,
        fieldId: field.id,
        positionX: 40,
        positionY: 40,
        width: 20,
        height: 6,
      }),
    ]);

    expect(resA.ok()).toBeTruthy();
    expect(resB.ok()).toBeTruthy();

    const finalField = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

    // Whichever write landed last, the row is one consistent, valid
    // geometry -- not a mix of the two (e.g. x from one write, y from
    // the other).
    const isConsistentWithA = finalField.positionX.toNumber() === 10 && finalField.positionY.toNumber() === 10;
    const isConsistentWithB = finalField.positionX.toNumber() === 40 && finalField.positionY.toNumber() === 40;
    expect(isConsistentWithA || isConsistentWithB).toBe(true);
  });
});
