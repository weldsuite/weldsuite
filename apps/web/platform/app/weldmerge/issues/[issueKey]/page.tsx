import { useEffect, useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { DetailHeader, DetailPage } from '@weldsuite/ui/components/page-layout';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  useCreateMergeIssue,
  useDeleteMergeIssue,
  useMergeIssue,
  useUpdateMergeIssue,
} from '@/hooks/queries/use-weldmerge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link, useParams, useRouter } from '@/lib/router';
import { IssueComments } from '../../components/issue-comments';
import { IssueProperties } from '../../components/issue-properties';
import {
  ChecksIndicator,
  IssueStatusIcon,
  MarkdownBody,
  MemberAvatar,
  PullRequestStateBadge,
  PullRequestStateIcon,
  ReviewDecisionBadge,
  useMemberName,
} from '../../components/primitives';
import { fill, relativeTime } from '../../lib/format';

/** The rendered description, or a hint when there is none. */
function IssueDescription({ description, emptyLabel }: Readonly<{ description: string | null; emptyLabel: string }>) {
  if (description) return <MarkdownBody>{description}</MarkdownBody>;
  return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
}

/**
 * An issue by key: editable title and Markdown description, property sidebar,
 * sub-issues, the pull requests linked to it and comments. Phase 1 has no
 * activity feed beyond the comments.
 */
