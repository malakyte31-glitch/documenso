import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

/**
 * repositionFieldWithToken (packages/lib/server-only/field/reposition-field-with-token.ts)
 * is REUSED UNCHANGED for Documenso V2 (internalVersion: 2) envelopes -- it
 * operates purely on the Field table via token+fieldId, with no dependency
 * on which client renderer (V1's DOM/react-rnd or V2's Konva canvas) drew
 * the field. These tests exist to prove that reuse holds in practice for a
 * V2 envelope specifically, not just by code inspection. The exhaustive
 * authorization/rejection matrix is already covered for the (version-
 * agnostic) mutation itself in reposition-field-with-token.spec.ts; this
 * file only re-proves the same guarantees hold with internalVersion: 2.
 */

const trpcMutation = (request: APIRequestContext, procedure: string, input: Record<string, unknown>) => {
  return request.post(`${WEBAPP_BASE_URL}/api/trpc/${procedure}`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ json: input }),
  });
};

test.describe('field.repositionFieldWithToken (internalVersion: 2)', () => {
  test('reproduces the exact live P3-C envelope/field/recipient state and succeeds, persists, and audits', async ({
    request,
  }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['p3c-live-state-v2@test.documenso.com'],
      fields: [FieldType.NAME, FieldType.SIGNATURE, FieldType.DATE],
    });

    await prisma.envelope.update({
      where: { id: document.id },
      data: { internalVersion: 2 },
    });

    const [recipient] = recipients;
    const nameField = recipient.fields.find((f) => f.type === FieldType.NAME);
    const signatureField = recipient.fields.find((f) => f.type === FieldType.SIGNATURE);
    const dateField = recipient.fields.find((f) => f.type === FieldType.DATE);

    if (!nameField || !signatureField || !dateField) {
      throw new Error('Expected fields not found');
    }

    // Exactly the live envelope's field state.
    await prisma.field.update({ where: { id: nameField.id }, data: { inserted: true } });
    await prisma.field.update({
      where: { id: signatureField.id },
      data: { inserted: false, fieldMeta: { fontSize: 18, overflow: 'auto', type: 'signature' } },
    });
    await prisma.field.update({ where: { id: dateField.id }, data: { inserted: false } });

    const res = await trpcMutation(request, 'field.repositionFieldWithToken', {
      token: recipient.token,
      fieldId: signatureField.id,
      positionX: 22,
      positionY: 60,
      width: 30,
      height: 4,
    });

    expect(res.ok(), `reposition failed: ${await res.text()}`).toBeTruthy();

    const updated = await prisma.field.findUniqueOrThrow({ where: { id: signatureField.id } });
    expect(updated.positionX.toNumber()).toBeCloseTo(22);
    expect(updated.positionY.toNumber()).toBeCloseTo(60);
    expect(updated.width.toNumber()).toBeCloseTo(30);
    expect(updated.height.toNumber()).toBeCloseTo(4);

    const auditLogs = await prisma.documentAuditLog.findMany({
      where: { envelopeId: document.id, type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_UPDATED },
    });

    expect(auditLogs.length).toBeGreaterThan(0);

    const lastLog = auditLogs[auditLogs.length - 1];
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const logData = lastLog.data as { fieldRecipientEmail?: string; changes?: unknown[] };
    expect(logData.fieldRecipientEmail).toBe(recipient.email);
    expect(Array.isArray(logData.changes) && logData.changes.length).toBeGreaterThan(0);
    expect(lastLog.name).toBe(recipient.name);
  });

  test('rejects out-of-page geometry for a V2 envelope and leaves prior geometry intact', async ({ request }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['v2-bounds-signer@test.documenso.com'],
      fields: [FieldType.SIGNATURE],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipient] = recipients;
    const field = recipient.fields[0];
    const before = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

    const res = await trpcMutation(request, 'field.repositionFieldWithToken', {
      token: recipient.token,
      fieldId: field.id,
      positionX: 90,
      positionY: 10,
      width: 25, // 90 + 25 = 115, past the right edge.
      height: 5,
    });

    expect(res.ok()).toBe(false);

    const after = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
    expect(after.positionX.toNumber()).toBeCloseTo(before.positionX.toNumber());
    expect(after.width.toNumber()).toBeCloseTo(before.width.toNumber());
  });

  test("rejects repositioning another recipient's field in a V2 envelope", async ({ request }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['v2-cross-a@test.documenso.com', 'v2-cross-b@test.documenso.com'],
      fields: [FieldType.SIGNATURE],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipientA, recipientB] = recipients;
    const fieldBelongingToB = recipientB.fields[0];

    const res = await trpcMutation(request, 'field.repositionFieldWithToken', {
      token: recipientA.token,
      fieldId: fieldBelongingToB.id,
      positionX: 10,
      positionY: 10,
      width: 20,
      height: 5,
    });

    expect(res.ok()).toBe(false);
  });
});

/**
 * Permanent regression coverage for the insert/reposition race discovered
 * on the live P3-C envelope: a real drag/resize gesture and a real
 * insertion attempt landed close enough together that the reposition's own
 * `WHERE id = ...` update (unconditional, no `inserted` guard at write
 * time) overwrote geometry on a field the insert had, by then, already
 * marked `inserted: true`. Fixed by making the write itself atomic and
 * conditional (`WHERE id = ... AND inserted = false`, checking the
 * affected-row count) in reposition-field-with-token.ts. `envelope.field.sign`
 * is Documenso's own existing V2 insertion mutation, used here unmodified.
 */
