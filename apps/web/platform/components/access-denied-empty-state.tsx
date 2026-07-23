
import { useMemo } from 'react';
import { EmptyStateIllustration } from '@/components/entity-list';
import { Button } from '@weldsuite/ui/components/button';
import { toast } from 'sonner';
import { usePathname } from '@/lib/router/use-pathname';
import type { AccessRequest } from '@weldsuite/core-api-client/schemas/access-requests';
import {
  useCreateAccessRequest,
  useMyPendingAccessRequests,
} from '@/hooks/queries/use-access-requests-queries';

interface AccessDeniedEmptyStateProps {
  /** One-line description, e.g. "You don't have permission to access Plans page." */
  description: string;
  /** Permission key the user is asking for, e.g. "team:read", "billing:manage". */
  permission: string;
  /** Human label of the page, used in the admin notification body. */
  pageLabel?: string;
}

export function AccessDeniedEmptyState({
  description,
  permission,
  pageLabel,
}: AccessDeniedEmptyStateProps) {
  const pathname = usePathname();
  const { mutate: requestAccess, isPending } = useCreateAccessRequest();
  const { data: pending } = useMyPendingAccessRequests();

  const alreadyRequested = useMemo(
    () => (pending ?? []).some((row: AccessRequest) => row.permission === permission),
    [pending, permission],
  );

  const handleRequestAccess = () => {
    requestAccess(
      {
        permission,
        pageLabel,
        pagePath: pathname,
      },
      {
        onSuccess: () => {
          toast.success(
            alreadyRequested
              ? 'Your request is already pending â€” admins have been reminded.'
              : 'Request sent to your workspace admin.',
          );
        },
        onError: () => {
          toast.error('Could not send your request. Please try again.');
        },
      },
    );
  };

  const buttonLabel = alreadyRequested ? 'Request pending' : 'Request access';
  const disabled = isPending || alreadyRequested;

  return (
    <div className="-mt-4 md:-mt-[72px] -mb-8 -mx-4 md:-mx-6 px-6 min-h-[calc(100vh-60px)] flex flex-col items-center justify-center text-center bg-white dark:bg-background/30">
      <EmptyStateIllustration>
        <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          {/* Shackle */}
          <path d="M42 58V42a18 18 0 0136 0v16" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="3" strokeLinecap="round" fill="none" />
          <path d="M48 58V42a12 12 0 0124 0v16" className="stroke-gray-100 dark:stroke-white/10" strokeWidth="1" fill="none" />
          {/* Lock body */}
          <rect x="28" y="58" width="64" height="44" rx="8" className="fill-white dark:fill-white/[0.03]" />
          <rect x="28" y="58" width="64" height="44" rx="8" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
          {/* Highlight stripe */}
          <rect x="28" y="58" width="64" height="6" rx="3" className="fill-gray-50 dark:fill-white/[0.04]" />
          {/* Keyhole */}
          <circle cx="60" cy="76" r="4" className="fill-gray-200 dark:fill-white/20" />
          <rect x="58" y="78" width="4" height="12" rx="2" className="fill-gray-200 dark:fill-white/20" />
        </svg>
      </EmptyStateIllustration>
      <h3 className="text-[15px] font-semibold text-foreground mb-1.5">Access Denied</h3>
      <p className="text-sm text-muted-foreground leading-relaxed whitespace-nowrap">{description}</p>
      <Button onClick={handleRequestAccess} variant="outline" className="mt-4" disabled={disabled}>
        {buttonLabel}
      </Button>
    </div>
  );
}