export default function WeldMergeIssuePage() {
  const { t, language } = useI18n();
  const tm = t.weldmerge;
  const ti = tm.issue;
  const router = useRouter();
  const { issueKey } = useParams() as { issueKey: string };
  const canUpdate = useCan('merge_issues:update');
  const canCreate = useCan('merge_issues:create');
  const canDelete = useCan('merge_issues:delete');

  const query = useMergeIssue(issueKey);
  const update = useUpdateMergeIssue();
  const createSub = useCreateMergeIssue();
  const remove = useDeleteMergeIssue();

  const issue = query.data;
  const creatorName = useMemberName(issue?.creatorUserId);

  const [title, setTitle] = useState('');
  const [editingDescription, setEditingDescription] = useState(false);
  const [description, setDescription] = useState('');
  const [subTitle, setSubTitle] = useState('');
  const [addingSub, setAddingSub] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (issue) setTitle(issue.title);
  }, [issue?.title]); // eslint-disable-line react-hooks/exhaustive-deps -- follow the server's title only

  if (query.isLoading) return <PageLoader fullScreen={false} />;
  if (query.isError || !issue) {
    return <ErrorState message={tm.issues.notFound} retryLabel={tm.retry} onRetry={() => void query.refetch()} />;
  }

  const save = (input: Parameters<typeof update.mutate>[0]['input']) =>
    update.mutate({ id: issue.id, input }, { onError: () => toast.error(ti.saveFailed) });

  const commitTitle = () => {
    const next = title.trim();
    if (next === '' || next === issue.title) {
      setTitle(issue.title);
      return;
    }
    save({ title: next });
  };

  const commitDescription = () => {
    const next = description.trim();
    setEditingDescription(false);
    if (next !== (issue.description ?? '').trim()) save({ description: next === '' ? null : next });
  };

  const addSubIssue = async () => {
    const next = subTitle.trim();
    if (next === '') return;
    try {
      await createSub.mutateAsync({ teamId: issue.teamId, title: next, parentIssueId: issue.id });
      setSubTitle('');
      setAddingSub(false);
    } catch {
      toast.error(tm.issues.createFailed);
    }
  };

  const deleteIssue = async () => {
    try {
      await remove.mutateAsync(issue.id);
      toast.success(ti.deleted);
      router.push('/weldmerge/issues');
    } catch {
      toast.error(ti.deleteFailed);
    }
  };

  const doneSubIssues = issue.subIssues.filter((sub) => sub.status === 'done').length;

  return (
    <DetailPage>
      <DetailHeader
        onBack={() => router.push('/weldmerge/issues')}
        backLabel={ti.backToIssues}
        leading={<IssueStatusIcon status={issue.status} className="mt-2 size-6" />}
        title={
          canUpdate ? (
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') setTitle(issue.title);
              }}
              aria-label={ti.titleLabel}
              className="h-auto border-transparent bg-transparent px-1 text-2xl font-semibold shadow-none hover:border-input md:text-2xl"
            />
          ) : (
            issue.title
          )
        }
        subtitle={
          <span>
            {issue.key}
            {creatorName ? ` · ${ti.createdBy} ${creatorName}` : ''} ·{' '}
            {fill(ti.createdAt, { time: relativeTime(issue.createdAt, language, tm.justNow) })}
          </span>
        }
        actions={
          canDelete ? (
            <Button variant="outline" onClick={() => setConfirmDelete(true)}>
              <Trash2 />
              {ti.deleteIssue}
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <SectionCard
            title={ti.descriptionLabel}
            action={
              canUpdate && !editingDescription ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDescription(issue.description ?? '');
                    setEditingDescription(true);
                  }}
                >
                  <Pencil />
                  {ti.editDescription}
                </Button>
              ) : undefined
            }
          >
            {editingDescription ? (
              <div className="space-y-2">
                <Textarea
                  autoFocus
                  rows={8}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={ti.descriptionPlaceholder}
                  aria-label={ti.descriptionLabel}
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={commitDescription}>
                    {t.common.actions.save}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingDescription(false)}>
                    {t.common.actions.cancel}
                  </Button>
                </div>
              </div>
            ) : (
              <IssueDescription description={issue.description} emptyLabel={tm.noDescription} />
            )}
          </SectionCard>

          <SectionCard
            title={
              <span>
                {ti.subIssues}
                {issue.subIssues.length > 0 && (
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {fill(ti.subIssuesProgress, { done: doneSubIssues, total: issue.subIssues.length })}
                  </span>
                )}
              </span>
            }
            action={
              canCreate && !addingSub ? (
                <Button variant="ghost" size="sm" onClick={() => setAddingSub(true)}>
                  <Plus />
                  {ti.addSubIssue}
                </Button>
              ) : undefined
            }
          >
            <div className="space-y-2">
              {issue.subIssues.map((sub) => (
                <Link
                  key={sub.id}
                  href={`/weldmerge/issues/${sub.key}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                >
                  <IssueStatusIcon status={sub.status} />
                  <span className="shrink-0 text-xs text-muted-foreground">{sub.key}</span>
                  <span className="min-w-0 flex-1 truncate">{sub.title}</span>
                  <MemberAvatar userId={sub.assigneeUserId} />
                </Link>
              ))}
              {addingSub && (
                <div className="flex gap-2">
                  <Input
                    autoFocus
                    value={subTitle}
                    onChange={(event) => setSubTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void addSubIssue();
                      if (event.key === 'Escape') setAddingSub(false);
                    }}
                    placeholder={ti.subIssuePlaceholder}
                    aria-label={ti.subIssuePlaceholder}
                  />
                  <Button onClick={() => void addSubIssue()} disabled={createSub.isPending || subTitle.trim() === ''}>
                    {createSub.isPending && <Loader2 className="animate-spin" />}
                    {ti.subIssueCreate}
                  </Button>
                </div>
              )}
            </div>
          </SectionCard>

          <SectionCard title={ti.pullRequests}>
            {issue.pullRequests.length === 0 ? (
              <p className="text-sm text-muted-foreground">{fill(ti.noPullRequests, { key: issue.key })}</p>
            ) : (
              <ul className="divide-y">
                {issue.pullRequests.map((pr) => (
                  <li key={pr.id}>
                    <Link
                      href={`/weldmerge/pull-requests/${pr.id}`}
                      className="flex flex-wrap items-center gap-3 py-2 text-sm hover:bg-muted/50"
                    >
                      <PullRequestStateIcon state={pr.state} draft={pr.draft} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{pr.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {pr.repositoryFullName} #{pr.number}
                          {pr.link.closes ? ` · ${tm.pullRequests.closesIssue}` : ''}
                        </span>
                      </span>
                      <PullRequestStateBadge state={pr.state} draft={pr.draft} />
                      <ChecksIndicator status={pr.checksStatus} />
                      <ReviewDecisionBadge decision={pr.reviewDecision} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title={ti.comments}>
            <IssueComments issueId={issue.id} />
          </SectionCard>
        </div>

        <aside>
          <SectionCard title={ti.properties}>
            <IssueProperties issue={issue} canEdit={canUpdate} />
          </SectionCard>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={fill(ti.deleteTitle, { key: issue.key })}
        description={ti.deleteDescription}
        confirmLabel={t.common.actions.delete}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={deleteIssue}
      />
    </DetailPage>
  );
}
