/**
 * The entity's inbox address at the top of the Inbox, with a copy button. With
 * no address yet it offers to set one up through a link into Settings → Entities
 * → (entity) → WeldBooks, remembering this page so the Settings back button
 * returns here.
 */

import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Check, Copy, Mail, Settings } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { useCan } from '@weldsuite/permissions/react';
import { useEntityInbox } from '@/hooks/queries/use-weldbooks-receipts-queries';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import { useI18n } from '@/lib/i18n/provider';
import { stripWorkspacePrefix } from '@/lib/workspace-url';

/** How long "Copied" stays under the button before it clears. */
const COPY_FEEDBACK_MS = 2000;

function rememberSettingsReturn(): void {
  try {
    sessionStorage.setItem('settings-return-url', stripWorkspacePrefix(globalThis.location.pathname) || '/');
  } catch {
    // Storage blocked: the Settings back button falls back to its default.
  }
}

export function InboxAddressCard() {
  const { t } = useI18n();
  const ti = t.weldbooksReceipts.inbox;
  const { entityId } = useCurrentAccountingEntity();
  const inbox = useEntityInbox(entityId);
  const canManage = useCan('accounts:update');
  const [feedback, setFeedback] = useState<'copied' | 'failed' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const email = inbox.data?.email ?? null;
  if (!entityId || inbox.isPending || inbox.isError || !inbox.data) return null;

  const copy = async () => {
    if (!email) return;
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(email);
      setFeedback('copied');
    } catch {
      setFeedback('failed');
    }
    timer.current = setTimeout(() => setFeedback(null), COPY_FEEDBACK_MS);
  };

  return (
    <div className="px-4 pt-3" data-testid="inbox-address">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <Mail className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 space-y-0.5">
              <h2 className="text-sm font-semibold">{email ? ti.addressTitle : ti.noAddressTitle}</h2>
              {email ? (
                <>
                  <p className="break-all font-mono text-sm" data-testid="inbox-email">
                    {email}
                  </p>
                  <p className="text-xs text-muted-foreground">{ti.addressHint}</p>
                  <p className="text-xs text-muted-foreground">
                    {inbox.data.workspaceAddress ? `${ti.workspaceAddress} ` : ''}
                    {inbox.data.autoScanEnabled ? ti.autoScanOn : ti.autoScanOff}
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">{ti.noAddressHint}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {email ? (
              <span className="relative inline-flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => void copy()} aria-label={`${ti.copy}: ${email}`}>
                  {feedback === 'copied' ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
                  {ti.copy}
                </Button>
                {/* The feedback is its own live region, outside the button, so it is announced. */}
                <span role="status" className="text-xs text-muted-foreground" data-testid="copy-feedback">
                  {feedback === 'copied' ? ti.copied : feedback === 'failed' ? ti.copyFailed : ''}
                </span>
              </span>
            ) : null}
            {canManage ? (
              <Button asChild variant={email ? 'ghost' : 'default'} size="sm">
                <Link to="/settings/entities/$id/edit" params={{ id: entityId }} search={{ tab: 'weldbooks' }} onClick={rememberSettingsReturn}>
                  <Settings className="h-4 w-4" aria-hidden />
                  {email ? ti.manage : ti.setUp}
                </Link>
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
