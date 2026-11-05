/**
 * The object panel of a stakeholder, on the same shell as the task panel and
 * the RAID item panel: `useObjectPanelShell` + `EntityDetailView` + the
 * configurable tab strip, so it has the shared header (close, expand, back,
 * previous / next) and opens over the page like every record.
 *
 * Tabs: Details (who they are, their scores, attitude and engagement, portal
 * access, notes) and RACI (what they are responsible for). The panel host sits
 * outside the project, so the panel reads the project's grants itself.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { EllipsisVertical, Grid3x3, LayoutGrid, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import type { Stakeholder } from '@weldsuite/app-api-client/domains/project-reporting';
import {
  useObjectPanel,
  useObjectPanelShell,
  type ObjectPanelComponentProps,
  type ObjectPanelTabDescriptor,
} from '@/components/object-panel';
import { ConfigurablePanelTabs } from '@/components/objects/_shared/configurable-panel-tabs';
import { usePanelInitialTab } from '@/components/objects/_shared/use-panel-initial-tab';
import { ProjectPermissionProvider } from '@/app/weldflow/contexts/project-permission-context';
import { ListPill } from '@/app/weldflow/components/list-cells';
import { useI18n } from '@/lib/i18n/provider';
import {
  useInviteToPortal,
  useRaci,
  useRevokePortalAccess,
  useStakeholder,
} from '@/hooks/queries/use-project-reporting-queries';
import { useGovernance } from '../../_lib/use-governance';
import { intlLocaleOf } from '../../../raid/_lib/locale';
import { PersonAvatar } from '../../../raid/_components/raid-parts';
import { RemoveStakeholderDialog, StakeholderDialog, type StakeholderDialogState } from './stakeholder-dialogs';
import { STAKEHOLDER_PANEL_TYPE } from './stakeholder-panel-type';
import { ATTITUDE_PILL, ENGAGEMENT_PILL, formatContactDate, raciSubjectTitle, stakeholderName } from './stakeholder-model';

/** The task panel's width, so a stakeholder and a task opened from the page take the same room. */
const STAKEHOLDER_PANEL_WIDTH = 400;

/** The panels a person opens: a team member and a CRM person have their own. */
const TEAM_MEMBER_PANEL_TYPE = 'team-member';
const CRM_PERSON_PANEL_TYPE = 'person';

function Property({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </>
  );
}

/** The person as avatar and name; a click opens their profile on top of this panel. */
function PersonValue({ row, avatar }: Readonly<{ row: Stakeholder; avatar: string | null }>) {
  const { open } = useObjectPanel();
  const name = stakeholderName(row);
  const personId = row.kind === 'member' ? row.memberId : row.crmContactId;
  if (!name) return <span className="text-muted-foreground">—</span>;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={!personId}
      onClick={() => personId && open({ type: row.kind === 'member' ? TEAM_MEMBER_PANEL_TYPE : CRM_PERSON_PANEL_TYPE, id: personId, stack: true })}
      className="-ml-2 h-7 max-w-full justify-start gap-2 px-2 text-[13px] font-normal"
    >
      <PersonAvatar name={name} avatar={avatar} className="size-5" />
      <span className="truncate">{name}</span>
    </Button>
  );
}

/** Portal access: its state, and for a project admin the buttons that invite a client contact or take access away. */
function PortalValue({ row, canManage }: Readonly<{ row: Stakeholder; canManage: boolean }>) {
  const { t } = useI18n();
  const copy = t.flowReporting.stakeholders;
  const invite = useInviteToPortal();
  const revoke = useRevokePortalAccess();
  const pending = invite.isPending || revoke.isPending;

  const state = row.kind === 'member' ? copy.portalStates.team : row.portalAccess ? copy.portalStates.yes : copy.portalStates.none;

  const run = (action: 'invite' | 'revoke') => {
    const mutation = action === 'invite' ? invite : revoke;
    mutation.mutate(row.id, {
      onSuccess: () => toast.success(action === 'invite' ? copy.portal.invited : copy.toasts.updated),
      onError: () => toast.error(copy.saveFailed),
    });
  };

  return (
    <div className="flex flex-col items-start gap-2">
      <span>{state}</span>
      {canManage && row.kind === 'contact' ? (
        <div className="flex flex-wrap gap-1.5">
          <Button type="button" variant="outline" size="xs" disabled={pending} onClick={() => run('invite')} className="shadow-none">
            {row.portalAccess ? copy.portal.reinvite : copy.portal.invite}
          </Button>
          {row.portalAccess ? (
            <Button type="button" variant="outline" size="xs" disabled={pending} onClick={() => run('revoke')} className="shadow-none">
              {copy.portal.revoke}
            </Button>
          ) : null}
        </div>
      ) : null}
      {canManage && row.kind === 'member' ? <span className="text-xs text-muted-foreground">{copy.portal.onlyContacts}</span> : null}
    </div>
  );
}

