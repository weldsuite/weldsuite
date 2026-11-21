/**
 * Public links to a report or dashboard: make one (embeddable or not, with
 * or without a date picker, with an expiry), copy it and the iframe code
 * while it is shown (only once), and see and revoke the links that exist.
 * When the API refuses because people data would leave, it says which
 * report and why.
 */

import { useState } from 'react';
import { Link2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import type { PanelCreatedShareLinkDto, PanelNotShareableDetails, PanelShareLinkDto, PanelTargetParams } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Separator } from '@weldsuite/ui/components/separator';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Switch } from '@weldsuite/ui/components/switch';
import { useCreateWeldPanelShareLink, useRevokeWeldPanelShareLink, useWeldPanelShareLinks } from '@/hooks/queries/use-weldpanel-collab-queries';
import { useI18n } from '@/lib/i18n/provider';
import { daysFromNow } from '../lib/date-input';
import { formatDate, formatNumber } from '../lib/format';
import { iframeSnippet, shareLinkState, shareRefusals } from '../lib/share';
import { CopyBlock } from './copy-block';
import { useMembers } from './use-members';

type Expiry = 'never' | 'd7' | 'd30' | 'd90';
const EXPIRY_DAYS: Record<Exclude<Expiry, 'never'>, number> = { d7: 7, d30: 30, d90: 90 };

export interface ShareTarget extends PanelTargetParams {
  name: string;
  ownerUserId: string;
  visibility: 'private' | 'workspace';
  /** Report names, to say which report of a dashboard cannot be shared. */
  reportNames?: ReadonlyMap<string, string>;
}

function LinkRow({ link, canRevoke, onRevoke }: Readonly<{ link: PanelShareLinkDto; canRevoke: boolean; onRevoke: () => void }>) {
  const { t, language, format } = useI18n();
  const ts = t.weldpanel.collab.share;
  const state = shareLinkState(link);
  const details = [
    format(ts.views, { count: formatNumber(link.viewCount, language) }),
    link.lastViewedAt ? format(ts.lastViewed, { date: formatDate(link.lastViewedAt, language) }) : null,
    link.expiresAt && state === 'active' ? format(ts.expires, { date: formatDate(link.expiresAt, language) }) : null,
  ].filter(Boolean);
  let badge = <SoftBadge tone="success">{ts.active}</SoftBadge>;
  if (state === 'revoked') badge = <SoftBadge tone="neutral">{ts.revoked}</SoftBadge>;
  else if (state === 'expired') badge = <SoftBadge tone="warning">{ts.expired}</SoftBadge>;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
      <Link2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <code className="font-mono text-sm">{link.prefix}…</code>
      {badge}
      {link.allowEmbed && <SoftBadge tone="neutral">{ts.embed}</SoftBadge>}
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">{details.join(' · ')}</span>
      {canRevoke && state === 'active' && (
        <Button type="button" size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={onRevoke}>
          {ts.revoke}
        </Button>
      )}
    </li>
  );
}

