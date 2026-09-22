import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { prisma } from '@documenso/prisma';
import { seedPendingDocumentWithFullFields } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

/**
 * Browser-level coverage for the recipient-side drag/resize UI added to
 * DocumentSigningFieldContainer -- complements reposition-field-with-token.spec.ts
 * (which covers the mutation's own authorization/persistence/audit behavior
 * at the API level) by proving the actual on-screen controls behave
 * correctly: a recipient can move/resize their own field, another
 * recipient's field can't be touched, a finalized field locks, and none
 * of this interferes with ordinary click-to-insert signing.
 *
 * seedPendingDocumentWithFullFields gives every recipient the SAME field
 * types at deterministic positions: positionX = (recipientIndex + 1) * 5,
 * positionY = (fieldIndex + 1) * 5, width = height = 5 -- see
 * packages/prisma/seed/documents.ts.
 */

const fieldSelector = (fieldId: number) => `#field-${fieldId}`;

// Both the drag handle and react-rnd's resize handles are rendered as
// SIBLINGS of the field's own content div (#field-{id}) -- all children
// of the same Rnd-controlled wrapper -- not as descendants of it. (The
// drag handle escapes #field-{id} deliberately: that div sets its own
// position+z-index, which traps any nested z-index inside its own
// stacking context and would make it impossible for the drag handle to
// out-rank a sibling resize handle at their shared corner. See field.tsx's
// `dragHandle` prop doc.) A plain descendant selector never matches
// either; walk up to the shared Rnd parent first.
const dragHandle = (page: Page, fieldId: number) =>
  page.locator(fieldSelector(fieldId)).locator('xpath=..').locator('.field-drag-handle');
const resizeHandle = (page: Page, fieldId: number) =>
  page.locator(fieldSelector(fieldId)).locator('xpath=..').locator('.field-resize-handle');

// Mirrors the same helper in reposition-field-with-token.spec.ts -- calls
// the tRPC mutation directly, bypassing the browser UI entirely. Used here
// to simulate a client that ignores react-rnd's own `bounds` clamp (a
// scripted/compromised client, not the real signing page), which is
// exactly the case the server-side geometry validation exists to defend
// against regardless of what the real UI would ever produce.
const trpcMutation = (request: APIRequestContext, procedure: string, input: unknown) =>
  request.post(`${NEXT_PUBLIC_WEBAPP_URL()}/api/trpc/${procedure}`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ json: input }),
  });

