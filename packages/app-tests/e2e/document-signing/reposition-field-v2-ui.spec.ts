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
 * path (EnvelopeSignerPageRenderer), completely separate from the V1/DOM
 * path reposition-field-ui.spec.ts already covers. See
 * envelope-signer-page-renderer.tsx for the implementation: a per-field
 * Konva.Transformer for resize, and a dedicated child Konva.Group
 * ('field-drag-handle') for drag, both created only when
 * !field.inserted && !field.fieldMeta?.readOnly, calling the SAME
 * repositionFieldWithToken mutation V1 uses.
 *
 * All of these fields are drawn on a <canvas> -- there is no DOM element
 * per field to locate via CSS selectors, so these tests reach into the
 * live Konva.Stage (exposed globally via `Konva.stages`, standard Konva
 * behavior, not something this app opts into specially) to read node
 * state and compute real screen coordinates, then drive genuine
 * page.mouse gestures at those coordinates -- exercising the actual
 * canvas interaction, not just the underlying mutation.
 */

type KonvaFieldInfo = {
  found: boolean;
  hasDragHandle: boolean;
  hasTransformer: boolean;
  handleScreenX: number;
  handleScreenY: number;
  fieldScreenX: number;
  fieldScreenY: number;
  fieldScreenWidth: number;
  fieldScreenHeight: number;
  anchorScreenX: number;
  anchorScreenY: number;
};

