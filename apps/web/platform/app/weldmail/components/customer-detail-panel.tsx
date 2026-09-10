
import { useState, useEffect, useRef } from 'react';
import { usePathname } from '@/lib/router';
import { cn } from '@/lib/utils';
import { Loader2, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { CustomerDetailView } from '@/components/customer-detail';
import { useObjectPanel } from '@/components/object-panel';
import {
  usePeopleByEmails,
  useCreatePerson,
} from '@/hooks/queries/use-people-queries';
import { useI18n } from '@/lib/i18n/provider';

interface CustomerDetailPanelProps {
  email: string;
  name?: string;
  company?: string;
  phone?: string;
  notes?: string;
  customerId?: string;
  listId?: string;
  isOpen: boolean;
  onClose: () => void;
  onCompose?: (email: string) => void;
  onFieldChange?: (field: string, value: string) => void;
  topOffset?: string;
  width?: string;
  useSharedComponent?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

/**
 * Bridge a resolved person id onto the global object-panel stack.
 *
 * `PersonPanel` (via `EntityDetailView`) is an in-flow flex sibling meant to
 * be mounted by `ObjectPanelHost` next to `ModuleContent`. Rendering it
 * inline inside mail/message content parks it under the email body instead
 * of on the right — so we drive the host instead of mounting the panel here.
 */
function usePersonObjectPanelBridge({
  personId,
  isOpen,
  onClose,
}: {
  personId: string | null;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { open, closeAll, stack } = useObjectPanel();
  // Only reverse-sync after we've observed our person on the stack, so the
  // brief empty-stack window between `open()` and the jotai update doesn't
  // immediately bounce `onClose()`.
  const wasOnStackRef = useRef(false);

  useEffect(() => {
    if (!personId) return;

    if (isOpen) {
      open({ type: 'person', id: personId });
      return;
    }

    if (wasOnStackRef.current) {
      closeAll();
      wasOnStackRef.current = false;
    }
  }, [isOpen, personId, open, closeAll]);

  useEffect(() => {
    if (!isOpen || !personId) return;

    const onStack = stack.some((h) => h.type === 'person' && h.id === personId);
    if (onStack) {
      wasOnStackRef.current = true;
      return;
    }

    if (wasOnStackRef.current) {
      wasOnStackRef.current = false;
      onClose();
    }
  }, [stack, isOpen, personId, onClose]);
}

export function CustomerDetailPanel({
  email,
  name,
  customerId,
  listId,
  isOpen,
  onClose,
  onCompose,
  topOffset = '117px',
  width = '500px',
  isExpanded,
  onToggleExpand,
}: CustomerDetailPanelProps) {
  const { t } = useI18n();
  const pathname = usePathname();
  const returnUrl = encodeURIComponent(pathname);
  const createPersonMutation = useCreatePerson();

  // Resolve the email to a person via app-api when no customerId is provided.
  const shouldResolve = isOpen && !customerId && !!email;
  const peopleByEmailsQuery = usePeopleByEmails(shouldResolve ? [email] : [], shouldResolve);
  const resolvedPerson = peopleByEmailsQuery.data?.data?.[0] ?? null;

  // Auto-create a person when the resolve query finishes with no result.
  const [createdPersonId, setCreatedPersonId] = useState<string | null>(null);
  const [personLookupFailed, setPersonLookupFailed] = useState(false);
  // Track whether we have already triggered a create attempt for the current email.
  const createAttemptedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      !shouldResolve ||
      peopleByEmailsQuery.isLoading ||
      resolvedPerson ||
      createdPersonId ||
      personLookupFailed ||
      createPersonMutation.isPending ||
      createAttemptedForRef.current === email
    ) {
      return;
    }

    // Query settled, no person found — create one.
    createAttemptedForRef.current = email;
    const nameParts = (name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || email.split('@')[0] || '';
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined;

    createPersonMutation.mutate(
      { firstName, lastName, email },
      {
        onSuccess: (result) => {
          const id = result?.data?.id;
          if (id) setCreatedPersonId(id);
          else setPersonLookupFailed(true);
        },
        onError: () => setPersonLookupFailed(true),
      },
    );
  }, [
    shouldResolve,
    peopleByEmailsQuery.isLoading,
    resolvedPerson,
    createdPersonId,
    personLookupFailed,
    createPersonMutation,
    email,
    name,
  ]);

  // Reset per-email state when the panel reopens for a different email.
  useEffect(() => {
    setCreatedPersonId(null);
    setPersonLookupFailed(false);
    createAttemptedForRef.current = null;
  }, [email, isOpen]);

  const resolvedPersonId = resolvedPerson?.id ?? createdPersonId ?? null;
  const effectiveId = customerId || resolvedPersonId;

  // Detect entity type from ID prefix. Person IDs are minted via
  // `generateId('person')` (→ `person_…`); anything else is treated as a
  // customer. A missing `customerId` means we resolved the id from an email,
  // which is always a person.
  const entityType =
    effectiveId?.startsWith('person_') || !customerId ? 'contact' : 'customer';

  const personIdForBridge =
    entityType === 'contact' && effectiveId ? effectiveId : null;

  usePersonObjectPanelBridge({
    personId: personIdForBridge,
    isOpen: isOpen && !!personIdForBridge,
    onClose,
  });

  // Show loading shell while resolving person, or error if resolution failed.
  if (!effectiveId) {
    if (!isOpen) return null;
    return (
      <div
        className={cn(
          'fixed bg-background z-50 flex flex-col border-l border-border',
          'inset-0 md:inset-auto md:right-0 md:top-[60px] md:bottom-0',
          'animate-in slide-in-from-right fade-in-50 duration-300',
        )}
        style={{ width }}
      >
        <div className="flex items-center justify-between px-4 h-[56px] border-b border-border">
          {personLookupFailed ? (
            <span className="text-sm text-muted-foreground">{t.mail.customerPanel.couldNotLoadPerson}</span>
          ) : (
            <div className="flex items-center gap-2.5">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{t.mail.customerPanel.loadingPerson}</span>
            </div>
          )}
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  // People open through ObjectPanelHost (see bridge above). Nothing to mount
  // inline — mounting PersonPanel here would place it under the email body.
  if (entityType === 'contact') {
    return null;
  }

  return (
    <CustomerDetailView
      customerId={effectiveId}
      entityType={entityType}
      mode="panel"
      isOpen={isOpen}
      onClose={onClose}
      width={width}
      topOffset={topOffset}
      listId={listId}
      returnUrl={returnUrl}
      onCompose={onCompose ? () => onCompose(email) : undefined}
      isExpanded={isExpanded}
      onToggleExpand={onToggleExpand}
    />
  );
}