interface DetailsTabProps {
  row: Stakeholder;
  avatar: string | null;
  canManage: boolean;
}

/** Details tab: the labelled facts of the stakeholder, then the notes. */
function DetailsTab({ row, avatar, canManage }: Readonly<DetailsTabProps>) {
  const { t, language } = useI18n();
  const copy = t.flowReporting.stakeholders;
  const text = (value: string | null | undefined) => value || <span className="text-muted-foreground">—</span>;

  return (
    <div className="pb-7">
      <dl className="mx-6 mt-4 grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 border-y py-4 text-[13px]">
        <Property label={row.kind === 'member' ? copy.form.member : copy.form.contact}>
          <PersonValue row={row} avatar={avatar} />
        </Property>
        {row.email ? <Property label={copy.detail.email}><span className="break-all">{row.email}</span></Property> : null}
        <Property label={copy.form.role}>{text(row.role)}</Property>
        <Property label={copy.form.organisation}>{text(row.organisation)}</Property>
        <Property label={copy.columns.influence}>{row.influence} / 5</Property>
        <Property label={copy.columns.interest}>{row.interest} / 5</Property>
        <Property label={copy.columns.attitude}>
          <ListPill className={ATTITUDE_PILL[row.attitude]}>{copy.attitudes[row.attitude]}</ListPill>
        </Property>
        <Property label={copy.columns.engagement}>
          <ListPill className={ENGAGEMENT_PILL[row.engagement]}>{copy.engagements[row.engagement]}</ListPill>
        </Property>
        <Property label={copy.columns.lastContact}>{text(formatContactDate(row.lastContactAt, intlLocaleOf(language)))}</Property>
        <Property label={copy.columns.portal}>
          <PortalValue row={row} canManage={canManage} />
        </Property>
      </dl>
      {row.notes ? (
        <section aria-labelledby="stakeholder-notes-title" className="px-6 pt-6">
          <h2 id="stakeholder-notes-title" className="mb-2 text-sm font-semibold">
            {copy.form.notes}
          </h2>
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/80">{row.notes}</p>
        </section>
      ) : null}
    </div>
  );
}

/** RACI tab: the rows of the matrix this person has a letter in. */
function RaciTab({ row }: Readonly<{ row: Stakeholder }>) {
  const { t } = useI18n();
  const copy = t.flowReporting.stakeholders;
  const query = useRaci(row.projectId);

  if (query.isLoading) return <InlineSpinner />;
  if (query.isError && !query.data) {
    return (
      <div className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground" role="alert">
          {copy.detail.loadFailed}
        </p>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          {t.flowGovernance.common.retry}
        </Button>
      </div>
    );
  }

  const mine = (query.data?.subjects ?? []).flatMap((subject) => {
    const letter = subject.assignments.find((assignment) => assignment.stakeholderId === row.id)?.letter;
    return letter ? [{ subject, letter }] : [];
  });
  if (mine.length === 0) return <p className="px-6 pt-5 text-sm text-muted-foreground">{copy.detail.raciNone}</p>;

  return (
    <ul className="pt-2 pb-7">
      {mine.map(({ subject, letter }) => (
        <li key={`${subject.subjectType}-${subject.subjectId ?? ''}`} className="flex items-center gap-3 border-b border-gray-200/70 px-6 py-2.5 text-[13px] dark:border-border">
          <span className="inline-flex size-6 shrink-0 items-center justify-center rounded bg-muted text-xs font-semibold" title={copy.raci.letters[letter]}>
            {letter}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{raciSubjectTitle(subject, copy.raci)}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{copy.raci.letters[letter]}</span>
        </li>
      ))}
    </ul>
  );
}

interface ActionsMenuProps {
  row: Stakeholder;
  onEdit: (row: Stakeholder) => void;
  onRemove: (row: Stakeholder) => void;
}

