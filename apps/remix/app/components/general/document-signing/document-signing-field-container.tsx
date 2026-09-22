import { DO_NOT_INVALIDATE_QUERY_ON_MUTATION } from '@documenso/lib/constants/trpc';
import type { TRecipientActionAuth } from '@documenso/lib/types/document-auth';
import { ZFieldMetaSchema } from '@documenso/lib/types/field-meta';
import type { FieldWithSignature } from '@documenso/prisma/types/field-with-signature';
import { trpc } from '@documenso/trpc/react';
import type { FieldGeometry } from '@documenso/ui/components/field/field';
import { FieldRootContainer } from '@documenso/ui/components/field/field';
import { getRecipientColorStyles } from '@documenso/ui/lib/recipient-colors';
import { cn } from '@documenso/ui/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@documenso/ui/primitives/tooltip';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Trans } from '@lingui/react/macro';
import { FieldType } from '@prisma/client';
import { TooltipArrow } from '@radix-ui/react-tooltip';
import { GripVertical, X } from 'lucide-react';
import type React from 'react';

import { useRequiredDocumentSigningAuthContext } from './document-signing-auth-provider';
import { useDocumentSigningRecipientContext } from './document-signing-recipient-provider';

export type DocumentSigningFieldContainerProps = {
  field: FieldWithSignature;
  loading?: boolean;
  children: React.ReactNode;

  /**
   * A function that is called before the field requires to be signed, or reauthed.
   *
   * Example, you may want to show a dialog prior to signing where they can enter a value.
   *
   * Once that action is complete, you will need to call `executeActionAuthProcedure` to proceed
   * regardless if it requires reauth or not.
   *
   * If the function returns true, we will proceed with the signing process. Otherwise if
   * false is returned we will not proceed.
   */
  onPreSign?: () => Promise<boolean> | boolean;

  /**
   * The function required to be executed to insert the field.
   *
   * The auth values will be passed in if available.
   */
  onSign?: (documentAuthValue?: TRecipientActionAuth) => Promise<void> | void;
  onRemove?: (fieldType?: string) => Promise<void> | void;
  type?: 'Date' | 'Initials' | 'Email' | 'Name' | 'Signature' | 'Text' | 'Radio' | 'Dropdown' | 'Number' | 'Checkbox';
  tooltipText?: string | null;
};

