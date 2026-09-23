import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

/**
 * Browser-level coverage for the recipient-side drag/resize UI on
 * Documenso V2 (internalVersion: 2) envelopes -- the Konva-canvas signing
 * path (EnvelopeSignerPageRenderer). See envelope-signer-page-renderer.tsx
 * for the implementation: a per-field Konva.Transformer for resize, and
 * fieldGroup ITSELF (draggable, via upsertFieldGroup) for moving the
 * field -- both created only when !field.inserted && !field.fieldMeta?.readOnly,
 * calling the SAME repositionFieldWithToken mutation V1 uses.
 *
 * There is deliberately no separate drag-handle node. An earlier version
 * of this file exercised one; it was removed after a live-recipient
 * defect traced it to three coupled bugs: a local/parent Konva
 * coordinate-space mismatch in its manual drag math, its hit region
 * colliding with the Transformer's own corner anchor, and it inheriting
 * the Transformer's non-uniform scale (turning a circular grip into an
 * oval) during a resize. Field-body dragging plus Konva's native
 * click/tap-vs-drag lifecycle (suppressing click/tap once a real drag has
 * started, via Konva's own drag-distance threshold) replaces it entirely
 * -- see envelope-signer-page-renderer.tsx's own comments at the
 * `editable` flag, the `fieldGroup.on('dragend', ...)` binding, and the
 * `click tap` binding for the reasoning in each place.
 *
 * All of these fields are drawn on a <canvas> -- there is no DOM element
 * per field to locate via CSS selectors, so these tests reach into the
 * live Konva.Stage (exposed globally via `Konva.stages`, standard Konva
 * behavior, not something this app opts into specially) to read node
 * state and compute real screen coordinates, then drive genuine
 * page.mouse/page.touchscreen gestures at those coordinates -- exercising
 * the actual canvas interaction, not just the underlying mutation.
 */

/** Every FieldType currently eligible for recipient geometry editing in V2, per envelope-signer-page-renderer.tsx and envelope-signing-provider.tsx:
 *  - FREE_SIGNATURE: renderField()/render-field.ts throws for it (unsupported) -- excluded.
 *  - DATE: envelope-signing-provider.tsx's prefillField() unconditionally rewrites every
 *    not-yet-inserted DATE field to inserted:true + fieldMeta.readOnly:true on load, so
 *    isFieldEditable (!inserted && !readOnly) is always false for it -- excluded.
 *  Every other FieldType reaches the same `!inserted && !fieldMeta?.readOnly` gate with no
 *  further type-specific exclusion in the implementation, so all nine remaining types are
 *  eligible. */
const ELIGIBLE_FIELD_TYPES = [
  FieldType.SIGNATURE,
  FieldType.INITIALS,
  FieldType.NAME,
  FieldType.EMAIL,
  FieldType.TEXT,
  FieldType.NUMBER,
  FieldType.RADIO,
  FieldType.CHECKBOX,
  FieldType.DROPDOWN,
] as const;

type KonvaFieldInfo = {
  found: boolean;
  isDraggable: boolean;
  hasTransformer: boolean;
  hasDragHandleResidue: boolean;
  groupScaleX: number;
  groupScaleY: number;
  fieldScreenX: number;
  fieldScreenY: number;
  fieldScreenWidth: number;
  fieldScreenHeight: number;
  fieldCenterScreenX: number;
  fieldCenterScreenY: number;
  anchorScreenX: number;
  anchorScreenY: number;
};

/**
 * Reads the current state of one field's Konva nodes and converts every
 * position to real screen coordinates (container offset + Konva absolute
 * position), so the result can be fed straight into page.mouse/page.touchscreen.
 * Retries until the field's Konva group actually exists (a first navigation
 * can legitimately still be mounting/compiling the canvas), up to 15s, then
 * returns whatever the last attempt found -- including a legitimate
 * "not found"/"not draggable" result for callers asserting on eligibility.
 */
const getKonvaFieldInfo = async (page: Page, fieldId: number): Promise<KonvaFieldInfo> => {
  const deadline = Date.now() + 15_000;
  let lastResult: KonvaFieldInfo = await readKonvaFieldInfo(page, fieldId);

  while (!lastResult.found && Date.now() < deadline) {
    await page.waitForTimeout(300);
    lastResult = await readKonvaFieldInfo(page, fieldId);
  }

  return lastResult;
};

