/**
 * WeldDesk → Problems → one problem (TASK-1231): status, owner and team, the
 * description / root cause / workaround / resolution texts (saved with the
 * Save button), the linked tickets, sharing the workaround with them, the
 * help-center article and deleting.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BookOpen, Send, Trash2 } from 'lucide-react';
import { isApiError } from '@weldsuite/api-client';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FieldGrid } from '@weldsuite/ui/components/field-grid';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { DetailHeader, DetailPage } from '@weldsuite/ui/components/page-layout';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { getTranslations } from '@/lib/i18n';
import { Link, useParams, useRouter } from '@/lib/router';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { DESK_PRIORITIES, useDeskAttributeOptions, type DeskPriority } from '@/hooks/queries/use-desk-queries';
import { useDeskWorkspaceMembers } from '@/hooks/queries/use-desk-workspace-members';
import { deskLinkErrorMessage, deskLinkRefusal } from '@/hooks/queries/use-desk-link-queries';
import {
  DESK_PROBLEM_STATUSES,
  useCreateDeskProblemArticle,
  useDeleteDeskProblem,
  useDeskProblem,
  useUpdateDeskProblem,
  type DeskProblem,
  type DeskProblemStatus,
  type DeskProblemUpdate,
} from '@/hooks/queries/use-desk-problem-queries';
import { PickOne } from '../../inbox/ticket-fields';
import { ProblemIncidentsCard } from '../problem-incidents-card';
import { ProblemStatusBadge } from '../problem-status-badge';
import { ShareWorkaroundDialog } from '../share-workaround-dialog';

const TEXT_FIELDS = ['description', 'rootCause', 'workaround', 'resolution'] as const;
type TextField = (typeof TEXT_FIELDS)[number];

interface Draft {
  title: string;
  description: string;
  rootCause: string;
  workaround: string;
  resolution: string;
}

const draftOf = (problem: DeskProblem): Draft => ({
  title: problem.title,
  description: problem.description ?? '',
  rootCause: problem.rootCause ?? '',
  workaround: problem.workaround ?? '',
  resolution: problem.resolution ?? '',
});

/** The fields of the texts the agent changed, as a patch (an emptied text clears the field). */
function draftPatch(saved: Draft, draft: Draft): DeskProblemUpdate {
  const patch: DeskProblemUpdate = {};
  if (draft.title !== saved.title) patch.title = draft.title.trim();
  for (const field of TEXT_FIELDS) {
    if (draft[field] !== saved[field]) patch[field] = draft[field].trim() === '' ? null : draft[field];
  }
  return patch;
}

function formatDateTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

type ProblemLabels = ReturnType<typeof getTranslations<'deskProblems'>>;

/**
 * The texts being edited: the problem they belong to, the server values they
 * were loaded from (`baseline`: what "changed" is measured against) and the
 * edited copy.
 */
interface DraftState {
  problemId: string;
  baseline: Draft;
  draft: Draft;
}

const freshDraft = (problem: DeskProblem): DraftState => {
  const baseline = draftOf(problem);
  return { problemId: problem.id, baseline, draft: baseline };
};

const changedFields = (state: DraftState): (keyof Draft)[] =>
  (Object.keys(state.baseline) as (keyof Draft)[]).filter((key) => state.draft[key] !== state.baseline[key]);

/**
 * The state after the server sent `problem`: another problem starts from
 * scratch (nothing of the previous draft carries over); the same one follows
 * the server in every text the agent has not touched, and never overwrites
 * what is being typed.
 */
function followServer(problem: DeskProblem, current: DraftState | null): DraftState {
  if (current?.problemId !== problem.id) return freshDraft(problem);
  const baseline = draftOf(problem);
  const draft: Draft = { ...baseline };
  for (const key of changedFields(current)) draft[key] = current.draft[key];
  return { problemId: problem.id, baseline, draft };
}