export const DocumentSigningFieldContainer = ({
  field,
  loading,
  onPreSign,
  onSign,
  onRemove,
  children,
  type,
  tooltipText,
}: DocumentSigningFieldContainerProps) => {
  const { executeActionAuthProcedure, isAuthRedirectRequired } = useRequiredDocumentSigningAuthContext();
  const { recipient } = useDocumentSigningRecipientContext();
  const { toast } = useToast();

  const { mutateAsync: repositionFieldWithToken } = trpc.field.repositionFieldWithToken.useMutation(
    DO_NOT_INVALIDATE_QUERY_ON_MUTATION,
  );

  const parsedFieldMeta = field.fieldMeta ? ZFieldMetaSchema.parse(field.fieldMeta) : undefined;
  const readOnlyField = parsedFieldMeta?.readOnly || false;

  // A recipient may reposition/resize their own field only up until it's
  // finalized -- once `inserted`, geometry is locked (server-enforced
  // independently; this only avoids rendering controls for an action that
  // would be rejected anyway).
  const isFieldEditable = !field.inserted && !loading && !readOnlyField;

  const handleReposition = async (geometry: FieldGeometry) => {
    try {
      await repositionFieldWithToken({
        token: recipient.token,
        fieldId: field.id,
        ...geometry,
      });
    } catch {
      toast({
        title: 'Could not save field position',
        description: "Your change to this field's position or size could not be saved. Please try again.",
        variant: 'destructive',
      });
    }
  };

  const handleInsertField = async () => {
    if (field.inserted || !onSign) {
      return;
    }

    // Bypass reauth for non signature fields.
    if (field.type !== FieldType.SIGNATURE) {
      const presignResult = await onPreSign?.();

      if (presignResult === false) {
        return;
      }

      await onSign();
      return;
    }

    if (isAuthRedirectRequired) {
      await executeActionAuthProcedure({
        onReauthFormSubmit: () => {
          // Do nothing since the user should be redirected.
        },
        actionTarget: field.type,
      });

      return;
    }

    // Handle any presign requirements, and halt if required.
    if (onPreSign) {
      const preSignResult = await onPreSign();

      if (preSignResult === false) {
        return;
      }
    }

    await executeActionAuthProcedure({
      onReauthFormSubmit: onSign,
      actionTarget: field.type,
    });
  };

  const onRemoveSignedFieldClick = async () => {
    if (!field.inserted) {
      return;
    }

    await onRemove?.();
  };

  const onClearCheckBoxValues = async (fieldType?: string) => {
    if (!field.inserted) {
      return;
    }

    await onRemove?.(fieldType);
  };

  // Purely a mouse/touch drag affordance for react-rnd -- there is no
  // keyboard equivalent for dragging in this implementation, so this is
  // intentionally excluded from the accessibility tree (aria-hidden)
  // rather than given a misleading interactive role. It also sits
  // entirely outside the insert button's own bounds (negative offset vs.
  // that button's `inset-0`), so the two never share a hit area at all.
  // Passed via FieldRootContainer's `dragHandle` prop rather than as a
  // plain child: a plain child would render *inside* #field-{id}, which
  // sets its own position+z-index and so traps any descendant's z-index
  // inside its own stacking context -- no z-index on a nested drag
  // handle could ever out-rank a SIBLING of #field-{id} (like the
  // field's own resize handles, z-30). Rendering it as a true sibling
  // instead lets its z-40 actually mean something against those.
  const dragHandle = isFieldEditable && (
    <div
      aria-hidden="true"
      className="field-drag-handle absolute -top-3 -left-3 z-40 flex h-6 w-6 cursor-move items-center justify-center rounded-full border bg-background shadow-sm"
      title="Drag to reposition"
    >
      <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
    </div>
  );

  return (
    <FieldRootContainer
      color={getRecipientColorStyles(field.fieldMeta?.readOnly ? 'readOnly' : 0)}
      field={field}
      editable={isFieldEditable}
      onReposition={isFieldEditable ? handleReposition : undefined}
      dragHandle={dragHandle}
    >
      {!field.inserted && !loading && !readOnlyField && (
        <button
          type="submit"
          className="absolute inset-0 z-10 h-full w-full rounded-[2px]"
          onClick={async () => handleInsertField()}
        />
      )}

      {type === 'Checkbox' && field.inserted && !loading && !readOnlyField && (
        <button
          className="absolute -bottom-10 flex items-center justify-evenly rounded-md border bg-gray-900 opacity-0 group-hover:opacity-100"
          onClick={() => void onClearCheckBoxValues(type)}
        >
          <span className="rounded-md p-1 text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-100">
            <X className="h-4 w-4" />
          </span>
        </button>
      )}

      {type !== 'Checkbox' && field.inserted && !loading && !readOnlyField && (
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <button className="absolute inset-0 z-10" onClick={onRemoveSignedFieldClick}></button>
          </TooltipTrigger>

          <TooltipContent className="border-0 bg-orange-300 fill-orange-300 text-orange-900" sideOffset={2}>
            {tooltipText && <p>{tooltipText}</p>}

            <Trans>Remove</Trans>
            <TooltipArrow />
          </TooltipContent>
        </Tooltip>
      )}

      {(field.type === FieldType.RADIO || field.type === FieldType.CHECKBOX) && field.fieldMeta?.label && (
        <div
          className={cn(
            'absolute -top-16 right-0 left-0 rounded-md p-2 text-center text-gray-700 text-xs',
            {
              'border border-border bg-foreground/5': !field.inserted,
            },
            {
              'border border-primary bg-documenso-200': field.inserted,
            },
          )}
        >
          {field.fieldMeta.label}
        </div>
      )}

      {children}
    </FieldRootContainer>
  );
};