const readKonvaFieldInfo = async (page: Page, fieldId: number): Promise<KonvaFieldInfo> => {
  const containerBox = await page.locator('.konva-container').first().boundingBox();

  if (!containerBox) {
    throw new Error('Konva container not found');
  }

  const info = await page.evaluate(
    ({ fieldId, containerX, containerY }) => {
      // @ts-expect-error -- Konva.stages is a real global registry Konva itself maintains.
      const stages = window.Konva?.stages ?? [];

      for (const stage of stages) {
        const group = stage.findOne(`#${fieldId}`);

        if (!group) {
          continue;
        }

        // Measure '.field-rect', not the group -- matches
        // getFieldPercentageGeometry's own reasoning in
        // envelope-signer-page-renderer.tsx.
        const fieldRect = group.findOne('.field-rect');
        const groupRect = (fieldRect ?? group).getClientRect({ skipStroke: true, skipShadow: true });

        const transformers = stage
          .find('Transformer')
          .filter((t: { nodes: () => unknown[] }) => t.nodes().includes(group));

        let anchorPos = { x: 0, y: 0 };

        if (transformers.length > 0) {
          const anchor = transformers[0].findOne('.bottom-right');
          anchorPos = anchor ? anchor.getAbsolutePosition() : { x: 0, y: 0 };
        }

        return {
          found: true,
          isDraggable: group.draggable(),
          hasTransformer: transformers.length > 0,
          hasDragHandleResidue: !!group.findOne('.field-drag-handle'),
          groupScaleX: group.scaleX(),
          groupScaleY: group.scaleY(),
          fieldScreenX: containerX + groupRect.x,
          fieldScreenY: containerY + groupRect.y,
          fieldScreenWidth: groupRect.width,
          fieldScreenHeight: groupRect.height,
          fieldCenterScreenX: containerX + groupRect.x + groupRect.width / 2,
          fieldCenterScreenY: containerY + groupRect.y + groupRect.height / 2,
          anchorScreenX: containerX + anchorPos.x,
          anchorScreenY: containerY + anchorPos.y,
        };
      }

      return {
        found: false,
        isDraggable: false,
        hasTransformer: false,
        hasDragHandleResidue: false,
        groupScaleX: 1,
        groupScaleY: 1,
        fieldScreenX: 0,
        fieldScreenY: 0,
        fieldScreenWidth: 0,
        fieldScreenHeight: 0,
        fieldCenterScreenX: 0,
        fieldCenterScreenY: 0,
        anchorScreenX: 0,
        anchorScreenY: 0,
      };
    },
    { fieldId, containerX: containerBox.x, containerY: containerBox.y },
  );

  return info;
};

const trpcMutation = (request: APIRequestContext, procedure: string, input: unknown) =>
  request.post(`${NEXT_PUBLIC_WEBAPP_URL()}/api/trpc/${procedure}`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ json: input }),
  });

/** customText that satisfies every eligible field type's own render/parse requirements for a fresh, unsigned field. */
const seedCustomTextFor = (type: FieldType): string | undefined => {
  if (type === FieldType.CHECKBOX) {
    // parseCheckboxCustomText JSON.parses this -- must be valid JSON.
    return '[]';
  }

  return undefined;
};

