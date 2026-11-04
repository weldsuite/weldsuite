import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { usePermissions } from '@weldsuite/permissions/react';
import type { ProjectRequest } from '@weldsuite/app-api-client/domains/flow-portfolio';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n/provider';
import {
  useIntakeFunnel,
  useIntakeSettings,
  useMemberNames,
  useProjectRequests,
} from '@/hooks/queries/use-flow-portfolio-queries';
import { DetailPanel } from './_components/detail-panel';
import { ModelCard } from './_components/model-card';
import { CreateProjectDialog, RequestFormDialog } from './_components/request-dialogs';
import { FunnelStrip, RequestTable } from './_components/request-table';
import { visibleRequests } from './_lib/intake';

/** Intake: requests ranked by score, the request in focus, and the scoring model beside it. */
export default function IntakePage() {
  const { t } = useI18n();
  const copy = t.flowPortfolio.intake;
  const { can } = usePermissions();
  const { userId } = useAuth();
  const canManage = can('portfolio:manage');
  const requests = useProjectRequests();
  const funnel = useIntakeFunnel();
  const settings = useIntakeSettings();
  const { nameOf, options } = useMemberNames();
  const [selected, setSelected] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);
  const [form, setForm] = useState<{ open: boolean; request: ProjectRequest | null }>({ open: false, request: null });
  const [converting, setConverting] = useState<ProjectRequest | null>(null);

  const shown = visibleRequests(requests.data ?? [], showRejected);
  const current = selected ?? shown[0]?.id ?? null;
  const onBoard = !!userId && (settings.data?.portfolioBoardIds ?? []).includes(userId);

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">{copy.title}</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">{copy.subtitle}</p>
        </div>
        <Button onClick={() => setForm({ open: true, request: null })}>
          <Plus className="size-4" />
          {copy.newRequest}
        </Button>
      </div>

      {funnel.data ? <FunnelStrip funnel={funnel.data} /> : null}

      {requests.isError ? (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/30 p-4 text-sm">
          {t.flowPortfolio.common.loadFailed}
          <Button variant="outline" size="sm" onClick={() => void requests.refetch()}>
            {t.flowPortfolio.common.retry}
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-[999_1_640px]">
          {requests.isLoading ? (
            <Skeleton className="h-64 rounded-lg" />
          ) : (
            <RequestTable requests={shown} selectedId={current} onSelect={setSelected} showRejected={showRejected} onShowRejected={setShowRejected} nameOf={nameOf} />
          )}
        </div>
        <div className="flex max-w-[400px] min-w-0 flex-[1_1_340px] flex-col gap-4">
          <DetailPanel
            requestId={current}
            settings={settings.data}
            canScore={canManage || onBoard}
            canChange={(requestedBy) => canManage || requestedBy === userId}
            nameOf={nameOf}
            onEdit={(request) => setForm({ open: true, request })}
            onCreateProject={setConverting}
            onDeleted={() => setSelected(null)}
          />
          {settings.data ? <ModelCard settings={settings.data} canEdit={canManage} nameOf={nameOf} people={options} /> : null}
        </div>
      </div>

      <RequestFormDialog open={form.open} request={form.request} onClose={() => setForm({ open: false, request: null })} onSaved={setSelected} />
      <CreateProjectDialog request={converting} onClose={() => setConverting(null)} />
    </div>
  );
}
