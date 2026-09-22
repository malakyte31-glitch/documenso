import { getBoundingClientRect } from '@documenso/lib/client-only/get-bounding-client-rect';
import { useElementBounds } from '@documenso/lib/client-only/hooks/use-element-bounds';
import { useFieldPageCoords } from '@documenso/lib/client-only/hooks/use-field-page-coords';
import { useIsPageInDom } from '@documenso/lib/client-only/hooks/use-is-page-in-dom';
import { PDF_VIEWER_CONTENT_SELECTOR, PDF_VIEWER_PAGE_SELECTOR } from '@documenso/lib/constants/pdf-viewer';
import { isFieldUnsignedAndRequired } from '@documenso/lib/utils/advanced-fields-helpers';
import { type Field, FieldType } from '@prisma/client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Rnd } from 'react-rnd';

import { FIELD_ROOT_CONTAINER_CLASS_NAME } from '../../lib/field-root-container-classes';
import type { RecipientColorStyles } from '../../lib/recipient-colors';
import { cn } from '../../lib/utils';

/**
 * The same percentage-of-page representation already stored on
 * `Field.positionX/positionY/width/height` -- what a caller's
 * `onReposition` receives, ready to persist as-is.
 */
export type FieldGeometry = {
  positionX: number;
  positionY: number;
  width: number;
  height: number;
};

// Matches FieldItem's own minimums (packages/ui/primitives/document-flow/field-item.tsx)
// for the sender-side editor -- keeps the two drag/resize experiences consistent.
const MIN_EDITABLE_WIDTH_PX = 36;
const MIN_EDITABLE_HEIGHT_PX = 12;

export type FieldContainerPortalProps = {
  field: Field;
  className?: string;
  children: React.ReactNode;

  /**
   * When true, the field can be dragged/resized by the current viewer
   * (e.g. a recipient adjusting their own not-yet-inserted field) instead
   * of being statically positioned. Reuses react-rnd -- the same library
   * the sender-side field editor (FieldItem) already uses for the exact
   * same job -- rather than a second drag/resize implementation. Every
   * other caller of this component is unaffected: `editable` defaults to
   * false, and the existing static-position rendering path below is
   * completely untouched when it is.
   */
  editable?: boolean;

  /**
   * Called with the field's new position/size once a drag or resize
   * FINISHES -- never on every pointer movement. The caller decides how
   * (or whether) to persist this; nothing here calls any mutation
   * directly, keeping this shared primitive free of any specific
   * network/auth concern.
   */
  onReposition?: (geometry: FieldGeometry) => void;

  /**
   * Rendered as a SIBLING of `children` inside the Rnd root, not nested
   * inside it -- `children`'s own root div (FieldRootContainer's
   * `#field-{id}`) sets its own `position:relative` + `z-20`, which
   * makes it establish its own stacking context. A z-index on anything
   * nested inside that div can never out-rank a sibling of that div
   * (like react-rnd's own resize handles below): the whole div is
   * compared as one unit, at its own z-20, regardless of how high a
   * descendant's z-index goes. Callers needing an editable-only
   * affordance (e.g. a drag handle) that must out-rank those resize
   * handles pass it here instead of via `children`.
   */
  dragHandle?: React.ReactNode;
};