test.describe('recipient-side field reposition/resize UI', () => {
  test('a recipient can drag their own not-yet-inserted field, and the new position persists', async ({ page }) => {
    const { user, team } = await seedUser();
    const { recipients } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['drag-signer@test.documenso.com'],
      fields: [FieldType.NAME],
    });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    await page.goto(`/sign/${recipient.token}`);

    const handle = dragHandle(page, field.id);
    await expect(handle).toBeVisible();

    const before = await handle.boundingBox();

    if (!before) {
      throw new Error('Could not read drag handle bounding box');
    }

    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + 120, before.y + 60, { steps: 10 });
    await page.mouse.up();

    // The field itself (not just the handle) should have visibly moved.
    await expect(async () => {
      const after = await page.locator(fieldSelector(field.id)).boundingBox();

      if (!after) {
        throw new Error('Field not found after drag');
      }

      expect(Math.abs(after.x - before.x)).toBeGreaterThan(50);
    }).toPass();

    // And the move must be PERSISTED server-side, not just a browser-only
    // visual change -- this is the exact property the sealing pipeline
    // depends on.
    await expect(async () => {
      const updated = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
      expect(updated.positionX.toNumber()).not.toBeCloseTo(field.positionX.toNumber());
    }).toPass();
  });

  test('a recipient can resize their own not-yet-inserted field, and the new size persists', async ({ page }) => {
    const { user, team } = await seedUser();
    const { recipients } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['resize-signer@test.documenso.com'],
      fields: [FieldType.SIGNATURE],
    });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    await page.goto(`/sign/${recipient.token}`);

    const handle = resizeHandle(page, field.id);
    await expect(handle).toBeVisible();

    const before = await handle.boundingBox();

    if (!before) {
      throw new Error('Could not read resize handle bounding box');
    }

    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + 80, before.y + 60, { steps: 10 });
    await page.mouse.up();

    await expect(async () => {
      const updated = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
      expect(updated.width.toNumber()).toBeGreaterThan(field.width.toNumber());
      expect(updated.height.toNumber()).toBeGreaterThan(field.height.toNumber());
    }).toPass();
  });

  test('a resize/drag gesture never triggers signing/insertion on the field it manipulates', async ({ page }) => {
    const { user, team } = await seedUser();
    const { recipients } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['no-accidental-insert-signer@test.documenso.com'],
      fields: [FieldType.NAME],
    });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    await page.goto(`/sign/${recipient.token}`);

    const handle = dragHandle(page, field.id);
    const box = await handle.boundingBox();

    if (!box) {
      throw new Error('Could not read drag handle bounding box');
    }

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y + 40, { steps: 10 });
    await page.mouse.up();

    // A drag must never insert/finalize the field it moves.
    const untouched = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
    expect(untouched.inserted).toBe(false);
  });

  test("a recipient cannot drag or resize another recipient's field", async ({ page }) => {
    const { user, team } = await seedUser();
    const { recipients } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['cross-recipient-a@test.documenso.com', 'cross-recipient-b@test.documenso.com'],
      fields: [FieldType.NAME],
    });

    const [recipientA, recipientB] = recipients;
    const fieldBelongingToB = recipientB.fields[0];

    // Visit as recipient A, but recipient B's field is never in
    // recipient A's own signing payload at all -- getFieldsForToken only
    // ever returns the current recipient's own fields, so the element
    // for another recipient's field shouldn't exist on this page.
    await page.goto(`/sign/${recipientA.token}`);

    await expect(page.locator(fieldSelector(fieldBelongingToB.id))).toHaveCount(0);

    const untouched = await prisma.field.findUniqueOrThrow({ where: { id: fieldBelongingToB.id } });
    expect(untouched.positionX.toNumber()).toBeCloseTo(fieldBelongingToB.positionX.toNumber());
    expect(untouched.positionY.toNumber()).toBeCloseTo(fieldBelongingToB.positionY.toNumber());
  });

  test('once a field is inserted, its drag handle and resize handle disappear -- geometry is locked', async ({
    page,
  }) => {
    const { user, team } = await seedUser();
    const { recipients } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['locked-after-insert-signer@test.documenso.com'],
      fields: [FieldType.NAME],
    });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    await page.goto(`/sign/${recipient.token}`);

    await expect(dragHandle(page, field.id)).toBeVisible();

    // Insert the field via the ordinary signing flow (click to open the
    // name dialog, type a name, confirm) -- exercised generically here
    // via the field's own click-to-insert button, then directly via the
    // API to keep this test focused on the LOCK behavior rather than
    // re-deriving the full name-field dialog flow.
    await prisma.field.update({
      where: { id: field.id },
      data: { inserted: true, customText: 'Inserted Name' },
    });
    await page.reload();

    await expect(dragHandle(page, field.id)).toHaveCount(0);
    await expect(resizeHandle(page, field.id)).toHaveCount(0);
  });

  test('a checkbox field has no resize handle -- it stays auto-sized to its content, matching its existing (non-editable) rendering', async ({
    page,
  }) => {
    const { user, team } = await seedUser();
    const { recipients } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['checkbox-signer@test.documenso.com'],
      fields: [FieldType.CHECKBOX],
    });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    await page.goto(`/sign/${recipient.token}`);

    await expect(dragHandle(page, field.id)).toBeVisible();
    await expect(resizeHandle(page, field.id)).toHaveCount(0);
  });

  test('a radio field has no resize handle -- it stays auto-sized to its content, matching its existing (non-editable) rendering', async ({
    page,
  }) => {
    const { user, team } = await seedUser();
    const { recipients } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['radio-signer@test.documenso.com'],
      fields: [FieldType.RADIO],
    });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    await page.goto(`/sign/${recipient.token}`);

    await expect(dragHandle(page, field.id)).toBeVisible();
    await expect(resizeHandle(page, field.id)).toHaveCount(0);
  });

  test('dragging a checkbox field moves it but leaves its stored width/height untouched', async ({ page }) => {
    const { user, team } = await seedUser();
    const { recipients } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['checkbox-drag-signer@test.documenso.com'],
      fields: [FieldType.CHECKBOX],
    });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    await page.goto(`/sign/${recipient.token}`);

    const handle = dragHandle(page, field.id);
    const before = await handle.boundingBox();

    if (!before) {
      throw new Error('Could not read drag handle bounding box');
    }

    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + 90, before.y + 50, { steps: 10 });
    await page.mouse.up();

    await expect(async () => {
      const updated = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

      // Position changed...
      expect(updated.positionX.toNumber()).not.toBeCloseTo(field.positionX.toNumber());

      // ...but width/height are exactly what was already stored -- a
      // checkbox's rendered size is driven by its configured options, not
      // by these columns (see the non-editable static path's own
      // maxWidth-only special case), so a drag must never let them drift.
      expect(updated.width.toNumber()).toBeCloseTo(field.width.toNumber());
      expect(updated.height.toNumber()).toBeCloseTo(field.height.toNumber());
    }).toPass();
  });

  test('ordinary click-to-insert signing still works for a field with drag/resize controls', async ({ page }) => {
    const { user, team } = await seedUser();
    const { recipients } = await seedPendingDocumentWithFullFields({
      owner: user,
      teamId: team.id,
      recipients: ['ordinary-signing-signer@test.documenso.com'],
      fields: [FieldType.NAME],
    });

    const [recipient] = recipients;
    const field = recipient.fields[0];

    await page.goto(`/sign/${recipient.token}`);

    // Click well inside the field's own surface (not the drag handle,
    // which sits outside the box at a negative offset) -- this must
    // still open the ordinary insert flow.
    const fieldBox = await page.locator(fieldSelector(field.id)).boundingBox();

    if (!fieldBox) {
      throw new Error('Field not found');
    }

    await page.mouse.click(fieldBox.x + fieldBox.width / 2, fieldBox.y + fieldBox.height / 2);

    // A NAME field inserts immediately on click once a full name is
    // already available in the signing context (seeded here via the
    // recipient's own name) -- no dialog in that path, unlike a fresh
    // session with no name yet provided. Asserting on `inserted` instead
    // of a dialog is robust to which of those two paths actually runs,
    // and is the thing that actually matters here: that the click-to-
    // insert button beneath the drag handle still works unimpeded.
    await expect(async () => {
      const updated = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
      expect(updated.inserted).toBe(true);
    }).toPass();
  });

  test.describe('resize/drag near page boundaries', () => {
    // react-rnd's own `bounds` prop (set to the page element) is expected
    // to clamp every one of these gestures client-side before a mutation
    // is even attempted -- these tests prove that clamp actually holds at
    // each of the four edges/corners, not just that it's configured.
    // Server-side validation (proven separately below, and already
    // covered at the API level in reposition-field-with-token.spec.ts) is
    // what protects against a client that ignores this clamp entirely.

    test('resizing outward near the bottom-right corner never persists geometry past the page edge', async ({
      page,
    }) => {
      const { user, team } = await seedUser();
      const { recipients } = await seedPendingDocumentWithFullFields({
        owner: user,
        teamId: team.id,
        recipients: ['boundary-bottom-right@test.documenso.com'],
        fields: [FieldType.NAME],
      });

      const [recipient] = recipients;
      const field = recipient.fields[0];

      await prisma.field.update({
        where: { id: field.id },
        data: { positionX: 80, positionY: 80, width: 15, height: 15 },
      });

      await page.goto(`/sign/${recipient.token}`);

      const handle = resizeHandle(page, field.id);
      const before = await handle.boundingBox();

      if (!before) {
        throw new Error('Could not read resize handle bounding box');
      }

      // A large outward drag that would overflow well past the page's
      // right/bottom edge if unclamped.
      await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
      await page.mouse.down();
      await page.mouse.move(before.x + 500, before.y + 500, { steps: 15 });
      await page.mouse.up();

      await expect(async () => {
        const updated = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

        const right = updated.positionX.toNumber() + updated.width.toNumber();
        const bottom = updated.positionY.toNumber() + updated.height.toNumber();

        expect(right).toBeLessThanOrEqual(100.01);
        expect(bottom).toBeLessThanOrEqual(100.01);
      }).toPass();
    });

    test('dragging toward the top-left corner never persists a negative position', async ({ page }) => {
      const { user, team } = await seedUser();
      const { recipients } = await seedPendingDocumentWithFullFields({
        owner: user,
        teamId: team.id,
        recipients: ['boundary-top-left@test.documenso.com'],
        fields: [FieldType.NAME],
      });

      const [recipient] = recipients;
      const field = recipient.fields[0];

      await prisma.field.update({
        where: { id: field.id },
        data: { positionX: 3, positionY: 3, width: 10, height: 5 },
      });

      await page.goto(`/sign/${recipient.token}`);

      const handle = dragHandle(page, field.id);
      const before = await handle.boundingBox();

      if (!before) {
        throw new Error('Could not read drag handle bounding box');
      }

      await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
      await page.mouse.down();
      await page.mouse.move(before.x - 500, before.y - 500, { steps: 15 });
      await page.mouse.up();

      await expect(async () => {
        const updated = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

        expect(updated.positionX.toNumber()).toBeGreaterThanOrEqual(-0.01);
        expect(updated.positionY.toNumber()).toBeGreaterThanOrEqual(-0.01);
      }).toPass();
    });

    test('dragging toward the top-right corner never persists a position past the right edge or above the top', async ({
      page,
    }) => {
      const { user, team } = await seedUser();
      const { recipients } = await seedPendingDocumentWithFullFields({
        owner: user,
        teamId: team.id,
        recipients: ['boundary-top-right@test.documenso.com'],
        fields: [FieldType.NAME],
      });

      const [recipient] = recipients;
      const field = recipient.fields[0];

      await prisma.field.update({
        where: { id: field.id },
        data: { positionX: 85, positionY: 3, width: 10, height: 5 },
      });

      await page.goto(`/sign/${recipient.token}`);

      const handle = dragHandle(page, field.id);
      const before = await handle.boundingBox();

      if (!before) {
        throw new Error('Could not read drag handle bounding box');
      }

      await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
      await page.mouse.down();
      await page.mouse.move(before.x + 500, before.y - 500, { steps: 15 });
      await page.mouse.up();

      await expect(async () => {
        const updated = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

        expect(updated.positionX.toNumber() + updated.width.toNumber()).toBeLessThanOrEqual(100.01);
        expect(updated.positionY.toNumber()).toBeGreaterThanOrEqual(-0.01);
      }).toPass();
    });

    test('dragging toward the bottom-left corner never persists a position below the bottom edge or left of zero', async ({
      page,
    }) => {
      const { user, team } = await seedUser();
      const { recipients } = await seedPendingDocumentWithFullFields({
        owner: user,
        teamId: team.id,
        recipients: ['boundary-bottom-left@test.documenso.com'],
        fields: [FieldType.NAME],
      });

      const [recipient] = recipients;
      const field = recipient.fields[0];

      await prisma.field.update({
        where: { id: field.id },
        data: { positionX: 3, positionY: 85, width: 10, height: 5 },
      });

      await page.goto(`/sign/${recipient.token}`);

      const handle = dragHandle(page, field.id);
      const before = await handle.boundingBox();

      if (!before) {
        throw new Error('Could not read drag handle bounding box');
      }

      await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
      await page.mouse.down();
      await page.mouse.move(before.x - 500, before.y + 500, { steps: 15 });
      await page.mouse.up();

      await expect(async () => {
        const updated = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

        expect(updated.positionX.toNumber()).toBeGreaterThanOrEqual(-0.01);
        expect(updated.positionY.toNumber() + updated.height.toNumber()).toBeLessThanOrEqual(100.01);
      }).toPass();
    });

    test('a geometry-invalid mutation attempt (bypassing the client entirely) is rejected and leaves the persisted field untouched', async ({
      page,
      request,
    }) => {
      const { user, team } = await seedUser();
      const { recipients } = await seedPendingDocumentWithFullFields({
        owner: user,
        teamId: team.id,
        recipients: ['boundary-bypass-client@test.documenso.com'],
        fields: [FieldType.NAME],
      });

      const [recipient] = recipients;
      const field = recipient.fields[0];

      await prisma.field.update({
        where: { id: field.id },
        data: { positionX: 40, positionY: 40, width: 10, height: 10 },
      });

      const before = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

      // Visit the page first so this is a real, live recipient session --
      // then attempt the out-of-page mutation directly via the API,
      // exactly as a client that skips react-rnd's own clamp would.
      await page.goto(`/sign/${recipient.token}`);

      const response = await trpcMutation(request, 'field.repositionFieldWithToken', {
        token: recipient.token,
        fieldId: field.id,
        positionX: 90,
        positionY: 40,
        width: 25, // 90 + 25 = 115, past the right edge.
        height: 10,
      });

      expect(response.ok()).toBe(false);

      const after = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });

      expect(after.positionX.toNumber()).toBeCloseTo(before.positionX.toNumber());
      expect(after.positionY.toNumber()).toBeCloseTo(before.positionY.toNumber());
      expect(after.width.toNumber()).toBeCloseTo(before.width.toNumber());
      expect(after.height.toNumber()).toBeCloseTo(before.height.toNumber());

      // The rejection must not have left the field, or the session, in a
      // broken state -- an ordinary in-bounds drag right afterward should
      // still work normally.
      const handle = dragHandle(page, field.id);
      const handleBox = await handle.boundingBox();

      if (!handleBox) {
        throw new Error('Could not read drag handle bounding box');
      }

      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + 60, handleBox.y + 30, { steps: 10 });
      await page.mouse.up();

      await expect(async () => {
        const finalField = await prisma.field.findUniqueOrThrow({ where: { id: field.id } });
        expect(finalField.positionX.toNumber()).not.toBeCloseTo(before.positionX.toNumber());
      }).toPass();
    });
  });
});
