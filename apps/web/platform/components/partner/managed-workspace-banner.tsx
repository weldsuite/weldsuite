/**
 * Notices for members of a partner-managed workspace:
 *  - read-only: the partner (or the licence) is suspended, changes are paused;
 *  - partner past due: the partner has an overdue payment, workspaces still work.
 *
 * A floating card instead of a bar, so it never changes the height the module
 * pages are laid out in. The read-only notice cannot be dismissed.
 */

import { useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { TriangleAlert, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useManagedBilling } from '@/hooks/queries/use-partner-queries';
import { useI18n } from '@/lib/i18n/provider';
import { safeHttpUrl } from '@/lib/partner/safe-url';
import { cn } from '@/lib/utils';
import { supportMailto } from './partner-contact';

const DISMISS_KEY = 'weldsuite:partner-past-due-dismissed';

function wasDismissed(orgId: string | null | undefined): boolean {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === (orgId ?? '');
  } catch {
    // sessionStorage unavailable — show the notice every time.
    return false;
  }
}

function rememberDismissed(orgId: string | null | undefined): void {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, orgId ?? '');
  } catch {
    // Non-fatal: the notice just comes back on the next page load.
  }
}

export function ManagedWorkspaceBanner() {
  const { t, format } = useI18n();
  const { orgId } = useAuth();
  const { data: info } = useManagedBilling();
  const [dismissedNow, setDismissedNow] = useState(false);

  if (!info) return null;

  const readOnly = info.readOnly;
  const pastDue = !readOnly && info.partnerStatus === 'past_due';
  if (!readOnly && !pastDue) return null;
  if (pastDue && (dismissedNow || wasDismissed(orgId))) return null;

  const tb = t.partner.workspaceBanner;
  const { partner } = info;
  const contactHref = partner.supportEmail
    ? supportMailto(partner.supportEmail)
    : safeHttpUrl(partner.supportUrl) ?? safeHttpUrl(partner.websiteUrl);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
      <div
        role={readOnly ? 'alert' : 'status'}
        data-testid="managed-workspace-banner"
        className={cn(
          'pointer-events-auto flex w-full max-w-2xl items-start gap-3 rounded-xl border p-4 text-sm shadow-lg',
          readOnly
            ? 'border-destructive/40 bg-background text-foreground'
            : 'border-amber-500/40 bg-background text-foreground',
        )}
      >
        <TriangleAlert
          className={cn('mt-0.5 h-4 w-4 shrink-0', readOnly ? 'text-destructive' : 'text-amber-600 dark:text-amber-400')}
          aria-hidden
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium">
            {readOnly ? tb.readOnlyTitle : format(tb.pastDueTitle, { partner: partner.name })}
          </p>
          <p className="text-muted-foreground">
            {format(readOnly ? tb.readOnlyBody : tb.pastDueBody, { partner: partner.name })}
          </p>
          {contactHref && (
            <a
              href={contactHref}
              {...(contactHref.startsWith('mailto:') ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
              className="inline-block font-medium underline underline-offset-2"
            >
              {format(tb.contact, { partner: partner.name })}
            </a>
          )}
        </div>
        {pastDue && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            aria-label={tb.dismiss}
            onClick={() => {
              rememberDismissed(orgId);
              setDismissedNow(true);
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