export function FieldContainerPortal({
  field,
  children,
  className = '',
  editable = false,
  onReposition,
  dragHandle,
}: FieldContainerPortalProps) {
  const alternativePortalRoot = document.getElementById('document-field-portal-root');

  const coords = useFieldPageCoords(field);
  const $pageBounds = useElementBounds(`${PDF_VIEWER_PAGE_SELECTOR}[data-page-number="${field.page}"]`);

  const maxWidth = $pageBounds?.width ? $pageBounds.width - coords.x : undefined;

  const isCheckboxOrRadioField = field.type === 'CHECKBOX' || field.type === 'RADIO';

  const style = useMemo(() => {
    const portalBounds = alternativePortalRoot?.getBoundingClientRect();

    const bounds = {
      top: `${coords.y}px`,
      left: `${coords.x}px`,
      ...(!isCheckboxOrRadioField
        ? {
            height: `${coords.height}px`,
            width: `${coords.width}px`,
          }
        : {
            maxWidth: `${maxWidth}px`,
          }),
    };

    if (portalBounds) {
      bounds.top = `${coords.y - portalBounds.top}px`;
      bounds.left = `${coords.x - portalBounds.left}px`;
    }

    return bounds;
  }, [coords, maxWidth, isCheckboxOrRadioField]);

  // Numeric twin of `style` above, only computed for the editable path --
  // react-rnd wants numbers, not px strings, for its `default` position.
  //
  // Checkbox/radio are excluded from the width/height it computes: the
  // static path above never sizes them from field.width/height either
  // (only maxWidth) -- their real footprint is content-driven (however
  // many options/labels are configured), same as FieldItem's own
  // sender-side editor, which goes auto-sized + non-resizable for these
  // two types once they have configured values (see `fixedSize` in
  // packages/ui/primitives/document-flow/field-item.tsx). At signing
  // time a checkbox/radio field always has its values already
  // configured -- the sender must set them before sending -- so that
  // condition is unconditionally true here.
  const editableBounds = useMemo(() => {
    const portalBounds = alternativePortalRoot?.getBoundingClientRect();

    let y = coords.y;
    let x = coords.x;

    if (portalBounds) {
      y = coords.y - portalBounds.top;
      x = coords.x - portalBounds.left;
    }

    // react-rnd's `default` wants {x, y, width, height}, not {top, left, ...}.
    return {
      x,
      y,
      width: isCheckboxOrRadioField ? ('auto' as const) : coords.width,
      height: isCheckboxOrRadioField ? ('auto' as const) : coords.height,
    };
  }, [coords, alternativePortalRoot, isCheckboxOrRadioField]);

  const handleRepositionStop = useCallback(
    (node: HTMLElement) => {
      const $page = document.querySelector<HTMLElement>(
        `${PDF_VIEWER_PAGE_SELECTOR}[data-page-number="${field.page}"]`,
      );

      if (!$page || !onReposition) {
        return;
      }

      // Re-read both rects fresh at drop time rather than trusting
      // earlier hook state, which could be one render behind a fast
      // drag/resize.
      const pageBounds = getBoundingClientRect($page);
      const nodeBounds = getBoundingClientRect(node);

      if (pageBounds.width === 0 || pageBounds.height === 0) {
        return;
      }

      if (isCheckboxOrRadioField) {
        // Resizing is disabled for these two types (enableResizing below),
        // so only position ever changes here. Width/height are reported
        // back unchanged from the field's own already-stored values,
        // rather than derived from this auto-sized node's current DOM
        // footprint -- that footprint is a function of how many
        // options/labels are configured, not a deliberate size the
        // recipient chose, and persisting it would let a field's stored
        // width/height drift on every drag for a reason no one actually
        // asked for.
        onReposition({
          positionX: ((nodeBounds.left - pageBounds.left) / pageBounds.width) * 100,
          positionY: ((nodeBounds.top - pageBounds.top) / pageBounds.height) * 100,
          width: Number(field.width),
          height: Number(field.height),
        });

        return;
      }

      onReposition({
        positionX: ((nodeBounds.left - pageBounds.left) / pageBounds.width) * 100,
        positionY: ((nodeBounds.top - pageBounds.top) / pageBounds.height) * 100,
        width: (nodeBounds.width / pageBounds.width) * 100,
        height: (nodeBounds.height / pageBounds.height) * 100,
      });
    },
    [field.page, field.width, field.height, isCheckboxOrRadioField, onReposition],
  );

  const content =
    editable && onReposition ? (
      <Rnd
        // react-rnd's `default` is read once, at mount, and never again --
        // it is not reactive to prop changes. useFieldPageCoords starts at
        // {0,0,0,0} and only becomes correct after an effect runs post-
        // mount, so without a key forcing a remount when that correction
        // lands, Rnd freezes onto the pre-correction (wrong) position/size
        // forever. FieldItem (the sender-side editor) hits the exact same
        // problem and solves it the same way -- see its own `key` on its
        // <Rnd> in packages/ui/primitives/document-flow/field-item.tsx.
        key={`${coords.x}-${coords.y}-${coords.width}-${coords.height}`}
        className={cn('pointer-events-auto', className)}
        default={editableBounds}
        minWidth={isCheckboxOrRadioField ? '' : MIN_EDITABLE_WIDTH_PX}
        minHeight={isCheckboxOrRadioField ? '' : MIN_EDITABLE_HEIGHT_PX}
        // Mirrors FieldItem's own `fixedSize` treatment: checkbox/radio
        // stay auto-sized to their content and only ever move, never
        // resize (see the editableBounds/handleRepositionStop comments
        // above for why).
        maxWidth={isCheckboxOrRadioField ? maxWidth : undefined}
        enableResizing={!isCheckboxOrRadioField}
        bounds={`${PDF_VIEWER_PAGE_SELECTOR}[data-page-number="${field.page}"]`}
        // Dragging is restricted to a small, explicit handle element (see
        // DocumentSigningFieldContainer's grip icon) rather than the whole
        // field surface -- the rest of the field remains the existing
        // click-to-insert button, untouched, so a drag can never be
        // mistaken for (or accidentally trigger) an insertion click.
        dragHandleClassName="field-drag-handle"
        // A stable, testable class on the bottom-right resize handle --
        // re-resizable (which react-rnd uses internally) gives its
        // handles no class or attribute at all by default, which would
        // leave automated tests with no reliable way to target one.
        // Never rendered at all for checkbox/radio since enableResizing
        // is false for them.
        resizeHandleClasses={{ bottomRight: 'field-resize-handle' }}
        // A corner resize handle is centered on the field's own edge, so
        // roughly a quarter of it overlaps the click-to-insert button
        // below (which covers the field's full surface via `inset-0`).
        // re-resizable's own default z-index for its handles (1) loses to
        // that button's z-10, so a real drag starting exactly on the
        // handle's center -- the natural place to grab it -- was
        // silently swallowed by the button instead: no resize, and no
        // insertion either (the pointer moves away before release, so
        // the button's own click never fires). Every handle gets a
        // z-index above the button so a grab always wins there, while
        // every other point on the field surface still belongs to the
        // insert button exactly as before. (The insert button lives
        // inside `children`'s own #field-{id} div, which is a sibling
        // of these handles and has its own z-20 -- these z-30s only need
        // to beat THAT div's baseline, not the button's inner z-10
        // directly; see the `dragHandle` prop doc for why that matters.)
        resizeHandleStyles={{
          top: { zIndex: 30 },
          right: { zIndex: 30 },
          bottom: { zIndex: 30 },
          left: { zIndex: 30 },
          topRight: { zIndex: 30 },
          bottomRight: { zIndex: 30 },
          bottomLeft: { zIndex: 30 },
          topLeft: { zIndex: 30 },
        }}
        onDragStop={(_e, data) => handleRepositionStop(data.node)}
        onResizeStop={(_e, _direction, ref) => handleRepositionStop(ref)}
      >
        {children}
        {dragHandle}
      </Rnd>
    ) : (
      <div className={cn('absolute', className)} style={style}>
        {children}
      </div>
    );

  return createPortal(content, alternativePortalRoot ?? document.body);
}

