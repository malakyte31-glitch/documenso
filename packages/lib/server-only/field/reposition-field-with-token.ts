import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import type { RequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { createDocumentAuditLogData, diffFieldChanges } from '@documenso/lib/utils/document-audit-logs';
import { assertRecipientNotExpired } from '@documenso/lib/utils/recipients';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, RecipientRole, SigningStatus } from '@prisma/client';

export type RepositionFieldWithTokenOptions = {
  token: string;
  fieldId: number;
  positionX: number;
  positionY: number;
  width: number;
  height: number;
  requestMetadata?: RequestMetadata;
};

/**
 * Lets a recipient reposition/resize a field assigned to them -- their
 * handwritten signature may be wider or taller than the sender expected,
 * their name may not fit, or the field may overlap printed content -- so
 * they can fix it themselves before completing the document, in addition
 * to (never instead of) sender-side placement.
 *
 * Deliberately mirrors sign-field-with-token.ts's own authorization
 * sequence exactly (recipient resolved from token, field lookup scoped to
 * that exact recipientId, envelope must be PENDING and not deleted,
 * recipient must not be expired or already SIGNED, field must not already
 * be `inserted`) -- this is the same boundary that already protects field
 * VALUES, reused here to protect field GEOMETRY too. This never touches
 * fieldMeta, type, recipientId, inserted, customText, or signing order --
 * only the four geometry columns Prisma actually needs to move/resize a
 * field.
 */
export const repositionFieldWithToken = async ({
  token,
  fieldId,
  positionX,
  positionY,
  width,
  height,
  requestMetadata,
}: RepositionFieldWithTokenOptions) => {
  const recipient = await prisma.recipient.findFirstOrThrow({
    where: {
      token,
    },
  });

  const field = await prisma.field.findFirstOrThrow({
    where: {
      id: fieldId,
      recipient: {
        // Assistants may act on behalf of a not-yet-signed recipient later
        // in the signing order -- everyone else may only ever touch their
        // own, exact recipient row. Mirrors sign-field-with-token.ts.
        ...(recipient.role !== RecipientRole.ASSISTANT
          ? {
              id: recipient.id,
            }
          : {
              signingStatus: {
                not: SigningStatus.SIGNED,
              },
              signingOrder: {
                gte: recipient.signingOrder ?? 0,
              },
              envelopeId: recipient.envelopeId,
            }),
      },
    },
    include: {
      envelope: true,
      recipient: true,
    },
  });

  const { envelope } = field;

  if (!envelope) {
    throw new Error(`Document not found for field ${field.id}`);
  }

  if (envelope.deletedAt) {
    throw new Error(`Document ${envelope.id} has been deleted`);
  }

  if (envelope.status !== DocumentStatus.PENDING) {
    throw new Error(`Document ${envelope.id} must be pending for signing`);
  }

  assertRecipientNotExpired(recipient);

  if (recipient.signingStatus === SigningStatus.SIGNED || field.recipient.signingStatus === SigningStatus.SIGNED) {
    throw new Error(`Recipient ${recipient.id} has already signed`);
  }

  if (field.inserted) {
    throw new Error(`Field ${fieldId} has already been inserted -- its geometry is locked`);
  }

  // Unreachable code based on the above query but we need to satisfy TypeScript
  if (field.recipientId === null) {
    throw new Error(`Field ${fieldId} has no recipientId`);
  }

  return await prisma.$transaction(async (tx) => {
    // The `field.inserted` check above is a fast-fail for the common
    // case, but it runs on a read taken BEFORE this transaction even
    // starts -- a concurrent sign-field-with-token (or the V2 equivalent,
    // envelope.field.sign) call can commit `inserted: true` in the gap
    // between that read and this write, and this mutation would never
    // know. This is exactly what let a real drag/resize race a real
    // insertion on the live P3-C envelope: the reposition's own
    // unconditional `WHERE id = ...` update happily overwrote geometry on
    // a field that had, by then, already been inserted.
    //
    // Re-reading here, inside the transaction, immediately before the
    // write, both closes that gap and gives diffFieldChanges an accurate
    // "before" snapshot for the audit log -- accurate specifically
    // because the conditional update below only succeeds if `inserted`
    // still matches what this read just saw.
    const freshField = await tx.field.findUniqueOrThrow({
      where: {
        id: field.id,
      },
    });

    // The actual guard: a single atomic UPDATE ... WHERE id = ? AND
    // inserted = false. Postgres evaluates this WHERE clause against
    // whatever is truly the current row at the moment this statement
    // executes, not the stale `field`/`freshField` reads -- if some other
    // request's insert has already committed `inserted: true` by then,
    // this matches zero rows and writes nothing, however narrow the
    // window. `tx.field.update` (singular) has no such condition and
    // would blindly overwrite the row regardless.
    const updateResult = await tx.field.updateMany({
      where: {
        id: field.id,
        inserted: false,
      },
      data: {
        positionX,
        positionY,
        width,
        height,
      },
    });

    if (updateResult.count === 0) {
      throw new Error(`Field ${fieldId} has already been inserted -- its geometry is locked`);
    }

    const updatedField = await tx.field.findUniqueOrThrow({
      where: {
        id: field.id,
      },
    });

    const changes = diffFieldChanges(freshField, updatedField);

    // No-op moves (e.g. a drag that ends where it started) produce no
    // diff -- nothing worth auditing.
    if (changes.length > 0) {
      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.FIELD_UPDATED,
          envelopeId: envelope.id,
          // Explicit user override -- attributes this to the RECIPIENT who
          // moved their own field, never to a team member (createDocumentAuditLogData
          // prioritizes this over any team-user metadata).
          user: {
            name: recipient.name,
            email: recipient.email,
          },
          requestMetadata,
          data: {
            fieldId: updatedField.secondaryId,
            fieldRecipientEmail: recipient.email,
            fieldRecipientId: recipient.id,
            fieldType: updatedField.type,
            changes,
          },
        }),
      });
    }

    return updatedField;
  });
};