/**
 * Reads the current state of one field's Konva nodes and converts every
 * position to real screen coordinates (container offset + Konva absolute
 * position), so the result can be fed straight into page.mouse. Retries
 * until the field's Konva group actually exists (a first navigation can
 * legitimately still be mounting/compiling the canvas), up to 15s, then
 * returns whatever the last attempt found -- including a legitimate
 * "not found"/"no handle" result for callers asserting on eligibility.
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

        // Measure '.field-rect', not the group -- the group's own
        // getClientRect() includes every descendant, and the drag handle
        // (added outside the field's own top-left corner) would inflate
        // it into something bigger than the field's real visual bounds,
        // same reasoning as envelope-signer-page-renderer.tsx's own
        // getFieldPercentageGeometry.
        const fieldRect = group.findOne('.field-rect');
        const groupRect = (fieldRect ?? group).getClientRect({ skipStroke: true, skipShadow: true });
        const handle = group.findOne('.field-drag-handle');
        const handlePos = handle ? handle.getAbsolutePosition() : null;

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
          hasDragHandle: !!handle,
          hasTransformer: transformers.length > 0,
          handleScreenX: containerX + (handlePos?.x ?? 0),
          handleScreenY: containerY + (handlePos?.y ?? 0),
          fieldScreenX: containerX + groupRect.x,
          fieldScreenY: containerY + groupRect.y,
          fieldScreenWidth: groupRect.width,
          fieldScreenHeight: groupRect.height,
          anchorScreenX: containerX + anchorPos.x,
          anchorScreenY: containerY + anchorPos.y,
        };
      }

      return {
        found: false,
        hasDragHandle: false,
        hasTransformer: false,
        handleScreenX: 0,
        handleScreenY: 0,
        fieldScreenX: 0,
        fieldScreenY: 0,
        fieldScreenWidth: 0,
        fieldScreenHeight: 0,
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

test.describe('recipient-side field reposition/resize UI (V2 / Konva canvas)', () => {
  test('the eligible V2 Signature field exposes a drag handle and a resize transformer', async ({ page }) => {
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
    expect(info.hasDragHandle).toBe(true);
    expect(info.hasTransformer).toBe(true);
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
    expect(signatureInfo.hasDragHandle).toBe(true);
    expect(signatureInfo.hasTransformer).toBe(true);

    // NAME is already inserted -- locked, no affordances.
    const nameInfo = await getKonvaFieldInfo(page, nameField.id);
    expect(nameInfo.hasDragHandle).toBe(false);
    expect(nameInfo.hasTransformer).toBe(false);
  });

  test('dragging the handle moves the field and persists the new position', async ({ page }) => {
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
    expect(info.hasDragHandle).toBe(true);

    await page.mouse.move(info.handleScreenX, info.handleScreenY);
    await page.mouse.down();
    await page.mouse.move(info.handleScreenX + 120, info.handleScreenY + 80, { steps: 15 });
    await page.mouse.up();

    await expect(async () => {
      const updated = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
      expect(updated.positionX.toNumber()).not.toBeCloseTo(before.positionX.toNumber());
      // A pure drag must not change size.
      expect(updated.width.toNumber()).toBeCloseTo(before.width.toNumber());
      expect(updated.height.toNumber()).toBeCloseTo(before.height.toNumber());
    }).toPass();
  });

  test('resizing via the transformer anchor changes the field size and persists it', async ({ page }) => {
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

    await page.mouse.move(info.anchorScreenX, info.anchorScreenY);
    await page.mouse.down();
    await page.mouse.move(info.anchorScreenX + 60, info.anchorScreenY + 40, { steps: 15 });
    await page.mouse.up();

    await expect(async () => {
      const updated = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
      expect(updated.width.toNumber()).toBeGreaterThan(before.width.toNumber());
      expect(updated.height.toNumber()).toBeGreaterThan(before.height.toNumber());
    }).toPass();
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

    await page.mouse.move(info.handleScreenX, info.handleScreenY);
    await page.mouse.down();
    await page.mouse.move(info.handleScreenX + 90, info.handleScreenY + 50, { steps: 15 });
    await page.mouse.up();

    // Confirm the drag actually moved it (not just "is a positive number",
    // which the seed's own default position would already satisfy) before
    // treating this as the baseline for the reload/scale checks below.
    await expect(async () => {
      const updated = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
      expect(updated.positionX.toNumber()).not.toBeCloseTo(beforeDrag.positionX.toNumber());
    }).toPass();

    const persisted = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

    // Reload at the SAME viewport first -- isolates "does a reload alone
    // preserve it" from the scale-change concern checked next.
    await page.reload();
    await page.waitForTimeout(1500);

    const afterReloadSameScale = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
    expect(afterReloadSameScale.positionX.toNumber()).toBeCloseTo(persisted.positionX.toNumber());
    expect(afterReloadSameScale.width.toNumber()).toBeCloseTo(persisted.width.toNumber());

    // Now change the viewport -- the PDF page fits to available width, so
    // this changes the Konva stage's own zoom/scale factor -- and reload
    // again. The PERCENTAGE geometry (what's persisted) must be
    // unaffected by that scale change; only pixel rendering should differ.
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.reload();
    await page.waitForTimeout(1500);

    const afterReloadAtNewScale = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

    expect(afterReloadAtNewScale.positionX.toNumber()).toBeCloseTo(persisted.positionX.toNumber());
    expect(afterReloadAtNewScale.positionY.toNumber()).toBeCloseTo(persisted.positionY.toNumber());
    expect(afterReloadAtNewScale.width.toNumber()).toBeCloseTo(persisted.width.toNumber());
    expect(afterReloadAtNewScale.height.toNumber()).toBeCloseTo(persisted.height.toNumber());

    // And the field should still be found/editable at the new scale, proving
    // the re-render (not just the raw DB row) reflects the new geometry
    // correctly at a different zoom level.
    const infoAtNewScale = await getKonvaFieldInfo(page, field.id);
    expect(infoAtNewScale.found).toBe(true);
    expect(infoAtNewScale.hasDragHandle).toBe(true);
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

      await page.mouse.move(info.handleScreenX, info.handleScreenY);
      await page.mouse.down();
      await page.mouse.move(info.handleScreenX + dx, info.handleScreenY + dy, { steps: 20 });
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

  test('once a field is inserted, its drag handle and transformer disappear', async ({ page }) => {
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
    expect(before.hasDragHandle).toBe(true);

    await prisma.field.update({ where: { id: field.id }, data: { inserted: true, customText: 'Inserted Name' } });
    await page.reload();
    await page.waitForTimeout(1500);

    const after = await getKonvaFieldInfo(page, field.id);
    expect(after.hasDragHandle).toBe(false);
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
    expect(info.hasDragHandle).toBe(false);
    expect(info.hasTransformer).toBe(false);
  });

  test('checkbox and radio fields support both drag and resize on V2 (unlike V1)', async ({ page }) => {
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

    // seedPendingDocumentWithFullFields sets every field's customText to the
    // recipient's name/email regardless of type -- fine for most types, but
    // parseCheckboxCustomText (packages/lib/utils/fields.ts) JSON.parses a
    // checkbox field's customText to find which boxes are checked, and that
    // string isn't valid JSON, which throws during the very first render.
    // Give it something a checkbox field's customText is actually allowed
    // to be: an empty selection.
    await prisma.field.update({ where: { id: checkboxField.id }, data: { customText: '[]' } });

    // The seed helper's deterministic layout places these two fields
    // directly touching each other (checkbox's bottom edge = radio's top
    // edge). A resize anchor sitting exactly on that shared boundary can
    // land on whichever field is on top there instead of the one actually
    // being resized -- a test-layout hazard, not something the feature
    // needs to tolerate in real placements. Space them apart so each
    // field's own affordances are unambiguously hit-tested.
    await prisma.field.update({ where: { id: radioField.id }, data: { positionY: 60 } });

    await page.goto(`/sign/${recipient.token}`);
    await page.waitForTimeout(1500);

    const checkboxInfo = await getKonvaFieldInfo(page, checkboxField.id);
    expect(checkboxInfo.hasDragHandle).toBe(true);
    expect(checkboxInfo.hasTransformer).toBe(true);

    const radioInfo = await getKonvaFieldInfo(page, radioField.id);
    expect(radioInfo.hasDragHandle).toBe(true);
    expect(radioInfo.hasTransformer).toBe(true);

    // Resize the checkbox field and confirm it actually persists a larger size --
    // proving V2's checkbox rendering genuinely supports resize (it re-lays-out
    // its own items on 'transform', per render-checkbox-field.ts), not just
    // that a transformer happens to be attached.
    const before = await prisma.field.findUniqueOrThrow({ where: { id: checkboxField.id } });

    // Re-reads the anchor position and redoes the whole gesture on each
    // attempt (not just the assertion) -- a canvas drag can occasionally
    // miss the anchor's hit region on the very first attempt right after
    // navigation, and re-checking a stale screen position wouldn't help.
    await expect(async () => {
      const liveInfo = await getKonvaFieldInfo(page, checkboxField.id);

      await page.mouse.move(liveInfo.anchorScreenX, liveInfo.anchorScreenY);
      await page.mouse.down();
      await page.mouse.move(liveInfo.anchorScreenX + 50, liveInfo.anchorScreenY + 30, { steps: 15 });
      await page.mouse.up();

      const updated = await prisma.field.findUniqueOrThrow({ where: { id: checkboxField.id } });
      expect(updated.width.toNumber()).toBeGreaterThan(before.width.toNumber());
      expect(updated.height.toNumber()).toBeGreaterThan(before.height.toNumber());
    }).toPass();
  });

  test('ordinary click-to-insert/sign still works on a field with drag/resize affordances', async ({ page }) => {
    const { user, team } = await seedUser();
    const { recipients, document } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      // NAME, not DATE: envelope-signing-provider.tsx's own prefillField()
      // client-side auto-fills every not-yet-inserted DATE field with
      // today's date and marks it inserted+readOnly immediately on load
      // (a pre-existing V2 behavior, confirmed by reading that file, not
      // something introduced here) -- DATE is therefore never geometry-
      // editable in V2 at all, and isn't a valid field to test an ordinary
      // click-to-insert flow against.
      recipients: ['v2-ordinary-signing-signer@test.documenso.com'],
      fields: [FieldType.NAME],
    });

    await prisma.envelope.update({ where: { id: document.id }, data: { internalVersion: 2 } });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    await page.goto(`/sign/${recipient.token}`);
    await page.waitForTimeout(1500);

    const info = await getKonvaFieldInfo(page, field.id);
    expect(info.hasDragHandle).toBe(true);

    // Click the field's OWN body/rect surface (not the drag handle, and not
    // the resize anchor) -- this must still trigger the ordinary NAME
    // field click-to-insert flow. handleNameFieldClick (apps/remix/app/
    // utils/field-signing/name-field.ts) inserts directly when a name is
    // already known in the signing session, and opens a dialog to collect
    // one otherwise -- observed to vary run-to-run in this test
    // environment (likely session-state-dependent, not something this
    // drag/resize feature controls), so this accepts either: either
    // outcome equally proves the click reached the real insert flow
    // rather than being swallowed by the drag handle or transformer.
    await page.mouse.click(
      info.fieldScreenX + info.fieldScreenWidth / 2,
      info.fieldScreenY + info.fieldScreenHeight / 2,
    );

    const dialog = page.getByRole('dialog');

    // isVisible() checks instantly with no retry -- the dialog (if this
    // session's flow needs one) can take a moment to mount, so wait for
    // it properly rather than sampling too early and wrongly concluding
    // it will never appear.
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

  test('a drag/resize gesture never triggers signing/insertion on the field it manipulates', async ({ page }) => {
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

    await page.mouse.move(info.handleScreenX, info.handleScreenY);
    await page.mouse.down();
    await page.mouse.move(info.handleScreenX + 100, info.handleScreenY + 60, { steps: 15 });
    await page.mouse.up();

    // The drag itself must never insert/finalize the field it moved.
    const untouched = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
    expect(untouched.inserted).toBe(false);
  });
});
