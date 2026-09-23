import { useAnalytics } from '@documenso/lib/client-only/hooks/use-analytics';
import { usePageRenderer } from '@documenso/lib/client-only/hooks/use-page-renderer';
import {
  type PageRenderData,
  useCurrentEnvelopeRender,
} from '@documenso/lib/client-only/providers/envelope-render-provider';
import { useOptionalSession } from '@documenso/lib/client-only/providers/session';
import { DIRECT_TEMPLATE_RECIPIENT_EMAIL } from '@documenso/lib/constants/direct-templates';
import { isBase64Image } from '@documenso/lib/constants/signatures';
import { DO_NOT_INVALIDATE_QUERY_ON_MUTATION } from '@documenso/lib/constants/trpc';
import type { TRecipientActionAuth } from '@documenso/lib/types/document-auth';
import type { TEnvelope } from '@documenso/lib/types/envelope';
import { ZFullFieldSchema } from '@documenso/lib/types/field';
import {
  createFieldCanvasStyleCache,
  type FieldCanvasStyleCache,
} from '@documenso/lib/universal/field-renderer/field-canvas-style';
import { createSpinner } from '@documenso/lib/universal/field-renderer/field-generic-items';
import {
  convertPixelToPercentage,
  MIN_FIELD_HEIGHT_PX,
  MIN_FIELD_WIDTH_PX,
} from '@documenso/lib/universal/field-renderer/field-renderer';
import { renderField } from '@documenso/lib/universal/field-renderer/render-field';
import { isFieldUnsignedAndRequired } from '@documenso/lib/utils/advanced-fields-helpers';
import { getClientSideFieldTranslations } from '@documenso/lib/utils/fields';
import { extractInitials } from '@documenso/lib/utils/recipient-formatter';
import { trpc } from '@documenso/trpc/react';
import type { TSignEnvelopeFieldValue } from '@documenso/trpc/server/envelope-router/sign-envelope-field.types';
import { EnvelopeRecipientFieldTooltip } from '@documenso/ui/components/document/envelope-recipient-field-tooltip';
import { EnvelopeFieldToolTip } from '@documenso/ui/components/field/envelope-field-tooltip';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  type Field,
  FieldType,
  Prisma,
  type Recipient,
  RecipientRole,
  type Signature,
  SigningStatus,
} from '@prisma/client';
import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useEffect, useMemo, useRef } from 'react';
import { match } from 'ts-pattern';

import { useEmbedSigningContext } from '~/components/embed/embed-signing-context';
import { handleCheckboxFieldClick } from '~/utils/field-signing/checkbox-field';
import { handleDropdownFieldClick } from '~/utils/field-signing/dropdown-field';
import { handleEmailFieldClick } from '~/utils/field-signing/email-field';
import { handleInitialsFieldClick } from '~/utils/field-signing/initial-field';
import { handleNameFieldClick } from '~/utils/field-signing/name-field';
import { handleNumberFieldClick } from '~/utils/field-signing/number-field';
import { handleSignatureFieldClick } from '~/utils/field-signing/signature-field';
import { handleTextFieldClick } from '~/utils/field-signing/text-field';

import { useRequiredDocumentSigningAuthContext } from '../document-signing/document-signing-auth-provider';
import { useRequiredEnvelopeSigningContext } from '../document-signing/envelope-signing-provider';

/** How far past a resize handle you can still grab it, in screen pixels -- matches EnvelopeEditorFieldsPageRenderer's own transformer. */
const TRANSFORMER_ANCHOR_HIT_STROKE_PX = 24;

type GenericLocalField = TEnvelope['fields'][number] & {
  recipient: Pick<Recipient, 'id' | 'name' | 'email' | 'signingStatus'>;
};