/** Why a change was refused, in the reader's language, else the server's message, else `fallback`. */
function refusalMessage(refusals: ProblemLabels['refusals'], err: unknown, fallback: string): string {
  const reason = deskLinkRefusal(err);
  const known = reason ? (refusals as Record<string, string>)[reason] : undefined;
  return known ?? deskLinkErrorMessage(err) ?? fallback;
}

/** The dates a problem has reached, for the details grid. */
function problemDates(problem: DeskProblem, fields: ProblemLabels['detail']['fields']) {
  return [
    { label: fields.created, value: formatDateTime(problem.createdAt) },
    ...(problem.knownErrorAt ? [{ label: fields.knownError, value: formatDateTime(problem.knownErrorAt) }] : []),
    ...(problem.resolvedAt ? [{ label: fields.resolved, value: formatDateTime(problem.resolvedAt) }] : []),
    ...(problem.closedAt ? [{ label: fields.closed, value: formatDateTime(problem.closedAt) }] : []),
  ];
}

/** The page when the problem did not load: gone (back to the list) or failed (try again). */
function ProblemLoadError({
  error,
  t,
  onBack,
  onRetry,
}: Readonly<{ error: unknown; t: ProblemLabels; onBack: () => void; onRetry: () => void }>) {
  const missing = isApiError(error) && error.status === 404;
  return (
    <DetailPage>
      <ErrorState
        message={missing ? t.detail.notFound : t.detail.loadError}
        onRetry={missing ? onBack : onRetry}
        retryLabel={missing ? t.detail.back : t.list.retry}
      />
    </DetailPage>
  );
}

interface ProblemActionsProps {
  problem: DeskProblem;
  t: ProblemLabels;
  canUpdate: boolean;
  /** Sharing writes a note or reply on the linked tickets: problems:update and conversations:update. */
  canShare: boolean;
  canDelete: boolean;
  canWriteArticle: boolean;
  updating: boolean;
  creatingArticle: boolean;
  onStatus: (status: DeskProblemStatus) => void;
  onShare: () => void;
  onWriteArticle: () => void;
  onDelete: () => void;
}