/** The three-dot menu of the panel header, as on every object panel. */
function ActionsMenu({ row, onEdit, onRemove }: Readonly<ActionsMenuProps>) {
  const { t } = useI18n();
  const copy = t.flowReporting.stakeholders;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
          aria-label={copy.moreActions}
        >
          <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuItem onSelect={() => onEdit(row)}>
          <Pencil aria-hidden />
          {t.flowGovernance.common.edit}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => onRemove(row)}>
          <Trash2 aria-hidden />
          {copy.form.remove}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The stakeholder could not be loaded: gone, or a failure that can be retried. */
function LoadError({ notFound, onRetry }: Readonly<{ notFound: boolean; onRetry: () => void }>) {
  const { t } = useI18n();
  const copy = t.flowReporting.stakeholders;
  return (
    <div className="space-y-3 p-4">
      <p className="text-sm text-muted-foreground" role="alert">
        {notFound ? copy.detail.notFound : copy.detail.loadFailed}
      </p>
      {notFound ? null : (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t.flowGovernance.common.retry}
        </Button>
      )}
    </div>
  );
}

type StakeholderTabId = 'details' | 'raci';

interface StakeholderTab extends ObjectPanelTabDescriptor {
  id: StakeholderTabId;
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

type StakeholderQuery = ReturnType<typeof useStakeholder>;

function StakeholderPanelView({ query, ...props }: Readonly<ObjectPanelComponentProps & { query: StakeholderQuery }>) {
  const { t } = useI18n();
  const st = useTranslations();
  const copy = t.flowReporting.stakeholders;
  const row = query.data;
  const { abilities, memberOf } = useGovernance(row?.projectId ?? '');
  const [dialog, setDialog] = useState<StakeholderDialogState | null>(null);
  const [removing, setRemoving] = useState<Stakeholder | null>(null);
  const notFound = query.isError && isApiError(query.error) && query.error.status === 404;

  const shell = useObjectPanelShell({
    ...props,
    width: STAKEHOLDER_PANEL_WIDTH,
    loading: query.isLoading && !row,
  });

  const tabs = useMemo<StakeholderTab[]>(() => {
    const shown = { defaultVisibleInPanel: true, defaultVisibleInFullscreen: true };
    return [
      { id: 'details', label: st('sweep.entities.detailsTab'), icon: LayoutGrid, required: true, ...shown },
      { id: 'raci', label: copy.detail.raciTab, icon: Grid3x3, ...shown },
    ];
  }, [st, copy.detail.raciTab]);
  const [activeTab, setActiveTab] = usePanelInitialTab<StakeholderTabId>(tabs, props.initialTab, 'details');

  const avatar = row?.memberId ? (memberOf(row.memberId)?.avatar ?? null) : null;

  return (
    <>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        title={
          row ? (
            <span className="relative top-px text-[15px] font-medium text-foreground">{stakeholderName(row) || '—'}</span>
          ) : (
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
          )
        }
        titleWrap
        actions={row && abilities.update ? <ActionsMenu row={row} onEdit={(target) => setDialog({ mode: 'edit', row: target })} onRemove={setRemoving} /> : null}
        tabs={
          <ConfigurablePanelTabs
            objectType={STAKEHOLDER_PANEL_TYPE}
            tabs={tabs}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            mode={shell.mode}
          />
        }
      >
        {!query.isLoading && !row ? <LoadError notFound={notFound} onRetry={() => void query.refetch()} /> : null}
        {row && activeTab === 'details' ? <DetailsTab row={row} avatar={avatar} canManage={abilities.manage} /> : null}
        {row && activeTab === 'raci' ? <RaciTab row={row} /> : null}
      </EntityDetailView>

      {row ? <StakeholderDialog projectId={row.projectId} state={dialog} onClose={() => setDialog(null)} /> : null}
      <RemoveStakeholderDialog row={removing} onClose={() => setRemoving(null)} onRemoved={() => props.onClose()} />
    </>
  );
}

/** The panel of a stakeholder, registered as the `stakeholder` object panel. */
export function StakeholderPanel(props: Readonly<ObjectPanelComponentProps>) {
  const query = useStakeholder(props.id);
  const projectId = query.data?.projectId ?? '';
  return (
    <ProjectPermissionProvider projectId={projectId}>
      <StakeholderPanelView {...props} query={query} />
    </ProjectPermissionProvider>
  );
}