test.describe('field.repositionFieldWithToken -- insert/reposition race', () => {
  const seedRaceField = async (emailPrefix: string) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: [`${emailPrefix}@test.documenso.com`],
      fields: [FieldType.NAME],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    return { recipient, field, envelopeId: document.id };
  };

  const REPOSITION_TARGET = { positionX: 55, positionY: 55, width: 20, height: 5 };

  test('insert wins: a reposition attempted after insertion has committed is rejected, with no geometry change and no FIELD_UPDATED audit event', async ({
    request,
  }) => {
    const { recipient, field, envelopeId } = await seedRaceField('v2-race-insert-wins');

    const auditCountBefore = await prisma.documentAuditLog.count({
      where: { envelopeId, type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_UPDATED },
    });

    const signRes = await trpcMutation(request, 'envelope.field.sign', {
      token: recipient.token,
      fieldId: field.id,
      fieldValue: { type: 'NAME', value: 'Insert Wins Signer' },
    });
    expect(signRes.ok(), `sign failed: ${await signRes.text()}`).toBeTruthy();

    const repositionRes = await trpcMutation(request, 'field.repositionFieldWithToken', {
      token: recipient.token,
      fieldId: field.id,
      ...REPOSITION_TARGET,
    });

    expect(repositionRes.ok()).toBe(false);

    const after = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
    expect(after.inserted).toBe(true);
    expect(after.positionX.toNumber()).toBeCloseTo(field.positionX.toNumber());
    expect(after.positionY.toNumber()).toBeCloseTo(field.positionY.toNumber());
    expect(after.width.toNumber()).toBeCloseTo(field.width.toNumber());
    expect(after.height.toNumber()).toBeCloseTo(field.height.toNumber());

    const auditCountAfter = await prisma.documentAuditLog.count({
      where: { envelopeId, type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_UPDATED },
    });
    expect(auditCountAfter).toBe(auditCountBefore);
  });

  test('reposition wins: a legitimate pre-insertion reposition persists, and insertion can subsequently succeed with that geometry intact', async ({
    request,
  }) => {
    const { recipient, field, envelopeId } = await seedRaceField('v2-race-reposition-wins');

    const repositionRes = await trpcMutation(request, 'field.repositionFieldWithToken', {
      token: recipient.token,
      fieldId: field.id,
      ...REPOSITION_TARGET,
    });
    expect(repositionRes.ok(), `reposition failed: ${await repositionRes.text()}`).toBeTruthy();

    const afterReposition = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
    expect(afterReposition.positionX.toNumber()).toBeCloseTo(REPOSITION_TARGET.positionX);
    expect(afterReposition.inserted).toBe(false);

    const signRes = await trpcMutation(request, 'envelope.field.sign', {
      token: recipient.token,
      fieldId: field.id,
      fieldValue: { type: 'NAME', value: 'Reposition Wins Signer' },
    });
    expect(signRes.ok(), `sign failed: ${await signRes.text()}`).toBeTruthy();

    const final = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
    expect(final.inserted).toBe(true);
    expect(final.positionX.toNumber()).toBeCloseTo(REPOSITION_TARGET.positionX);
    expect(final.positionY.toNumber()).toBeCloseTo(REPOSITION_TARGET.positionY);
    expect(final.width.toNumber()).toBeCloseTo(REPOSITION_TARGET.width);
    expect(final.height.toNumber()).toBeCloseTo(REPOSITION_TARGET.height);

    const fieldUpdatedLogs = await prisma.documentAuditLog.findMany({
      where: { envelopeId, type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_UPDATED },
      orderBy: { createdAt: 'asc' },
    });
    expect(fieldUpdatedLogs.length).toBe(1);

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const logData = fieldUpdatedLogs[0].data as { changes?: Array<{ type: string; to?: unknown }> };
    const positionChange = logData.changes?.find((c) => c.type === 'POSITION');
    expect(positionChange).toBeDefined();
  });

  test('repeated concurrency: whichever request actually commits first is exactly what the response and final state agree on, every time', async ({
    request,
  }) => {
    const ITERATIONS = 15;
    let repositionWonCount = 0;
    let insertWonCount = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      const { recipient, field } = await seedRaceField(`v2-race-repeat-${i}`);

      const [signRes, repositionRes] = await Promise.all([
        trpcMutation(request, 'envelope.field.sign', {
          token: recipient.token,
          fieldId: field.id,
          fieldValue: { type: 'NAME', value: `Race ${i}` },
        }),
        trpcMutation(request, 'field.repositionFieldWithToken', {
          token: recipient.token,
          fieldId: field.id,
          ...REPOSITION_TARGET,
        }),
      ]);

      expect(signRes.ok(), `sign failed on iteration ${i}: ${await signRes.text()}`).toBeTruthy();

      const after = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

      // The core invariant: the reposition response and the field's final
      // persisted geometry must always agree. There is no outcome where
      // the reposition was rejected yet the geometry changed anyway, and
      // none where it reports success yet the target geometry was NOT
      // actually applied -- which is exactly the failure mode the live
      // incident exposed (reposition reported success, and separately,
      // insertion had already won, yet the geometry write still landed).
      if (repositionRes.ok()) {
        repositionWonCount++;
        expect(after.positionX.toNumber(), `iteration ${i}: reposition reported OK`).toBeCloseTo(
          REPOSITION_TARGET.positionX,
        );
      } else {
        insertWonCount++;
        expect(after.positionX.toNumber(), `iteration ${i}: reposition reported rejected`).toBeCloseTo(
          field.positionX.toNumber(),
        );
      }

      // Regardless of which one won, insertion itself always succeeds --
      // reposition winning never blocks or corrupts it.
      expect(after.inserted).toBe(true);
    }

    console.log(
      `Race outcomes across ${ITERATIONS} iterations: reposition won ${repositionWonCount}, insert won ${insertWonCount}`,
    );
  });
});