test.describe('recipient-side field reposition/resize UI (V2 / Konva canvas)', () => {
  test('the eligible V2 Signature field is draggable and exposes a resize transformer, with no drag-handle residue', async ({
    page,
  }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['v2-affordance-signer@test.documenso.com'],
      fields: [FieldType.SIGNATURE],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    await page.goto(`/sign/${recipient.token}`);
    await page.waitForTimeout(1500);

    const info = await getKonvaFieldInfo(page, field.id);

    expect(info.found).toBe(true);
    expect(info.isDraggable).toBe(true);
    expect(info.hasTransformer).toBe(true);
    expect(info.hasDragHandleResidue).toBe(false);
  });

  test('reproduces the exact live P3-C state and exposes affordances only on the eligible Signature field', async ({
    page,
  }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['p3c-live-state-ui-v2@test.documenso.com'],
      fields: [FieldType.NAME, FieldType.SIGNATURE, FieldType.DATE],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipient] = recipients;
    const nameField = recipient.fields.find((f) => f.type === FieldType.NAME);
    const signatureField = recipient.fields.find((f) => f.type === FieldType.SIGNATURE);
    const dateField = recipient.fields.find((f) => f.type === FieldType.DATE);

    if (!nameField || !signatureField || !dateField) {
      throw new Error('Expected fields not found');
    }

    await prisma.field.update({ where: { id: nameField.id }, data: { inserted: true } });
    await prisma.field.update({
      where: { id: signatureField.id },
      data: { inserted: false, fieldMeta: { fontSize: 18, overflow: 'auto', type: 'signature' } },
    });
    await prisma.field.update({ where: { id: dateField.id }, data: { inserted: false } });

    await page.goto(`/sign/${recipient.token}`);
    await page.waitForTimeout(1500);

    const signatureInfo = await getKonvaFieldInfo(page, signatureField.id);
    expect(signatureInfo.isDraggable).toBe(true);
    expect(signatureInfo.hasTransformer).toBe(true);

    // NAME is already inserted -- locked, no affordances.
    const nameInfo = await getKonvaFieldInfo(page, nameField.id);
    expect(nameInfo.isDraggable).toBe(false);
    expect(nameInfo.hasTransformer).toBe(false);

    // DATE is auto-filled+locked client-side on load (prefillField) -- also no affordances.
    const dateInfo = await getKonvaFieldInfo(page, dateField.id);
    expect(dateInfo.isDraggable).toBe(false);
    expect(dateInfo.hasTransformer).toBe(false);
  });

  test('dragging the field body moves the field, persists the new position, and preserves width/height exactly', async ({
    page,
  }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['v2-drag-signer@test.documenso.com'],
      fields: [FieldType.SIGNATURE],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipient] = recipients;
    const field = recipient.fields[0];
    const before = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

    await page.goto(`/sign/${recipient.token}`);
    await page.waitForTimeout(1500);

    const info = await getKonvaFieldInfo(page, field.id);
    expect(info.isDraggable).toBe(true);

    // Drag the field's OWN body (its center), not a separate handle.
    await page.mouse.move(info.fieldCenterScreenX, info.fieldCenterScreenY);
    await page.mouse.down();
    await page.mouse.move(info.fieldCenterScreenX + 120, info.fieldCenterScreenY + 80, { steps: 15 });
    await page.mouse.up();

    await expect(async () => {
      const updated = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
      expect(updated.positionX.toNumber()).not.toBeCloseTo(before.positionX.toNumber());
      // A pure drag must not change size.
      expect(updated.width.toNumber()).toBeCloseTo(before.width.toNumber());
      expect(updated.height.toNumber()).toBeCloseTo(before.height.toNumber());
    }).toPass();

    // No residual transform left on the group after a clean, uninterleaved drag.
    const after = await getKonvaFieldInfo(page, field.id);
    expect(after.groupScaleX).toBeCloseTo(1);
    expect(after.groupScaleY).toBeCloseTo(1);
  });

  test('resizing via the transformer anchor changes the field size, persists it, and never moves the field body sideways', async ({
    page,
  }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['v2-resize-signer@test.documenso.com'],
      fields: [FieldType.SIGNATURE],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipient] = recipients;
    const field = recipient.fields[0];
    const before = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

    await page.goto(`/sign/${recipient.token}`);
    await page.waitForTimeout(1500);

    const info = await getKonvaFieldInfo(page, field.id);
    expect(info.hasTransformer).toBe(true);

    // Resizing from the bottom-right anchor must not move positionX/positionY at all --
    // resize changes only the dimensions permitted by the renderer, dragging changes
    // only position. Cross-contamination between the two is exactly what the removed
    // grip architecture risked.
    await page.mouse.move(info.anchorScreenX, info.anchorScreenY);
    await page.mouse.down();
    await page.mouse.move(info.anchorScreenX + 60, info.anchorScreenY + 40, { steps: 15 });
    await page.mouse.up();

    await expect(async () => {
      const updated = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
      expect(updated.width.toNumber()).toBeGreaterThan(before.width.toNumber());
      expect(updated.height.toNumber()).toBeGreaterThan(before.height.toNumber());
      expect(updated.positionX.toNumber()).toBeCloseTo(before.positionX.toNumber());
      expect(updated.positionY.toNumber()).toBeCloseTo(before.positionY.toNumber());
    }).toPass();

    // Group scale is normalized back to 1 by the post-persist re-render --
    // no residual transform survives a completed resize either.
    const after = await getKonvaFieldInfo(page, field.id);
    expect(after.groupScaleX).toBeCloseTo(1);
    expect(after.groupScaleY).toBeCloseTo(1);
  });

  test('a geometry-invalid mutation bypassing the client is rejected and leaves persisted geometry intact', async ({
    page,
    request,
  }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['v2-bypass-signer@test.documenso.com'],
      fields: [FieldType.SIGNATURE],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    await prisma.field.update({
      where: { id: field.id },
      data: { positionX: 40, positionY: 40, width: 10, height: 10 },
    });
    const before = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

    await page.goto(`/sign/${recipient.token}`);
    await page.waitForTimeout(1000);

    const response = await trpcMutation(request, 'field.repositionFieldWithToken', {
      token: recipient.token,
      fieldId: field.id,
      positionX: 90,
      positionY: 40,
      width: 25,
      height: 10,
    });

    expect(response.ok()).toBe(false);

    const after = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
    expect(after.positionX.toNumber()).toBeCloseTo(before.positionX.toNumber());
    expect(after.width.toNumber()).toBeCloseTo(before.width.toNumber());
  });

  test('once a field is inserted, it is no longer draggable and its transformer disappears', async ({ page }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['v2-locked-signer@test.documenso.com'],
      fields: [FieldType.NAME],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    await page.goto(`/sign/${recipient.token}`);
    await page.waitForTimeout(1500);

    const before = await getKonvaFieldInfo(page, field.id);
    expect(before.isDraggable).toBe(true);

    await prisma.field.update({ where: { id: field.id }, data: { inserted: true, customText: 'Inserted Name' } });
    await page.reload();
    await page.waitForTimeout(1500);

    const after = await getKonvaFieldInfo(page, field.id);
    expect(after.isDraggable).toBe(false);
    expect(after.hasTransformer).toBe(false);
  });

  test('a read-only field never exposes geometry editing', async ({ page }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['v2-readonly-signer@test.documenso.com'],
      fields: [FieldType.TEXT],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    await prisma.field.update({
      where: { id: field.id },
      data: { fieldMeta: { type: 'text', readOnly: true, text: 'Locked value' } },
    });

    await page.goto(`/sign/${recipient.token}`);
    await page.waitForTimeout(1500);

    const info = await getKonvaFieldInfo(page, field.id);
    expect(info.isDraggable).toBe(false);
    expect(info.hasTransformer).toBe(false);
  });

  test('checkbox and radio fields support both body-drag and resize on V2, and their child click targets still work with a draggable parent', async ({
    page,
  }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['v2-checkbox-signer@test.documenso.com'],
      fields: [FieldType.CHECKBOX, FieldType.RADIO],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipient] = recipients;
    const checkboxField = recipient.fields.find((f) => f.type === FieldType.CHECKBOX);
    const radioField = recipient.fields.find((f) => f.type === FieldType.RADIO);

    if (!checkboxField || !radioField) {
      throw new Error('Expected fields not found');
    }

    await prisma.field.update({ where: { id: checkboxField.id }, data: { customText: '[]' } });

    // The seed helper's deterministic layout places these two fields
    // directly touching each other. Space them apart so each field's own
    // affordances are unambiguously hit-tested.
    await prisma.field.update({ where: { id: radioField.id }, data: { positionY: 60 } });

    await page.goto(`/sign/${recipient.token}`);
    await page.waitForTimeout(1500);

    const checkboxInfo = await getKonvaFieldInfo(page, checkboxField.id);
    expect(checkboxInfo.isDraggable).toBe(true);
    expect(checkboxInfo.hasTransformer).toBe(true);

    const radioInfo = await getKonvaFieldInfo(page, radioField.id);
    expect(radioInfo.isDraggable).toBe(true);
    expect(radioInfo.hasTransformer).toBe(true);

    // Resize the checkbox field and confirm it actually persists a larger size --
    // proving V2's checkbox rendering genuinely supports resize (it re-lays-out
    // its own items on 'transform', per render-checkbox-field.ts), not just
    // that a transformer happens to be attached.
    const beforeResize = await prisma.field.findUniqueOrThrow({ where: { id: checkboxField.id } });

    await expect(async () => {
      const liveInfo = await getKonvaFieldInfo(page, checkboxField.id);

      await page.mouse.move(liveInfo.anchorScreenX, liveInfo.anchorScreenY);
      await page.mouse.down();
      await page.mouse.move(liveInfo.anchorScreenX + 50, liveInfo.anchorScreenY + 30, { steps: 15 });
      await page.mouse.up();

      const updated = await prisma.field.findUniqueOrThrow({ where: { id: checkboxField.id } });
      expect(updated.width.toNumber()).toBeGreaterThan(beforeResize.width.toNumber());
      expect(updated.height.toNumber()).toBeGreaterThan(beforeResize.height.toNumber());
    }).toPass();

    // Now drag the checkbox field's body (away from its own checkbox squares,
    // near the field's own edge but still on '.field-rect') and confirm it
    // moves, rather than toggling a checkbox value or being swallowed by a
    // child shape's own hit region.
    const beforeDrag = await prisma.field.findUniqueOrThrow({ where: { id: checkboxField.id } });

    await expect(async () => {
      const liveInfo = await getKonvaFieldInfo(page, checkboxField.id);

      await page.mouse.move(liveInfo.fieldCenterScreenX, liveInfo.fieldCenterScreenY);
      await page.mouse.down();
      await page.mouse.move(liveInfo.fieldCenterScreenX + 40, liveInfo.fieldCenterScreenY + 20, { steps: 15 });
      await page.mouse.up();

      const updated = await prisma.field.findUniqueOrThrow({ where: { id: checkboxField.id } });
      expect(updated.positionX.toNumber()).not.toBeCloseTo(beforeDrag.positionX.toNumber());
      // The drag must not have toggled the checkbox's own value.
      expect(updated.customText).toBe('[]');
    }).toPass();

    // Finally, an ordinary click directly ON one of the checkbox's own
    // child squares must still toggle it -- the parent field group being
    // draggable must not swallow or misroute that child's click.
    const checkboxChildPoint = await page.evaluate(
      ({ fieldId, containerX, containerY }) => {
        // @ts-expect-error global
        const stages = window.Konva?.stages ?? [];
        for (const stage of stages) {
          const group = stage.findOne(`#${fieldId}`);
          if (!group) {
            continue;
          }
          const items = group
            .find('Shape')
            .filter((s: { getAttr: (k: string) => unknown }) => typeof s.getAttr('internalCheckboxIndex') === 'number');
          const first = items[0];
          if (!first) {
            return null;
          }
          const pos = first.getAbsolutePosition();
          const rect = first.getClientRect({ skipStroke: true, skipShadow: true });
          return { x: containerX + rect.x + rect.width / 2, y: containerY + rect.y + rect.height / 2, foundPos: pos };
        }
        return null;
      },
      { fieldId: checkboxField.id, containerX: 0, containerY: 0 },
    );

    const container = await page.locator('.konva-container').first().boundingBox();
    if (!container) {
      throw new Error('container missing');
    }

    if (checkboxChildPoint) {
      await page.mouse.click(container.x + checkboxChildPoint.x, container.y + checkboxChildPoint.y);

      await expect(async () => {
        const updated = await prisma.field.findUniqueOrThrow({ where: { id: checkboxField.id } });
        expect(updated.customText).not.toBe('[]');
      }).toPass();
    }
  });

  test('ordinary click-to-insert/sign still works on a field with drag/resize affordances', async ({ page }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      // NAME, not DATE: envelope-signing-provider.tsx's own prefillField()
      // auto-locks DATE client-side -- see the ELIGIBLE_FIELD_TYPES comment above.
      recipients: ['v2-ordinary-signing-signer@test.documenso.com'],
      fields: [FieldType.NAME],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    await page.goto(`/sign/${recipient.token}`);
    await page.waitForTimeout(1500);

    const info = await getKonvaFieldInfo(page, field.id);
    expect(info.isDraggable).toBe(true);

    // Click the field's OWN body -- a plain click, with no movement, must
    // still trigger the ordinary NAME field click-to-insert flow even
    // though the same node is now draggable.
    await page.mouse.click(info.fieldCenterScreenX, info.fieldCenterScreenY);

    const dialog = page.getByRole('dialog');

    await dialog.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});

    if (await dialog.isVisible()) {
      await dialog.locator('input').first().fill('Ordinary Click Signer');
      await dialog.getByRole('button', { name: /sign|confirm|next|continue/i }).click();
    }

    await expect(async () => {
      const updated = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
      expect(updated.inserted).toBe(true);
    }).toPass();
  });

  test('a drag gesture never triggers signing/insertion on the field it manipulates, and a real drag suppresses the click', async ({
    page,
  }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['v2-no-accidental-insert-signer@test.documenso.com'],
      fields: [FieldType.NAME],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    await page.goto(`/sign/${recipient.token}`);
    await page.waitForTimeout(1500);

    const info = await getKonvaFieldInfo(page, field.id);

    await page.mouse.move(info.fieldCenterScreenX, info.fieldCenterScreenY);
    await page.mouse.down();
    await page.mouse.move(info.fieldCenterScreenX + 100, info.fieldCenterScreenY + 60, { steps: 15 });
    await page.mouse.up();

    // The drag itself must never insert/finalize the field it moved -- a
    // real drag exceeding Konva's own drag-distance threshold must
    // suppress the click/tap this same mouseup would otherwise fire.
    await page.waitForTimeout(500);
    const untouched = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
    expect(untouched.inserted).toBe(false);
  });

  test('touch tap still inserts/signs, matching mouse click semantics', async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true });
    const page = await context.newPage();

    try {
      const { user, team } = await seedUser();
      const { recipients, document } = await seedPendingDocumentWithFullFields({
        owner: user,
        teamId: team.id,
        recipients: ['v2-touch-tap-signer@test.documenso.com'],
        fields: [FieldType.NAME],
      });

      await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

      const [recipient] = recipients;
      const field = recipient.fields[0];

      await page.goto(`/sign/${recipient.token}`);
      await page.waitForTimeout(1500);

      const info = await getKonvaFieldInfo(page, field.id);
      expect(info.isDraggable).toBe(true);

      await page.touchscreen.tap(info.fieldCenterScreenX, info.fieldCenterScreenY);

      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});

      if (await dialog.isVisible()) {
        await dialog.locator('input').first().fill('Touch Tap Signer');
        await dialog.getByRole('button', { name: /sign|confirm|next|continue/i }).click();
      }

      await expect(async () => {
        const updated = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
        expect(updated.inserted).toBe(true);
      }).toPass();
    } finally {
      await context.close();
    }
  });

  test('persisted geometry survives a reload and remains correct after a viewport (scale) change', async ({ page }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['v2-reload-scale-signer@test.documenso.com'],
      fields: [FieldType.SIGNATURE],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipient] = recipients;
    const field = recipient.fields[0];
    const beforeDrag = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

    await page.goto(`/sign/${recipient.token}`);
    await page.waitForTimeout(1500);

    const info = await getKonvaFieldInfo(page, field.id);

    await page.mouse.move(info.fieldCenterScreenX, info.fieldCenterScreenY);
    await page.mouse.down();
    await page.mouse.move(info.fieldCenterScreenX + 90, info.fieldCenterScreenY + 50, { steps: 15 });
    await page.mouse.up();

    await expect(async () => {
      const updated = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
      expect(updated.positionX.toNumber()).not.toBeCloseTo(beforeDrag.positionX.toNumber());
    }).toPass();

    const persisted = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

    await page.reload();
    await page.waitForTimeout(1500);

    const afterReloadSameScale = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
    expect(afterReloadSameScale.positionX.toNumber()).toBeCloseTo(persisted.positionX.toNumber());
    expect(afterReloadSameScale.width.toNumber()).toBeCloseTo(persisted.width.toNumber());

    await page.setViewportSize({ width: 1000, height: 900 });
    await page.reload();
    await page.waitForTimeout(1500);

    const afterReloadAtNewScale = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

    expect(afterReloadAtNewScale.positionX.toNumber()).toBeCloseTo(persisted.positionX.toNumber());
    expect(afterReloadAtNewScale.positionY.toNumber()).toBeCloseTo(persisted.positionY.toNumber());
    expect(afterReloadAtNewScale.width.toNumber()).toBeCloseTo(persisted.width.toNumber());
    expect(afterReloadAtNewScale.height.toNumber()).toBeCloseTo(persisted.height.toNumber());

    const infoAtNewScale = await getKonvaFieldInfo(page, field.id);
    expect(infoAtNewScale.found).toBe(true);
    expect(infoAtNewScale.isDraggable).toBe(true);
  });

  test('dragging toward every page edge never persists geometry outside the page', async ({ page }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['v2-boundary-signer@test.documenso.com'],
      fields: [FieldType.SIGNATURE],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    await page.goto(`/sign/${recipient.token}`);
    await page.waitForTimeout(1500);

    for (const [dx, dy] of [
      [-2000, -2000],
      [2000, -2000],
      [-2000, 2000],
      [2000, 2000],
    ]) {
      const info = await getKonvaFieldInfo(page, field.id);

      await page.mouse.move(info.fieldCenterScreenX, info.fieldCenterScreenY);
      await page.mouse.down();
      await page.mouse.move(info.fieldCenterScreenX + dx, info.fieldCenterScreenY + dy, { steps: 20 });
      await page.mouse.up();

      await expect(async () => {
        const updated = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

        expect(updated.positionX.toNumber()).toBeGreaterThanOrEqual(-0.01);
        expect(updated.positionY.toNumber()).toBeGreaterThanOrEqual(-0.01);
        expect(updated.positionX.toNumber() + updated.width.toNumber()).toBeLessThanOrEqual(100.01);
        expect(updated.positionY.toNumber() + updated.height.toNumber()).toBeLessThanOrEqual(100.01);
      }).toPass();
    }
  });

  test('while a reposition request is in flight, dragging/resize are disabled and no second mutation is emitted, restoring only if still eligible', async ({
    page,
  }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['v2-inflight-lock-signer@test.documenso.com'],
      fields: [FieldType.SIGNATURE],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    let requestCount = 0;
    let releaseHeldRequest: (() => void) | undefined;
    const heldRequestPromise = new Promise<void>((resolve) => {
      releaseHeldRequest = resolve;
    });

    await page.route('**/api/trpc/field.repositionFieldWithToken**', async (route) => {
      requestCount += 1;
      await heldRequestPromise;
      await route.continue();
    });

    await page.goto(`/sign/${recipient.token}`);
    await page.waitForTimeout(1500);

    const info = await getKonvaFieldInfo(page, field.id);
    expect(info.isDraggable).toBe(true);
    expect(info.hasTransformer).toBe(true);

    // Start and finish a drag gesture -- this fires dragend, which calls
    // persistFieldGeometry, which locks BEFORE awaiting the (held) mutation.
    await page.mouse.move(info.fieldCenterScreenX, info.fieldCenterScreenY);
    await page.mouse.down();
    await page.mouse.move(info.fieldCenterScreenX + 50, info.fieldCenterScreenY + 30, { steps: 10 });
    await page.mouse.up();

    await expect(() => {
      expect(requestCount).toBe(1);
    }).toPass();

    // While that request is held, the field must be locked: not draggable,
    // no transformer, and attempting a second gesture must not emit a
    // second request.
    const midFlight = await getKonvaFieldInfo(page, field.id);
    expect(midFlight.isDraggable).toBe(false);
    expect(midFlight.hasTransformer).toBe(false);

    await page.mouse.move(midFlight.fieldCenterScreenX, midFlight.fieldCenterScreenY);
    await page.mouse.down();
    await page.mouse.move(midFlight.fieldCenterScreenX + 40, midFlight.fieldCenterScreenY + 20, { steps: 10 });
    await page.mouse.up();

    await page.waitForTimeout(500);
    expect(requestCount).toBe(1);

    // Release the held response and confirm interactivity returns (the
    // field remains eligible: still not inserted).
    releaseHeldRequest?.();

    await page.waitForTimeout(1000);

    const afterRelease = await getKonvaFieldInfo(page, field.id);
    expect(afterRelease.isDraggable).toBe(true);
    expect(afterRelease.hasTransformer).toBe(true);
  });

  test('a failed persistence reconciles to the last known-good geometry with no residual scale, and the field remains usable', async ({
    page,
  }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['v2-failed-persist-signer@test.documenso.com'],
      fields: [FieldType.SIGNATURE],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipient] = recipients;
    const field = recipient.fields[0];
    const original = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

    let failNextRequest = true;

    await page.route('**/api/trpc/field.repositionFieldWithToken**', async (route) => {
      if (failNextRequest) {
        failNextRequest = false;
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              error: {
                json: {
                  message: 'Forced failure for reconciliation test',
                  code: -32600,
                  data: { code: 'BAD_REQUEST', httpStatus: 400 },
                },
              },
            },
          ]),
        });
        return;
      }

      await route.continue();
    });

    await page.goto(`/sign/${recipient.token}`);
    await page.waitForTimeout(1500);

    const info = await getKonvaFieldInfo(page, field.id);

    await page.mouse.move(info.fieldCenterScreenX, info.fieldCenterScreenY);
    await page.mouse.down();
    await page.mouse.move(info.fieldCenterScreenX + 70, info.fieldCenterScreenY + 50, { steps: 12 });
    await page.mouse.up();

    await expect(async () => {
      const toastVisible = await page
        .locator("text=Could not save this field's position or size")
        .isVisible()
        .catch(() => false);
      expect(toastVisible).toBe(true);
    }).toPass();

    // Nothing was persisted.
    const afterFailure = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
    expect(afterFailure.positionX.toNumber()).toBeCloseTo(original.positionX.toNumber());
    expect(afterFailure.positionY.toNumber()).toBeCloseTo(original.positionY.toNumber());

    // The re-render after the failure leaves no residual scale on the group.
    const reconciled = await getKonvaFieldInfo(page, field.id);
    expect(reconciled.groupScaleX).toBeCloseTo(1);
    expect(reconciled.groupScaleY).toBeCloseTo(1);

    // The field remains usable: still eligible, still draggable.
    expect(reconciled.isDraggable).toBe(true);
    expect(reconciled.hasTransformer).toBe(true);

    // And a subsequent, real gesture succeeds normally.
    await page.mouse.move(reconciled.fieldCenterScreenX, reconciled.fieldCenterScreenY);
    await page.mouse.down();
    await page.mouse.move(reconciled.fieldCenterScreenX + 70, reconciled.fieldCenterScreenY + 50, { steps: 12 });
    await page.mouse.up();

    await expect(async () => {
      const updated = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
      expect(updated.positionX.toNumber()).not.toBeCloseTo(original.positionX.toNumber());
    }).toPass();
  });

  test('geometry consistency: visible, submitted, and persisted geometry agree after a drag and after a resize', async ({
    page,
  }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['v2-geometry-consistency-signer@test.documenso.com'],
      fields: [FieldType.SIGNATURE],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    let lastSubmitted: { positionX: number; positionY: number; width: number; height: number } | undefined;

    await page.route('**/api/trpc/field.repositionFieldWithToken**', async (route) => {
      const body = route.request().postDataJSON();
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const json = (body?.['0']?.json ?? body?.json) as
        | { positionX: number; positionY: number; width: number; height: number }
        | undefined;
      if (json) {
        lastSubmitted = json;
      }
      await route.continue();
    });

    await page.goto(`/sign/${recipient.token}`);
    await page.waitForTimeout(1500);

    const info = await getKonvaFieldInfo(page, field.id);

    await page.mouse.move(info.fieldCenterScreenX, info.fieldCenterScreenY);
    await page.mouse.down();
    await page.mouse.move(info.fieldCenterScreenX + 80, info.fieldCenterScreenY + 40, { steps: 12 });
    await page.mouse.up();

    await expect(async () => {
      const persisted = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
      expect(lastSubmitted).toBeDefined();
      expect(persisted.positionX.toNumber()).toBeCloseTo(lastSubmitted?.positionX ?? Number.NaN, 2);
      expect(persisted.positionY.toNumber()).toBeCloseTo(lastSubmitted?.positionY ?? Number.NaN, 2);
      expect(persisted.width.toNumber()).toBeCloseTo(lastSubmitted?.width ?? Number.NaN, 2);
      expect(persisted.height.toNumber()).toBeCloseTo(lastSubmitted?.height ?? Number.NaN, 2);
    }).toPass();

    const afterDrag = await getKonvaFieldInfo(page, field.id);
    const widthBeforeResize = (await prisma.field.findUniqueOrThrow({ where: { id: field.id } })).width.toNumber();

    await page.mouse.move(afterDrag.anchorScreenX, afterDrag.anchorScreenY);
    await page.mouse.down();
    await page.mouse.move(afterDrag.anchorScreenX + 40, afterDrag.anchorScreenY + 30, { steps: 12 });
    await page.mouse.up();

    await expect(async () => {
      const persisted = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
      // Guard against reading a stale `lastSubmitted` (the drag step's own
      // submission) before the resize's own request has actually landed --
      // require the width to have genuinely grown past its pre-resize
      // value before trusting the submitted/persisted comparison below.
      expect(persisted.width.toNumber()).toBeGreaterThan(widthBeforeResize);
      expect(lastSubmitted).toBeDefined();
      expect(persisted.width.toNumber()).toBeCloseTo(lastSubmitted?.width ?? Number.NaN, 2);
      expect(persisted.height.toNumber()).toBeCloseTo(lastSubmitted?.height ?? Number.NaN, 2);
    }).toPass();

    const persistedFinal = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

    await page.reload();
    await page.waitForTimeout(1500);

    const afterReload = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
    expect(afterReload.positionX.toNumber()).toBeCloseTo(persistedFinal.positionX.toNumber());
    expect(afterReload.width.toNumber()).toBeCloseTo(persistedFinal.width.toNumber());
    expect(afterReload.height.toNumber()).toBeCloseTo(persistedFinal.height.toNumber());
  });

  test('every currently eligible V2 field type is draggable, resizable, and a body drag preserves width/height', async ({
    page,
  }) => {
    for (const type of ELIGIBLE_FIELD_TYPES) {
      const { user, team } = await seedUser();
      const { recipients, document } = await seedPendingDocumentWithFullFields({
        owner: user,
        teamId: team.id,
        recipients: [`v2-eligible-${type.toLowerCase()}-signer@test.documenso.com`],
        fields: [type],
      });

      await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

      const [recipient] = recipients;
      const field = recipient.fields[0];

      const customText = seedCustomTextFor(type);
      if (customText !== undefined) {
        await prisma.field.update({ where: { id: field.id }, data: { customText } });
      }

      const before = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

      await page.goto(`/sign/${recipient.token}`);
      await page.waitForTimeout(1500);

      const info = await getKonvaFieldInfo(page, field.id);
      expect(info.found, `${type}: field not found`).toBe(true);
      expect(info.isDraggable, `${type}: expected draggable`).toBe(true);
      expect(info.hasTransformer, `${type}: expected transformer`).toBe(true);

      await page.mouse.move(info.fieldCenterScreenX, info.fieldCenterScreenY);
      await page.mouse.down();
      await page.mouse.move(info.fieldCenterScreenX + 60, info.fieldCenterScreenY + 40, { steps: 12 });
      await page.mouse.up();

      await expect(async () => {
        const updated = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
        expect(updated.positionX.toNumber(), `${type}: position should change`).not.toBeCloseTo(
          before.positionX.toNumber(),
        );
        expect(updated.width.toNumber(), `${type}: width must be preserved`).toBeCloseTo(before.width.toNumber());
        expect(updated.height.toNumber(), `${type}: height must be preserved`).toBeCloseTo(before.height.toNumber());
        expect(updated.inserted, `${type}: a drag must not insert/sign`).toBe(false);
      }).toPass();
    }
  });
});

