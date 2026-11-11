/**
 * WeldDesk phone settings: what happens to calls to each number. A number's
 * route rings the agents (with a queue and a voicemail), plays a keypad menu,
 * takes a voicemail, hands the call to an AI voice agent, forwards it or hangs
 * up. Routes are edited per number in a side sheet (`phone-route-editor.tsx`).
 */

import { useMemo, useState } from 'react';
import { Loader2, Pencil, Phone } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Link } from '@/lib/router';
import { getTranslations } from '@/lib/i18n';
import {
  useDeskPhoneNumbers,
  useDeskPhoneRoutes,
  useDeskPhoneVoiceAgents,
  useSyncDeskPhoneNumbers,
  type DeskPhoneNumber,
} from '@/hooks/queries/use-desk-phone-settings-queries';
import { useDeskTeams } from '@/hooks/queries/use-desk-routing-queries';
import { PhoneRouteEditor } from './phone-route-editor';
import { summarizeRoute } from './phone-route-summary';

export function PhoneSettingsClient() {
  const i18n = getTranslations('helpdesk');
  const tp = i18n.phoneSettingsPage;
  const t = i18n.phoneSettings;
  const canEdit = useCan('settings:manage');
  const numbers = useDeskPhoneNumbers();
  const routes = useDeskPhoneRoutes();
  const agents = useDeskPhoneVoiceAgents();
  const teams = useDeskTeams();
  const sync = useSyncDeskPhoneNumbers();
  const [editing, setEditing] = useState<DeskPhoneNumber | null>(null);

  const routeByNumber = useMemo(
    () => new Map((routes.data ?? []).map((route) => [route.voipPhoneNumberId, route])),
    [routes.data],
  );
  const lookups = useMemo(() => {
    const teamNames = new Map((teams.data ?? []).map((team) => [team.id, team.name]));
    const agentNames = new Map((agents.data ?? []).map((agent) => [agent.id, agent.name]));
    return { teamName: (id: string) => teamNames.get(id), agentName: (id: string) => agentNames.get(id) };
  }, [teams.data, agents.data]);

  const runSync = async () => {
    try {
      const res = await sync.mutateAsync();
      toast.success(tp.synced.replace('{count}', String(res.data?.count ?? 0)));
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : tp.syncFailed);
    }
  };

  let body: React.ReactNode;
  if (numbers.isLoading || routes.isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (numbers.isError || routes.isError) {
    body = (
      <ErrorState
        message={t.list.loadError}
        onRetry={() => {
          void numbers.refetch();
          void routes.refetch();
        }}
      />
    );
  } else if (!numbers.data || numbers.data.length === 0) {
    body = (
      <EmptyState
        icon={Phone}
        title={tp.emptyTitle}
        description={
          <>
            {tp.provisionPrefix}{' '}
            <Link href="/settings/apps/phone-numbers" className="underline underline-offset-2">
              {tp.phoneNumbersLink}
            </Link>
            {tp.provisionSuffix}
          </>
        }
      />
    );
  } else {
    body = (
      <ul className="divide-y rounded-lg border" data-testid="phone-number-list">
        {numbers.data.map((number) => {
          const name = number.displayName || number.phoneNumber;
          return (
            <li key={number.id} className="flex flex-wrap items-center gap-3 p-4 sm:flex-nowrap" data-testid="phone-number-row">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="truncate font-medium">{name}</span>
                  {number.displayName && <span className="text-sm text-muted-foreground">{number.phoneNumber}</span>}
                </div>
                <p className="text-sm text-muted-foreground" data-testid="phone-route-summary">
                  {summarizeRoute(routeByNumber.get(number.id), lookups, t.summary)}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing(number)}
                aria-label={t.list.editFor.replace('{name}', name)}
              >
                <Pencil className="mr-1.5 h-4 w-4" />
                {t.list.edit}
              </Button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-6" data-testid="phone-settings">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{tp.title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{tp.description}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link href="/settings/apps/welddesk/voice-agents">{tp.voiceAgents}</Link>
            </Button>
            <Button variant="outline" onClick={() => void runSync()} disabled={sync.isPending}>
              {sync.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {tp.syncNumbers}
            </Button>
          </div>
        </div>

        <InfoBanner variant="info" title={t.banner.title}>
          <ul className="list-disc space-y-1 pl-5" data-testid="phone-ring-help">
            <li>{t.banner.ring}</li>
            <li>{t.banner.takeCalls}</li>
            <li>{t.banner.voicemail}</li>
            <li>{t.banner.metering}</li>
            <li>{t.banner.voice}</li>
          </ul>
        </InfoBanner>

        {body}
      </div>

      <PhoneRouteEditor
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        number={editing}
        route={editing ? routeByNumber.get(editing.id) : undefined}
        teams={teams.data ?? []}
        agents={agents.data ?? []}
        canEdit={canEdit}
      />
    </div>
  );
}

export default function PhoneSettingsPage() {
  return <PhoneSettingsClient />;
}
