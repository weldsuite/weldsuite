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
function draftPatch(problem: DeskProblem, draft: Draft): DeskProblemUpdate {
  const saved = draftOf(problem);
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

export default function DeskProblemPage() {
  const t = getTranslations('deskProblems');
  const td = t.detail;
  const { problemId = '' } = useParams<{ problemId: string }>();
  const router = useRouter();
  const canUpdate = useCan('problems:update');
  const canDelete = useCan('problems:delete');
  const canWriteArticle = useCan('articles:create');
  const { data: problem, isLoading, isError, error, refetch } = useDeskProblem(problemId);
  const { data: members = [] } = useDeskWorkspaceMembers();
  const { data: options } = useDeskAttributeOptions();
  const update = useUpdateDeskProblem();
  const createArticle = useCreateDeskProblemArticle();
  const remove = useDeleteDeskProblem();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useBreadcrumbs([
    { label: getTranslations('helpdesk').title, href: '/welddesk' },
    { label: t.list.title, href: '/welddesk/problems' },
    { label: problem ? td.heading.replace('{number}', String(problem.problemNumber)) : '…' },
  ]);

  // Follow the server, but never overwrite what is being typed.
  useEffect(() => {
    if (!problem) return;
    setDraft((current) => (current && Object.keys(draftPatch(problem, current)).length > 0 ? current : draftOf(problem)));
  }, [problem]);

  if (isLoading || (problem && !draft)) return <PageLoader />;
  if (isError || !problem || !draft) {
    const missing = isApiError(error) && error.status === 404;
    return (
      <DetailPage>
        <ErrorState
          message={missing ? td.notFound : td.loadError}
          onRetry={missing ? () => router.push('/welddesk/problems') : () => void refetch()}
          retryLabel={missing ? td.back : t.list.retry}
        />
      </DetailPage>
    );
  }

  const refusalText = (err: unknown, fallback: string) => {
    const reason = deskLinkRefusal(err);
    const known = reason ? (t.refusals as Record<string, string>)[reason] : undefined;
    return known ?? deskLinkErrorMessage(err) ?? fallback;
  };

  const patch = draftPatch(problem, draft);
  const dirty = Object.keys(patch).length > 0;
  const titleEmpty = draft.title.trim() === '';

  const save = () =>
    update.mutate(
      { id: problem.id, patch },
      {
        onSuccess: (res) => {
          setDraft(draftOf(res.data));
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
        onSuccess: (res) => setDraft(draftOf(res.data)),
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

  const dates = [
    { label: td.fields.created, value: formatDateTime(problem.createdAt) },
    ...(problem.knownErrorAt ? [{ label: td.fields.knownError, value: formatDateTime(problem.knownErrorAt) }] : []),
    ...(problem.resolvedAt ? [{ label: td.fields.resolved, value: formatDateTime(problem.resolvedAt) }] : []),
    ...(problem.closedAt ? [{ label: td.fields.closed, value: formatDateTime(problem.closedAt) }] : []),
  ];

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
          <>
            <Select value={problem.status} onValueChange={(value) => changeStatus(value as DeskProblemStatus)} disabled={!canUpdate || update.isPending}>
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
            {canUpdate && (
              <Button variant="outline" size="sm" onClick={() => setSharing(true)} data-testid="desk-problem-share-open">
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
                <Button variant="outline" size="sm" onClick={writeArticle} disabled={createArticle.isPending} data-testid="desk-problem-create-article">
                  <BookOpen className="mr-1.5 h-4 w-4" />
                  {createArticle.isPending ? td.actions.creatingArticle : td.actions.createArticle}
                </Button>
              )
            )}
            {canDelete && (
              <Button variant="outline" size="sm" onClick={() => setDeleting(true)} data-testid="desk-problem-delete">
                <Trash2 className="mr-1.5 h-4 w-4" />
                {td.actions.delete}
              </Button>
            )}
          </>
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
              disabled={!canUpdate || update.isPending}
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
              disabled={!canUpdate || update.isPending}
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
              disabled={!canUpdate || update.isPending}
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
        <div className="flex items-center justify-end gap-3" data-testid="desk-problem-save-bar">
          {dirty && <span className="text-sm text-muted-foreground">{td.unsaved}</span>}
          <Button variant="outline" onClick={() => setDraft(draftOf(problem))} disabled={!dirty || update.isPending}>
            {td.discard}
          </Button>
          <Button onClick={save} disabled={!dirty || titleEmpty || update.isPending} data-testid="desk-problem-save">
            {td.save}
          </Button>
        </div>
      )}

      <ProblemIncidentsCard problem={problem} canUpdate={canUpdate} />

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