/** The header's actions: the status, sharing the workaround, the help-center article and deleting. */
function ProblemActions({
  problem,
  t,
  canUpdate,
  canShare,
  canDelete,
  canWriteArticle,
  updating,
  creatingArticle,
  onStatus,
  onShare,
  onWriteArticle,
  onDelete,
}: Readonly<ProblemActionsProps>) {
  const td = t.detail;
  return (
    <>
      <Select value={problem.status} onValueChange={(value) => onStatus(value as DeskProblemStatus)} disabled={!canUpdate || updating}>
        <SelectTrigger className="h-8 w-[160px]" aria-label={td.statusLabel} data-testid="desk-problem-status-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DESK_PROBLEM_STATUSES.map((status) => (
            <SelectItem key={status} value={status}>
              {t.status[status]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {canShare && (
        <Button variant="outline" size="sm" onClick={onShare} data-testid="desk-problem-share-open">
          <Send className="mr-1.5 h-4 w-4" />
          {td.actions.share}
        </Button>
      )}
      {problem.articleId ? (
        <Button variant="outline" size="sm" asChild>
          <Link href={`/welddesk/help-center/articles/${problem.articleId}/edit`}>
            <BookOpen className="mr-1.5 h-4 w-4" />
            {td.actions.openArticle}
          </Link>
        </Button>
      ) : (
        canWriteArticle && (
          <Button variant="outline" size="sm" onClick={onWriteArticle} disabled={creatingArticle} data-testid="desk-problem-create-article">
            <BookOpen className="mr-1.5 h-4 w-4" />
            {creatingArticle ? td.actions.creatingArticle : td.actions.createArticle}
          </Button>
        )
      )}
      {canDelete && (
        <Button variant="outline" size="sm" onClick={onDelete} data-testid="desk-problem-delete">
          <Trash2 className="mr-1.5 h-4 w-4" />
          {td.actions.delete}
        </Button>
      )}
    </>
  );
}

/** Unsaved texts: discard them or save. */
function ProblemSaveBar({
  td,
  dirty,
  titleEmpty,
  saving,
  onDiscard,
  onSave,
}: Readonly<{
  td: ProblemLabels['detail'];
  dirty: boolean;
  titleEmpty: boolean;
  saving: boolean;
  onDiscard: () => void;
  onSave: () => void;
}>) {
  return (
    <div className="flex items-center justify-end gap-3" data-testid="desk-problem-save-bar">
      {dirty && <span className="text-sm text-muted-foreground">{td.unsaved}</span>}
      <Button variant="outline" onClick={onDiscard} disabled={!dirty || saving}>
        {td.discard}
      </Button>
      <Button onClick={onSave} disabled={!dirty || titleEmpty || saving} data-testid="desk-problem-save">
        {td.save}
      </Button>
    </div>
  );
}

export default function DeskProblemPage() {
  const t = getTranslations('deskProblems');
  const td = t.detail;
  const { problemId = '' } = useParams<{ problemId: string }>();
  const router = useRouter();
  const canUpdate = useCan('problems:update');
  const canWriteTickets = useCan('conversations:update');
  const canDelete = useCan('problems:delete');
  const canWriteArticle = useCan('articles:create');
  const { data: problem, isLoading, isError, error, refetch } = useDeskProblem(problemId);
  const { data: members = [] } = useDeskWorkspaceMembers();
  const { data: options } = useDeskAttributeOptions();
  const update = useUpdateDeskProblem();
  const createArticle = useCreateDeskProblemArticle();
  const remove = useDeleteDeskProblem();
  const [state, setState] = useState<DraftState | null>(null);
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useBreadcrumbs([
    { label: getTranslations('helpdesk').title, href: '/welddesk' },
    { label: t.list.title, href: '/welddesk/problems' },
    { label: problem ? td.heading.replace('{number}', String(problem.problemNumber)) : '…' },
  ]);

  useEffect(() => {
    if (!problem) return;
    setState((current) => followServer(problem, current));
  }, [problem]);

  // The draft of the problem that was open before is not this one's: wait for the reset.
  const active = state && problem && state.problemId === problem.id ? state : null;
  if (isLoading || (problem && !active)) return <PageLoader />;
  if (isError || !problem || !active) {
    return (
      <ProblemLoadError error={error} t={t} onBack={() => router.push('/welddesk/problems')} onRetry={() => void refetch()} />
    );
  }

  const refusalText = (err: unknown, fallback: string) => refusalMessage(t.refusals, err, fallback);

  const { draft, baseline } = active;
  const setDraft = (next: Draft) => setState({ ...active, draft: next });
  const patch = draftPatch(baseline, draft);
  const dirty = Object.keys(patch).length > 0;
  const titleEmpty = draft.title.trim() === '';
  const locked = !canUpdate || update.isPending;

  const save = () =>
    update.mutate(
      { id: problem.id, patch },
      {
        onSuccess: (res) => {
          setState(freshDraft(res.data));
          toast.success(td.saved);
        },
        onError: (err) => toast.error(refusalText(err, td.saveFailed)),
      },
    );

  /** A status change carries the texts typed so far: a known error may rest on a workaround not saved yet. */
  const changeStatus = (status: DeskProblemStatus) =>
    update.mutate(
      { id: problem.id, patch: { ...patch, status } },
      {
        onSuccess: (res) => setState(freshDraft(res.data)),
        onError: (err) => toast.error(refusalText(err, td.statusFailed)),
      },
    );

  const change = (field: DeskProblemUpdate) =>
    update.mutate({ id: problem.id, patch: field }, { onError: (err) => toast.error(refusalText(err, td.saveFailed)) });

  const writeArticle = () =>
    createArticle.mutate(problem.id, {
      onSuccess: (res) => {
        toast.success(td.actions.articleCreated);
        router.push(`/welddesk/help-center/articles/${res.data.articleId}/edit`);
      },
      onError: (err) => toast.error(refusalText(err, td.actions.articleFailed)),
    });

  const confirmDelete = async () => {
    try {
      await remove.mutateAsync(problem.id);
      toast.success(td.delete.deleted);
      setDeleting(false);
      router.push('/welddesk/problems');
    } catch (err) {
      toast.error(refusalText(err, td.delete.failed));
    }
  };

  const dates = problemDates(problem, td.fields);

  const textField = (field: TextField, label: string, hint: string, rows: number) => (
    <SectionCard title={label} description={hint} key={field}>
      <Textarea
        aria-label={label}
        value={draft[field]}
        rows={rows}
        maxLength={20_000}
        disabled={!canUpdate}
        onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
        data-testid={`desk-problem-${field}`}
      />
    </SectionCard>
  );

  return (
    <DetailPage className="mx-auto max-w-5xl">
      <DetailHeader
        onBack={() => router.push('/welddesk/problems')}
        backLabel={td.back}
        title={problem.title}
        subtitle={td.heading.replace('{number}', String(problem.problemNumber))}
        badges={<ProblemStatusBadge status={problem.status} />}
        actions={
          <ProblemActions
            problem={problem}
            t={t}
            canUpdate={canUpdate}
            canShare={canUpdate && canWriteTickets}
            canDelete={canDelete}
            canWriteArticle={canWriteArticle}
            updating={update.isPending}
            creatingArticle={createArticle.isPending}
            onStatus={changeStatus}
            onShare={() => setSharing(true)}
            onWriteArticle={writeArticle}
            onDelete={() => setDeleting(true)}
          />
        }
      />

      <SectionCard title={td.texts.title}>
        <div className="space-y-1.5">
          <Label htmlFor="desk-problem-title-input" className="sr-only">
            {td.texts.title}
          </Label>
          <Input
            id="desk-problem-title-input"
            value={draft.title}
            maxLength={500}
            disabled={!canUpdate}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
        </div>
      </SectionCard>

      <SectionCard title={td.detailsTitle}>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>{td.fields.priority}</Label>
            <PickOne
              value={problem.priority}
              noneLabel={t.priority.none}
              items={DESK_PRIORITIES.map((value) => ({ value, label: t.priority[value] }))}
              onChange={(value) => change({ priority: value as DeskPriority | null })}
              disabled={locked}
              testId="desk-problem-priority"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{td.fields.owner}</Label>
            <PickOne
              value={problem.assigneeId}
              noneLabel={t.list.unowned}
              items={members.map((member) => ({ value: member.userId, label: member.name }))}
              onChange={(value) => change({ assigneeId: value })}
              disabled={locked}
              testId="desk-problem-owner"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{td.fields.team}</Label>
            <PickOne
              value={problem.departmentId}
              noneLabel={t.list.noTeam}
              items={(options?.teams ?? []).map((team) => ({ value: team.id, label: team.name }))}
              onChange={(value) => change({ departmentId: value })}
              disabled={locked}
              testId="desk-problem-team"
            />
          </div>
        </div>
        <FieldGrid className="mt-4" fields={dates} />
      </SectionCard>

      {textField('description', td.texts.description, td.texts.descriptionHint, 4)}
      {textField('rootCause', td.texts.rootCause, td.texts.rootCauseHint, 4)}
      {textField('workaround', td.texts.workaround, td.texts.workaroundHint, 4)}
      {textField('resolution', td.texts.resolution, td.texts.resolutionHint, 3)}

      {canUpdate && (
        <ProblemSaveBar
          td={td}
          dirty={dirty}
          titleEmpty={titleEmpty}
          saving={update.isPending}
          onDiscard={() => setState(freshDraft(problem))}
          onSave={save}
        />
      )}

      <ProblemIncidentsCard problem={problem} canUpdate={canUpdate && canWriteTickets} />

      <ShareWorkaroundDialog problem={problem} open={sharing} onOpenChange={setSharing} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={td.delete.title.replace('{number}', String(problem.problemNumber))}
        description={td.delete.description}
        confirmLabel={td.delete.confirm}
        cancelLabel={td.delete.cancel}
        variant="destructive"
        onConfirm={confirmDelete}
      />
    </DetailPage>
  );
}