/**
 * Permanent regression coverage for the mounted-page state transition
 * (inserted:false -> insertion in flight -> inserted:true) implicated in
 * the live P3-C incident: the field's geometry controls used to stay
 * interactive for the full round-trip of an insertion request, leaving a
 * real window where a drag/resize could be initiated (and, without the
 * server-side fix, land) on a field that was, by then, already inserted.
 * envelope-signer-page-renderer.tsx's signField tears down geometry
 * controls immediately (before the network request, via
 * lockFieldGeometryEditing -- which now also disables fieldGroup's own
 * native dragging, not just the Transformer), and restores them only if
 * the attempt does not result in field.inserted becoming true.
 *
 * The network response is held via page.route() so the "in flight" state
 * can be observed deterministically rather than hoping to catch a
 * normally-fast round-trip mid-flight.
 */
test.describe('V2 mounted-page transition: inserted:false -> insertion in flight -> inserted:true', () => {
  test('geometry controls disappear the instant insertion begins, stay gone after it succeeds, and agree with a refresh', async ({
    page,
  }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['v2-transition-success-signer@test.documenso.com'],
      fields: [FieldType.NAME],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    let releaseSignResponse: (() => void) | undefined;
    let signRequestSeen = false;

    await page.route('**/api/trpc/envelope.field.sign*', async (route) => {
      signRequestSeen = true;
      await new Promise<void>((resolve) => {
        releaseSignResponse = resolve;
      });
      await route.continue();
    });

    await page.goto(`/sign/${recipient.token}`);
    await page.waitForTimeout(1500);

    const before = await getKonvaFieldInfo(page, field.id);
    expect(before.isDraggable).toBe(true);
    expect(before.hasTransformer).toBe(true);

    await page.mouse.click(before.fieldCenterScreenX, before.fieldCenterScreenY);

    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});

    if (await dialog.isVisible()) {
      await dialog.locator('input').first().fill('Transition Test Signer');
      await dialog.getByRole('button', { name: /sign|confirm|next|continue/i }).click();
    }

    // The request is now held by the route handler -- wait for it to
    // actually have been issued before checking the "in flight" state.
    await expect(() => {
      expect(signRequestSeen).toBe(true);
    }).toPass({ timeout: 5000 });

    const duringInsert = await getKonvaFieldInfo(page, field.id);
    expect(duringInsert.isDraggable).toBe(false);
    expect(duringInsert.hasTransformer).toBe(false);

    // Confirm the field genuinely has not been persisted as inserted yet
    // -- this is checking the state DURING the held request, not after.
    const midFlight = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
    expect(midFlight.inserted).toBe(false);

    // Drag cannot race insertion through the UI: with dragging disabled
    // during the held request, attempting a drag right now must not move
    // the field at all.
    await page.mouse.move(duringInsert.fieldCenterScreenX, duringInsert.fieldCenterScreenY);
    await page.mouse.down();
    await page.mouse.move(duringInsert.fieldCenterScreenX + 60, duringInsert.fieldCenterScreenY + 40, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const stillMidFlight = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
    expect(stillMidFlight.positionX.toNumber()).toBeCloseTo(midFlight.positionX.toNumber());

    releaseSignResponse?.();

    await expect(async () => {
      const updated = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
      expect(updated.inserted).toBe(true);
    }).toPass();

    const afterInsert = await getKonvaFieldInfo(page, field.id);
    expect(afterInsert.isDraggable).toBe(false);
    expect(afterInsert.hasTransformer).toBe(false);

    await page.unroute('**/api/trpc/envelope.field.sign*');
    await page.reload();
    await page.waitForTimeout(1500);

    const afterReload = await getKonvaFieldInfo(page, field.id);
    expect(afterReload.isDraggable).toBe(false);
    expect(afterReload.hasTransformer).toBe(false);
  });

  test('a failed insertion restores geometry editing', async ({ page }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['v2-transition-failure-signer@test.documenso.com'],
      fields: [FieldType.NAME],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    await page.route('**/api/trpc/envelope.field.sign*', async (route) => {
      // Simulate a failed insertion attempt (network/server error) rather
      // than letting the real mutation run.
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify([{ error: { json: { message: 'Simulated failure', code: -32603 } } }]),
      });
    });

    await page.goto(`/sign/${recipient.token}`);
    await page.waitForTimeout(1500);

    const before = await getKonvaFieldInfo(page, field.id);
    expect(before.isDraggable).toBe(true);

    await page.mouse.click(before.fieldCenterScreenX, before.fieldCenterScreenY);

    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});

    if (await dialog.isVisible()) {
      await dialog.locator('input').first().fill('Transition Failure Signer');
      await dialog.getByRole('button', { name: /sign|confirm|next|continue/i }).click();
    }

    // The simulated failure must not have persisted anything.
    await expect(async () => {
      const stillUninserted = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
      expect(stillUninserted.inserted).toBe(false);
    }).toPass();

    // And geometry editing must have come back, not stayed locked from
    // the failed attempt.
    await expect(async () => {
      const restored = await getKonvaFieldInfo(page, field.id);
      expect(restored.isDraggable).toBe(true);
      expect(restored.hasTransformer).toBe(true);
    }).toPass();

    await page.unroute('**/api/trpc/envelope.field.sign*');
  });
});