export const EnvelopeSignerPageRenderer = ({ pageData }: { pageData: PageRenderData }) => {
  const { t, i18n } = useLingui();
  const { currentEnvelopeItem, setRenderError } = useCurrentEnvelopeRender();
  const { sessionData } = useOptionalSession();

  const { executeActionAuthProcedure } = useRequiredDocumentSigningAuthContext();
  const { toast } = useToast();
  const analytics = useAnalytics();

  const {
    envelopeData,
    recipient,
    recipientFields,
    recipientFieldsRemaining,
    showPendingFieldTooltip,
    signField: signFieldInternal,
    email: emailState,
    setEmail,
    fullName: fullNameState,
    setFullName,
    signature: signatureState,
    setSignature,
    selectedAssistantRecipientFields,
    selectedAssistantRecipient,
    isDirectTemplate,
  } = useRequiredEnvelopeSigningContext();

  // Note: We're using refs here due to the closure within the signField function.
  const fullName = useRef(fullNameState);
  const email = useRef(emailState);
  const signature = useRef(signatureState);

  useEffect(() => {
    fullName.current = fullNameState;
    email.current = emailState;
    signature.current = signatureState;
  }, [fullNameState, emailState, signatureState]);

  const cachedRenderFields = useRef<Map<number, Field & { signature?: Signature | null }>>(new Map());
  const prevShowPendingFieldTooltip = useRef(showPendingFieldTooltip);

  const { onFieldSigned, onFieldUnsigned } = useEmbedSigningContext() || {};

  const { stage, pageLayer, konvaContainer, unscaledViewport, scaledViewport } = usePageRenderer(
    ({ stage, pageLayer }) => createPageCanvas(stage, pageLayer),
    pageData,
  );

  const { scale, pageNumber } = pageData;

  const { mutateAsync: repositionFieldWithToken } = trpc.field.repositionFieldWithToken.useMutation(
    DO_NOT_INVALIDATE_QUERY_ON_MUTATION,
  );

  // Konva.Transformer instances currently attached for the recipient's own
  // editable (not-yet-inserted, not read-only) fields, keyed by field id.
  // upsertFieldGroup/upsertFieldRect reuse (never recreate) the field's own
  // Konva.Group across re-renders, so a field that becomes ineligible (e.g.
  // just got inserted) needs its transformer torn down explicitly rather
  // than leaking a still-interactive one attached to a field that no
  // longer permits editing.
  const fieldTransformers = useRef<Map<number, Konva.Transformer>>(new Map());

  const { envelope } = envelopeData;

  const localPageFields = useMemo(() => {
    let fieldsToRender = recipientFields;

    if (recipient.role === RecipientRole.ASSISTANT) {
      fieldsToRender = selectedAssistantRecipientFields;
    }

    return fieldsToRender.filter(
      (field) => field.page === pageNumber && field.envelopeItemId === currentEnvelopeItem?.id,
    );
  }, [recipientFields, selectedAssistantRecipientFields, pageNumber, currentEnvelopeItem?.id]);

  /**
   * Returns fields that have been fully signed by other recipients for this specific
   * page.
   */
  const localPageOtherRecipientFields = useMemo((): GenericLocalField[] => {
    const signedRecipients = envelope.recipients.filter(
      (recipient) => recipient.signingStatus === SigningStatus.SIGNED,
    );

    return signedRecipients.flatMap((recipient) => {
      return recipient.fields
        .filter(
          (field) =>
            field.page === pageNumber &&
            field.envelopeItemId === currentEnvelopeItem?.id &&
            (field.inserted || field.fieldMeta?.readOnly),
        )
        .map((field) => ({
          ...field,
          recipient: {
            id: recipient.id,
            name: recipient.name,
            email: recipient.email,
            signingStatus: recipient.signingStatus,
            role: recipient.role,
          },
        }));
    });
  }, [envelope.recipients, pageNumber, currentEnvelopeItem?.id]);

  const unsafeRenderFieldOnLayer = (
    unparsedField: Field & { signature?: Signature | null },
    fieldCanvasStyleCache: FieldCanvasStyleCache,
  ) => {
    if (!pageLayer.current) {
      console.error('Layer not loaded yet');
      return;
    }

    const fieldToRender = ZFullFieldSchema.parse(unparsedField);

    const isValidating = showPendingFieldTooltip && isFieldUnsignedAndRequired(fieldToRender);

    const color = fieldToRender.fieldMeta?.readOnly ? 'readOnly' : isValidating ? 'orange' : 'green';

    // A recipient may reposition/resize their own field up until it's
    // inserted -- the exact same UX gate document-signing-field-container.tsx
    // (the V1/DOM path) uses. This is UX only: repositionFieldWithToken
    // re-derives and enforces the real eligibility server-side regardless
    // of what the client believes here. Computed before renderField() so
    // it can be passed straight through as `editable`: upsertFieldGroup
    // (shared with EnvelopeEditorFieldsPageRenderer, the sender editor)
    // sets fieldGroup's own `draggable` attr from this flag, making
    // fieldGroup itself the field's drag surface -- there is no separate
    // drag-handle node. Konva's own drag engine plus the dragBoundFunc
    // upsertFieldGroup already sets handle page-edge clamping, so moving a
    // field never needs any manual coordinate math here.
    const isFieldEditable = !fieldToRender.inserted && !fieldToRender.fieldMeta?.readOnly;

    const { fieldGroup } = renderField({
      scale,
      pageLayer: pageLayer.current,
      field: {
        renderId: fieldToRender.id.toString(),
        ...fieldToRender,
        width: Number(fieldToRender.width),
        height: Number(fieldToRender.height),
        positionX: Number(fieldToRender.positionX),
        positionY: Number(fieldToRender.positionY),
        isValidating,
        signature: unparsedField.signature,
      },
      translations: getClientSideFieldTranslations(i18n),
      pageWidth: unscaledViewport.width,
      pageHeight: unscaledViewport.height,
      color,
      mode: 'sign',
      editable: isFieldEditable,
      fieldCanvasStyleCache,
    });

    /**
     * Reads the field's current on-screen bounding box and converts it to
     * percentage-of-page geometry, using the same ratio technique as
     * EnvelopeEditorFieldsPageRenderer's own handleResizeOrMove:
     * getClientRect() returns stage-scaled (zoomed) pixels, and dividing by
     * the equally-scaled viewport cancels the zoom factor out, so the
     * result is correct at any zoom level.
     *
     * Deliberately measures the '.field-rect' CHILD, not fieldGroup itself:
     * every field type's own render-*-field.ts may add other descendants
     * (e.g. a loading spinner), and measuring '.field-rect' directly keeps
     * this immune to any of them rather than needing to know about each
     * one. EnvelopeEditorFieldsPageRenderer's own fieldGroup has no such
     * extra children at persistence time, so it doesn't need this
     * distinction.
     */
    const getFieldPercentageGeometry = () => {
      const fieldRect = fieldGroup.findOne('.field-rect');
      const rectClientRect = fieldRect?.getClientRect({ skipStroke: true, skipShadow: true });
      const { width, height, x, y } =
        rectClientRect ?? fieldGroup.getClientRect({ skipStroke: true, skipShadow: true });

      const { fieldX, fieldY, fieldWidth, fieldHeight } = convertPixelToPercentage({
        positionX: x,
        positionY: y,
        width,
        height,
        pageWidth: scaledViewport.width,
        pageHeight: scaledViewport.height,
      });

      return { positionX: fieldX, positionY: fieldY, width: fieldWidth, height: fieldHeight };
    };

    /**
     * Persists a drag/resize via the existing, unmodified
     * repositionFieldWithToken mutation, then repaints the field from that
     * persisted geometry by re-running this same render function -- reusing
     * the render pipeline (and every field type's own 'transform' child-
     * layout handler) to bake the gesture's scale into the field's actual
     * width/height and reset scale to 1, rather than hand-rolling that
     * reset here. On rejection, repaints from the field's last known-good
     * geometry so a rejected change never leaves a mismatched shape on
     * screen -- the server, not this code, is what decided the rejection.
     *
     * Synchronously locks geometry editing (destroys the Transformer,
     * disables fieldGroup's own dragging) BEFORE awaiting the mutation --
     * mirroring signField's own lockFieldGeometryEditing call for
     * insertion -- so a second drag or resize on this field can never
     * begin while this request is still in flight. That in-flight gap
     * (previously unguarded) is what let one gesture's stale, still-
     * transforming state get read by a second, overlapping gesture.
     * Restoring interactivity, if the field is still eligible, happens
     * naturally: both branches below re-render via renderFieldOnLayer,
     * which recomputes isFieldEditable fresh and reapplies the
     * Transformer/draggable state accordingly.
     */
    const persistFieldGeometry = async (geometry: {
      positionX: number;
      positionY: number;
      width: number;
      height: number;
    }) => {
      lockFieldGeometryEditing(fieldToRender.id);

      try {
        await repositionFieldWithToken({
          token: recipient.token,
          fieldId: unparsedField.id,
          ...geometry,
        });

        const updatedField: Field & { signature?: Signature | null } = {
          ...unparsedField,
          positionX: new Prisma.Decimal(geometry.positionX),
          positionY: new Prisma.Decimal(geometry.positionY),
          width: new Prisma.Decimal(geometry.width),
          height: new Prisma.Decimal(geometry.height),
        };

        cachedRenderFields.current.set(unparsedField.id, updatedField);
        renderFieldOnLayer(updatedField, fieldCanvasStyleCache);
      } catch (err) {
        console.error(err);

        toast({
          title: t`Error`,
          description: t`Could not save this field's position or size. Please try again.`,
          variant: 'destructive',
        });

        renderFieldOnLayer(unparsedField, fieldCanvasStyleCache);
      } finally {
        pageLayer.current?.batchDraw();
      }
    };

    // Tear down any transformer left over from a previous render of this
    // same field before deciding whether to reattach -- see the
    // fieldTransformers doc comment above for why this can't be skipped.
    fieldTransformers.current.get(fieldToRender.id)?.destroy();
    fieldTransformers.current.delete(fieldToRender.id);

    if (isFieldEditable) {
      // Resize handles, reusing EnvelopeEditorFieldsPageRenderer's own
      // Konva.Transformer configuration (the sender's placement editor) --
      // every field type's render-*-field.ts already has its own
      // 'transform' handler keeping child content (checkbox squares, text,
      // signature preview) correctly laid out live during this gesture, so
      // nothing extra is needed here for that.
      const transformer = new Konva.Transformer({
        nodes: [fieldGroup],
        rotateEnabled: false,
        keepRatio: false,
        ignoreStroke: true,
        flipEnabled: false,
        anchorStyleFunc: (anchor) => {
          anchor.hitStrokeWidth(TRANSFORMER_ANCHOR_HIT_STROKE_PX / scale);
        },
        boundBoxFunc: (oldBox, newBox) => {
          if (newBox.width < MIN_FIELD_WIDTH_PX || newBox.height < MIN_FIELD_HEIGHT_PX) {
            return oldBox;
          }

          return newBox;
        },
      });

      pageLayer.current.add(transformer);
      fieldTransformers.current.set(fieldToRender.id, transformer);

      fieldGroup.off('transformend');
      fieldGroup.on('transformend', () => {
        void persistFieldGeometry(getFieldPercentageGeometry());
      });

      // fieldGroup itself is the field's drag surface -- upsertFieldGroup
      // (called from renderField() above, via the `editable` flag passed
      // through) already set `draggable: true` and a dragBoundFunc
      // clamping it to the page, using Konva's own native drag engine.
      // There is no separate drag-handle node: the diagnosed grip/body
      // coordinate-space mismatch, grip/Transformer hit-region collision,
      // and grip deformation under non-uniform Transformer scaling were
      // all consequences of that now-removed node, not of fieldGroup's own
      // dragging. Click-to-insert (handleFieldGroupClick, bound below) is
      // wired to Konva's 'click'/'tap' events rather than 'pointerdown', so
      // Konva's own drag-distance threshold naturally suppresses it once a
      // real drag has started, instead of needing a second interactive
      // node to keep the two gestures apart.
      fieldGroup.off('dragend');
      fieldGroup.on('dragend', () => {
        void persistFieldGeometry(getFieldPercentageGeometry());
      });
    }

    const handleFieldGroupClick = (e: KonvaEventObject<Event>) => {
      const currentTarget = e.currentTarget as Konva.Group;
      const target = e.target as Konva.Shape;

      const fieldRect = fieldGroup.findOne('.field-rect');
      const fieldWidth = fieldRect ? fieldRect.width() : fieldGroup.width();
      const fieldHeight = fieldRect ? fieldRect.height() : fieldGroup.height();

      const foundField = localPageFields.find((f) => f.id === unparsedField.id);
      const foundLoadingGroup = currentTarget.findOne('.loading-spinner-group');

      if (!foundField || foundLoadingGroup || foundField.fieldMeta?.readOnly) {
        return;
      }

      let localEmail: string | null = email.current;
      let localFullName: string | null = fullName.current;
      let placeholderEmail: string | null = null;

      if (recipient.role === RecipientRole.ASSISTANT) {
        localEmail = selectedAssistantRecipient?.email || null;
        localFullName = selectedAssistantRecipient?.name || null;
      }

      // Allows us let the user set a different email than their current logged in email.
      if (isDirectTemplate) {
        placeholderEmail = sessionData?.user?.email || email.current || recipient.email;

        if (!placeholderEmail || placeholderEmail === DIRECT_TEMPLATE_RECIPIENT_EMAIL) {
          placeholderEmail = null;
        }
      }

      const loadingSpinnerGroup = createSpinner({
        fieldWidth,
        fieldHeight,
      });

      const parsedFoundField = ZFullFieldSchema.parse(foundField);

      match(parsedFoundField)
        /**
         * CHECKBOX FIELD.
         */
        .with({ type: FieldType.CHECKBOX }, (field) => {
          const clickedCheckboxIndex = Number(target.getAttr('internalCheckboxIndex'));

          if (Number.isNaN(clickedCheckboxIndex)) {
            return;
          }

          void handleCheckboxFieldClick({ field, clickedCheckboxIndex })
            .then(async (payload) => {
              if (payload) {
                fieldGroup.add(loadingSpinnerGroup);
                await signField(field.id, payload);
              }
            })
            .finally(() => {
              loadingSpinnerGroup.destroy();
            });
        })
        /**
         * RADIO FIELD.
         */
        .with({ type: FieldType.RADIO }, (field) => {
          const selectedRadioIndex = Number(target.getAttr('internalRadioIndex'));
          const fieldCustomText = Number(field.customText);

          if (Number.isNaN(selectedRadioIndex)) {
            return;
          }

          fieldGroup.add(loadingSpinnerGroup);

          // Uncheck the value if it's already pressed.
          const value = field.inserted && selectedRadioIndex === fieldCustomText ? null : selectedRadioIndex;

          void signField(field.id, {
            type: FieldType.RADIO,
            value,
          }).finally(() => {
            loadingSpinnerGroup.destroy();
          });
        })
        /**
         * NUMBER FIELD.
         */
        .with({ type: FieldType.NUMBER }, (field) => {
          void handleNumberFieldClick({ field, number: null })
            .then(async (payload) => {
              if (payload) {
                fieldGroup.add(loadingSpinnerGroup);
                await signField(field.id, payload);
              }
            })
            .finally(() => {
              loadingSpinnerGroup.destroy();
            });
        })
        /**
         * TEXT FIELD.
         */
        .with({ type: FieldType.TEXT }, (field) => {
          void handleTextFieldClick({ field, text: null })
            .then(async (payload) => {
              if (payload) {
                fieldGroup.add(loadingSpinnerGroup);
                await signField(field.id, payload);
              }
            })
            .finally(() => {
              loadingSpinnerGroup.destroy();
            });
        })
        /**
         * EMAIL FIELD.
         */
        .with({ type: FieldType.EMAIL }, (field) => {
          void handleEmailFieldClick({ field, email: localEmail, placeholderEmail })
            .then(async (payload) => {
              if (payload) {
                fieldGroup.add(loadingSpinnerGroup);
                await signField(field.id, payload);
              }

              if (payload?.value) {
                setEmail(payload.value);
              }
            })
            .finally(() => {
              loadingSpinnerGroup.destroy();
            });
        })
        /**
         * INITIALS FIELD.
         */
        .with({ type: FieldType.INITIALS }, (field) => {
          const initials = localFullName ? extractInitials(localFullName) : null;

          void handleInitialsFieldClick({ field, initials })
            .then(async (payload) => {
              if (payload) {
                fieldGroup.add(loadingSpinnerGroup);
                await signField(field.id, payload);
              }
            })
            .finally(() => {
              loadingSpinnerGroup.destroy();
            });
        })
        /**
         * NAME FIELD.
         */
        .with({ type: FieldType.NAME }, (field) => {
          void handleNameFieldClick({ field, name: localFullName })
            .then(async (payload) => {
              if (payload) {
                fieldGroup.add(loadingSpinnerGroup);
                await signField(field.id, payload);
              }

              if (payload?.value) {
                setFullName(payload.value);
              }
            })
            .finally(() => {
              loadingSpinnerGroup.destroy();
            });
        })
        /**
         * DROPDOWN FIELD.
         */
        .with({ type: FieldType.DROPDOWN }, (field) => {
          void handleDropdownFieldClick({ field, text: null })
            .then(async (payload) => {
              if (payload) {
                fieldGroup.add(loadingSpinnerGroup);
                await signField(field.id, payload);
              }
            })
            .finally(() => {
              loadingSpinnerGroup.destroy();
            });
        })
        /**
         * DATE FIELD.
         */
        .with({ type: FieldType.DATE }, (field) => {
          fieldGroup.add(loadingSpinnerGroup);

          void signField(field.id, {
            type: FieldType.DATE,
            value: !field.inserted,
          }).finally(() => {
            loadingSpinnerGroup.destroy();
          });
        })
        /**
         * SIGNATURE FIELD.
         */
        .with({ type: FieldType.SIGNATURE }, (field) => {
          void handleSignatureFieldClick({
            field,
            fullName: fullName.current,
            signature: signature.current,
            typedSignatureEnabled: envelope.documentMeta.typedSignatureEnabled,
            uploadSignatureEnabled: envelope.documentMeta.uploadSignatureEnabled,
            drawSignatureEnabled: envelope.documentMeta.drawSignatureEnabled,
          })
            .then(async (payload) => {
              if (!payload) {
                return;
              }

              fieldGroup.add(loadingSpinnerGroup);

              if (payload.value) {
                await executeActionAuthProcedure({
                  onReauthFormSubmit: async (authOptions) => {
                    await signField(field.id, payload, authOptions);

                    loadingSpinnerGroup.destroy();
                  },
                  actionTarget: field.type,
                });

                setSignature(payload.value);
              } else {
                await signField(field.id, payload);
              }
            })
            .finally(() => {
              loadingSpinnerGroup.destroy();
            });
        })
        .exhaustive();
    };

    // 'click'/'tap' rather than 'pointerdown': Konva fires these only on a
    // genuine tap/click (pointerup without an intervening real drag past
    // its own drag-distance threshold), and suppresses them automatically
    // once a drag has started -- letting fieldGroup be draggable (for
    // moving the field) and still insert/sign on an ordinary click without
    // this handler needing to distinguish the two gestures itself.
    fieldGroup.off('click tap');
    fieldGroup.on('click tap', handleFieldGroupClick);
  };

  const renderFieldOnLayer = (
    unparsedField: Field & { signature?: Signature | null },
    fieldCanvasStyleCache: FieldCanvasStyleCache,
  ) => {
    try {
      unsafeRenderFieldOnLayer(unparsedField, fieldCanvasStyleCache);
    } catch (err) {
      console.error(err);

      analytics.captureException(err, {
        source: 'signing',
        location: 'page_render',
        recipientId: recipient.id,
        envelopeId: envelope.id,
      });

      setRenderError(true);
    }
  };

  const renderFields = () => {
    if (!pageLayer.current) {
      console.error('Layer not loaded yet');
      return;
    }

    const fieldCanvasStyleCache = createFieldCanvasStyleCache();

    // Render current recipient fields which have changed or are not currently rendered.
    for (const field of localPageFields) {
      const existingCachedField = cachedRenderFields.current.get(field.id);
      const isFieldCurrentlyRendered = pageLayer.current.findOne(`#${field.id}`);

      if (
        !isFieldCurrentlyRendered ||
        !existingCachedField ||
        existingCachedField.inserted !== field.inserted ||
        existingCachedField.customText !== field.customText
      ) {
        renderFieldOnLayer(field, fieldCanvasStyleCache);
        cachedRenderFields.current.set(field.id, field);
      }
    }

    // Render other recipient signed and inserted fields.
    for (const field of localPageOtherRecipientFields) {
      try {
        const { fieldGroup } = renderField({
          scale,
          pageLayer: pageLayer.current,
          field: {
            renderId: field.id.toString(),
            ...field,
            width: Number(field.width),
            height: Number(field.height),
            positionX: Number(field.positionX),
            positionY: Number(field.positionY),
            fieldMeta: field.fieldMeta,
          },
          translations: getClientSideFieldTranslations(i18n),
          pageWidth: unscaledViewport.width,
          pageHeight: unscaledViewport.height,
          color: 'readOnly',
          editable: false,
          mode: 'sign',
          fieldCanvasStyleCache,
        });

        // Other-recipient fields are display-only — they have no click handlers
        // and shouldn't intercept events meant for the current recipient's
        // fields. Disable hit detection on the entire group.
        fieldGroup.listening(false);
      } catch (err) {
        console.error('Unable to render one or more fields belonging to other recipients.');
        console.error(err);
      }
    }
  };

  /**
   * Immediately (synchronously, before any network round-trip) tears down
   * a field's Transformer and disables fieldGroup's own native dragging,
   * so a drag or resize can never be initiated -- or land -- while an
   * insertion OR reposition request for that same field is in flight.
   * This is the actual defect from the live P3-C incident: geometry
   * controls stayed interactive for the round-trip duration of a mutation,
   * long enough for a real drag/resize gesture to race it. Waiting for
   * the broader recipientFields refresh (which is how re-renders normally
   * happen) was too slow -- this acts on the exact Konva nodes directly,
   * at the two places (signField, persistFieldGeometry) every insertion
   * or reposition attempt already funnels through, rather than
   * duplicating this in each of handleFieldGroupClick's per-type
   * branches. fieldGroup is now the field's own drag surface (there is no
   * separate drag-handle node), so destroying the Transformer alone is
   * not enough -- fieldGroup's `draggable` flag has to be turned off
   * explicitly too, and any drag already in progress stopped outright.
   */
  const lockFieldGeometryEditing = (fieldId: number) => {
    fieldTransformers.current.get(fieldId)?.destroy();
    fieldTransformers.current.delete(fieldId);

    const targetGroup = pageLayer.current?.findOne<Konva.Group>(`#${fieldId}`);

    if (targetGroup?.isDragging()) {
      targetGroup.stopDrag();
    }

    targetGroup?.draggable(false);

    pageLayer.current?.batchDraw();
  };

  /**
   * Re-runs this field's own render from data this component already
   * has. Only called when the insertion attempt did NOT result in
   * field.inserted becoming true (a failure, or a legitimate non-
   * inserting outcome like a checkbox being unchecked) -- eligibility
   * (!inserted && !readOnly) is recomputed fresh, so this naturally
   * restores the Transformer and fieldGroup's own draggable state when
   * (and only when) the field is actually still eligible, without
   * needing a parallel "was this locked by me" flag.
   */
  const restoreFieldGeometryEditingIfEligible = (fieldId: number) => {
    const currentField = localPageFields.find((f) => f.id === fieldId);

    if (!currentField) {
      return;
    }

    renderFieldOnLayer(currentField, createFieldCanvasStyleCache());
    pageLayer.current?.batchDraw();
  };

  const signField = async (fieldId: number, payload: TSignEnvelopeFieldValue, authOptions?: TRecipientActionAuth) => {
    lockFieldGeometryEditing(fieldId);

    try {
      const { inserted } = await signFieldInternal(fieldId, payload, authOptions);

      // ?: The two callbacks below are used within the embedding context
      if (inserted && onFieldSigned) {
        const value = payload.value ? JSON.stringify(payload.value) : undefined;
        const isBase64 = value ? isBase64Image(value) : undefined;

        onFieldSigned({ fieldId, value, isBase64 });
      }

      if (!inserted && onFieldUnsigned) {
        onFieldUnsigned({ fieldId });
      }

      if (!inserted) {
        restoreFieldGeometryEditingIfEligible(fieldId);
      }
    } catch (err) {
      restoreFieldGeometryEditingIfEligible(fieldId);

      console.error(err);

      analytics.captureException(err, {
        source: 'signing',
        location: 'sign_field',
        fieldType: payload.type,
        recipientId: recipient.id,
        envelopeId: envelope.id,
      });

      toast({
        title: t`Error`,
        description: t`An error occurred while signing the field.`,
        variant: 'destructive',
      });

      throw err;
    }
  };

  /**
   * Initialize the Konva page canvas and all fields and interactions.
   */
  const createPageCanvas = (currentStage: Konva.Stage, currentPageLayer: Konva.Layer) => {
    renderFields();
    currentPageLayer.batchDraw();
  };

  /**
   * Render fields when they are changed or inserted.
   */
  useEffect(() => {
    if (!pageLayer.current || !stage.current) {
      return;
    }

    // When the pending-field tooltip toggles, all unsigned required fields need to
    // be re-rendered so their stroke color updates (green <-> orange). Field-level
    // properties like `inserted` and `customText` haven't changed, so the cache
    // would otherwise skip them — clear it to force a fresh render.
    if (prevShowPendingFieldTooltip.current !== showPendingFieldTooltip) {
      cachedRenderFields.current.clear();
      prevShowPendingFieldTooltip.current = showPendingFieldTooltip;
    }

    renderFields();

    pageLayer.current.batchDraw();
  }, [localPageFields, showPendingFieldTooltip]);

  /**
   * Rerender the whole page if the selected assistant recipient changes.
   */
  useEffect(() => {
    if (!pageLayer.current || !stage.current) {
      return;
    }

    // Rerender the whole page.
    pageLayer.current.destroyChildren();
    cachedRenderFields.current.clear();
    // The transformers destroyChildren() just destroyed are still
    // referenced here -- drop them too, or a later teardown attempt would
    // call .destroy() on an already-destroyed Konva node.
    fieldTransformers.current.clear();

    renderFields();

    pageLayer.current.batchDraw();
  }, [selectedAssistantRecipient]);

  if (!currentEnvelopeItem) {
    return null;
  }

  return (
    <>
      {showPendingFieldTooltip &&
        recipientFieldsRemaining.length > 0 &&
        recipientFieldsRemaining[0]?.envelopeItemId === currentEnvelopeItem?.id &&
        recipientFieldsRemaining[0]?.page === pageNumber && (
          <EnvelopeFieldToolTip
            key={recipientFieldsRemaining[0].id}
            field={recipientFieldsRemaining[0]}
            color="warning"
          >
            <Trans>Click to insert field</Trans>
          </EnvelopeFieldToolTip>
        )}

      {localPageOtherRecipientFields.map((field) => (
        <EnvelopeRecipientFieldTooltip
          key={field.id}
          field={field}
          showFieldStatus={true}
          showRecipientTooltip={true}
        />
      ))}

      {/* The element Konva will inject it's canvas into. */}
      <div className="konva-container absolute inset-0 z-10 w-full" ref={konvaContainer}></div>
    </>
  );
};