/** The links and the "create" form; the body of the share dialog and of the report side panel's Share tab. */
export function SharePanel({ target }: Readonly<{ target: ShareTarget }>) {
  const { t } = useI18n();
  const ts = t.weldpanel.collab.share;
  const tc = t.weldpanel.analytics.common;
  const canCreate = useCan('panel_reports:create');
  const canDelete = useCan('panel_reports:delete');
  const canManage = useCan('panel_projects:manage');
  const { me } = useMembers();
  const params = { targetType: target.targetType, targetId: target.targetId };
  const { data: links, isLoading, isError, refetch } = useWeldPanelShareLinks(params);
  const create = useCreateWeldPanelShareLink();
  const revoke = useRevokeWeldPanelShareLink(params);
  const [allowEmbed, setAllowEmbed] = useState(false);
  const [allowDateChange, setAllowDateChange] = useState(true);
  const [expiry, setExpiry] = useState<Expiry>('never');
  const [created, setCreated] = useState<PanelCreatedShareLinkDto | null>(null);
  const [refused, setRefused] = useState<PanelNotShareableDetails['reasons'] | null>(null);
  const [revoking, setRevoking] = useState<PanelShareLinkDto | null>(null);

  const owner = target.ownerUserId === me;
  const mayShare = canCreate && (owner || (target.visibility === 'workspace' && canManage));

  async function submit() {
    setRefused(null);
    setCreated(null);
    try {
      const link = await create.mutateAsync({
        ...params,
        allowEmbed,
        allowDateChange,
        expiresAt: expiry === 'never' ? null : daysFromNow(EXPIRY_DAYS[expiry]),
      });
      setCreated(link);
      toast.success(ts.created);
    } catch (error) {
      const reasons = shareRefusals(error);
      if (reasons) setRefused(reasons);
      else toast.error(isApiError(error) && error.status === 403 ? ts.noPermission : ts.failed);
    }
  }

  const reportName = (reportId: string) => (target.targetType === 'report' && reportId === target.targetId ? target.name : (target.reportNames?.get(reportId) ?? ts.reportFallback));

  return (
    <div className="grid gap-4">
      {mayShare ? (
        <div className="grid gap-3 rounded-lg border p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Label htmlFor="weldpanel-share-embed">{ts.embedLabel}</Label>
              <p className="text-xs text-muted-foreground">{ts.embedHint}</p>
            </div>
            <Switch id="weldpanel-share-embed" checked={allowEmbed} onCheckedChange={setAllowEmbed} />
          </div>
          <div className="flex items-start justify-between gap-3">
            <div>
              <Label htmlFor="weldpanel-share-dates">{ts.dateChangeLabel}</Label>
              <p className="text-xs text-muted-foreground">{ts.dateChangeHint}</p>
            </div>
            <Switch id="weldpanel-share-dates" checked={allowDateChange} onCheckedChange={setAllowDateChange} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Label htmlFor="weldpanel-share-expiry">{ts.expiryLabel}</Label>
            <Select value={expiry} onValueChange={(value) => setExpiry(value as Expiry)}>
              <SelectTrigger id="weldpanel-share-expiry" size="sm" className="h-8 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['never', 'd7', 'd30', 'd90'] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    {ts.expiry[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end">
            <Button type="button" size="sm" disabled={create.isPending} onClick={() => void submit()}>
              {create.isPending && <Loader2 className="animate-spin" />}
              {ts.create}
            </Button>
          </div>
        </div>
      ) : (
        <InfoBanner variant="neutral">{ts.noPermission}</InfoBanner>
      )}

      {refused && (
        <InfoBanner variant="danger" title={ts.refusedTitle}>
          <p>{ts.refusedDescription}</p>
          <ul className="mt-1 list-disc pl-5">
            {refused.map((reason) => (
              <li key={`${reason.reportId}:${reason.reason}`}>
                <span className="font-medium">{reportName(reason.reportId)}</span>: {ts.reasons[reason.reason]}
              </li>
            ))}
          </ul>
        </InfoBanner>
      )}

      {created && (
        <div className="grid gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3">
          <div>
            <p className="text-sm font-medium">{ts.onceTitle}</p>
            <p className="text-xs text-muted-foreground">{ts.onceDescription}</p>
          </div>
          <CopyBlock title={ts.linkLabel} value={created.url} />
          {created.allowEmbed && <CopyBlock title={ts.iframeLabel} value={iframeSnippet(created.url, target.name)} />}
        </div>
      )}

      <Separator />
      <div>
        <h3 className="text-sm font-medium">{ts.links}</h3>
        {isLoading && <Skeleton className="mt-2 h-10 w-full" />}
        {isError && (
          <InlineError>
            {ts.loadFailed}{' '}
            <button type="button" className="underline underline-offset-2" onClick={() => void refetch()}>
              {t.weldpanel.retry}
            </button>
          </InlineError>
        )}
        {!isLoading && !isError && (links ?? []).length === 0 && <EmptyText>{ts.empty}</EmptyText>}
        {links && links.length > 0 && (
          <ul className="divide-y">
            {links.map((link) => (
              <LinkRow
                key={link.id}
                link={link}
                canRevoke={canDelete && (link.createdByUserId === me || owner || (target.visibility === 'workspace' && canManage))}
                onRevoke={() => setRevoking(link)}
              />
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={ts.revokeTitle}
        description={ts.revokeDescription}
        confirmLabel={ts.revoke}
        cancelLabel={tc.cancel}
        variant="destructive"
        onConfirm={async () => {
          if (!revoking) return;
          try {
            await revoke.mutateAsync(revoking.id);
            toast.success(ts.revokedToast);
            setRevoking(null);
          } catch {
            toast.error(ts.revokeFailed);
          }
        }}
      />
    </div>
  );
}

export function ShareDialog({ open, onOpenChange, target }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; target: ShareTarget }>) {
  const { t, format } = useI18n();
  const ts = t.weldpanel.collab.share;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{format(ts.title, { name: target.name })}</DialogTitle>
          <DialogDescription>{ts.description}</DialogDescription>
        </DialogHeader>
        {open && <SharePanel target={target} />}
      </DialogContent>
    </Dialog>
  );
}