export type FieldRootContainerProps = {
  field: Field;
  color?: RecipientColorStyles;
  children: React.ReactNode;
  className?: string;
  readonly?: boolean;
  editable?: boolean;
  onReposition?: (geometry: FieldGeometry) => void;
  /** See FieldContainerPortalProps.dragHandle -- passed straight through. */
  dragHandle?: React.ReactNode;
};

export function FieldRootContainer({
  field,
  children,
  color,
  className,
  readonly,
  editable,
  onReposition,
  dragHandle,
}: FieldRootContainerProps) {
  const [isValidating, setIsValidating] = useState(false);
  const isPageInDom = useIsPageInDom(field.page);

  const ref = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) {
      return;
    }

    // Check the validation signal on the PDF viewer container. When a field
    // mounts after the virtual list scrolls to its page, the per-element
    // `data-validate` attribute will not have been set yet. The signal on the
    // `[data-pdf-content]` container bridges this gap so newly-rendered fields
    // pick up the validation state immediately.
    const pdfContent = document.querySelector(PDF_VIEWER_CONTENT_SELECTOR);

    if (pdfContent?.getAttribute('data-validate-fields') === 'true' && isFieldUnsignedAndRequired(field)) {
      ref.current.setAttribute('data-validate', 'true');
      setIsValidating(true);
    }

    const observer = new MutationObserver((_mutations) => {
      if (ref.current) {
        setIsValidating(ref.current.getAttribute('data-validate') === 'true');
      }
    });

    observer.observe(ref.current, {
      attributes: true,
    });

    return () => {
      observer.disconnect();
    };
  }, [isPageInDom]);

  if (!isPageInDom) {
    return null;
  }

  return (
    <FieldContainerPortal field={field} editable={editable} onReposition={onReposition} dragHandle={dragHandle}>
      <div
        id={`field-${field.id}`}
        ref={ref}
        data-field-type={field.type}
        data-inserted={field.inserted ? 'true' : 'false'}
        data-readonly={readonly ? 'true' : 'false'}
        className={cn(
          FIELD_ROOT_CONTAINER_CLASS_NAME,
          color?.base,
          {
            'px-2': field.type !== FieldType.SIGNATURE && field.type !== FieldType.FREE_SIGNATURE,
            'justify-center': !field.inserted,
            'ring-orange-300': isValidating && isFieldUnsignedAndRequired(field),
          },
          className,
        )}
      >
        {children}
      </div>
    </FieldContainerPortal>
  );
}
