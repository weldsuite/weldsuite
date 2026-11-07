import { useState, type ReactNode } from 'react';
import { Loader2, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { MergeCommentDto, MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';
import {
  useCreateMergeComment,
  useDeleteMergeComment,
  useMergeComments,
  useUpdateMergeComment,
} from '@/hooks/queries/use-weldmerge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { fill, relativeTime } from '../lib/format';
import { useMergeMembers } from '../lib/use-members';
import { MarkdownBody, MemberAvatar, useMemberName } from './primitives';

/** A provider comment from someone who is not a member: shown under their provider login. */
function ExternalAvatar({ login, avatarUrl }: Readonly<{ login: string; avatarUrl: string | null }>) {
  return (
    <Avatar className="mt-0.5 size-5" title={login}>
      {avatarUrl && <AvatarImage src={avatarUrl} alt={login} />}
      <AvatarFallback className="text-[10px]">{login.slice(0, 2).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

function CommentRow({
  comment,
  canEdit,
  canDelete,
  providerName,
  onEdit,
  onDelete,
}: Readonly<{
  comment: MergeCommentDto;
  /** The provider the issue syncs with, to label comments that came from it. */
  providerName: string | null;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (comment: MergeCommentDto, body: string) => Promise<void>;
  onDelete: (comment: MergeCommentDto) => void;
}>) {
  const { t, language } = useI18n();
  const ti = t.weldmerge.issue;
  const memberName = useMemberName(comment.authorUserId);
  const external = comment.authorUserId === null && comment.externalAuthorLogin !== null;
  const name = external ? (comment.externalAuthorLogin as string) : (memberName ?? ti.unknownMember);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [saving, setSaving] = useState(false);
  const edited = comment.updatedAt !== comment.createdAt;

  const submit = async () => {
    if (draft.trim() === '') return;
    setSaving(true);
    try {
      await onEdit(comment, draft.trim());
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="flex gap-3">
      {external ? (
        <ExternalAvatar login={name} avatarUrl={comment.externalAuthorAvatarUrl} />
      ) : (
        <MemberAvatar userId={comment.authorUserId} className="mt-0.5" />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{name}</span>
          {comment.source === 'provider' && providerName && (
            <span className="text-xs text-muted-foreground">
              {fill(t.weldmerge.sync.externalSync.viaProvider, { provider: providerName })}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {relativeTime(comment.createdAt, language, t.weldmerge.justNow)}
            {edited && ` · ${ti.commentEdited}`}
          </span>
          <span className="ml-auto flex gap-1">
            {canEdit && !editing && (
              <Button variant="ghost" size="icon" className="size-7" aria-label={t.common.actions.edit} onClick={() => setEditing(true)}>
                <Pencil />
              </Button>
            )}
            {canDelete && (
              <Button variant="ghost" size="icon" className="size-7" aria-label={t.common.actions.delete} onClick={() => onDelete(comment)}>
                <Trash2 />
              </Button>
            )}
          </span>
        </div>
        {editing ? (
          <div className="space-y-2">
            <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} aria-label={ti.comments} />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void submit()} disabled={saving || draft.trim() === ''}>
                {saving && <Loader2 className="animate-spin" />}
                {t.common.actions.save}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setDraft(comment.body);
                  setEditing(false);
                }}
              >
                {t.common.actions.cancel}
              </Button>
            </div>
          </div>
        ) : (
          <MarkdownBody>{comment.body}</MarkdownBody>
        )}
      </div>
    </li>
  );
}

/**
 * The comments of an issue, newest last, with a composer. Members edit and
 * delete their own; deleting someone else's takes `merge_issues:delete`.
 */
export function IssueComments({ issueId, provider }: Readonly<{ issueId: string; provider?: MergeProvider }>) {
  const { t } = useI18n();
  const ti = t.weldmerge.issue;
  const canWrite = useCan('merge_issues:update');
  const canDeleteAny = useCan('merge_issues:delete');
  const { currentUserId } = useMergeMembers();
  const comments = useMergeComments(issueId);
  const create = useCreateMergeComment(issueId);
  const update = useUpdateMergeComment(issueId);
  const remove = useDeleteMergeComment(issueId);
  const [body, setBody] = useState('');
  const [deleting, setDeleting] = useState<MergeCommentDto | null>(null);

  const submit = async () => {
    const text = body.trim();
    if (!text) return;
    try {
      await create.mutateAsync({ body: text });
      setBody('');
    } catch {
      toast.error(ti.commentFailed);
    }
  };

  const edit = async (comment: MergeCommentDto, next: string) => {
    try {
      await update.mutateAsync({ id: comment.id, input: { body: next } });
    } catch (error) {
      toast.error(ti.saveFailed);
      throw error;
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      setDeleting(null);
    } catch {
      toast.error(ti.deleteFailed);
    }
  };

  const sorted = [...(comments.data ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  let content: ReactNode;
  if (comments.isLoading) {
    content = <InlineSpinner />;
  } else if (comments.isError) {
    content = (
      <ErrorState message={t.weldmerge.loadFailed} retryLabel={t.weldmerge.retry} onRetry={() => void comments.refetch()} />
    );
  } else if (sorted.length === 0) {
    content = <p className="text-sm text-muted-foreground">{ti.noComments}</p>;
  } else {
    content = (
      <ul className="space-y-4">
        {sorted.map((comment) => {
          const own = comment.authorUserId === currentUserId;
          return (
            <CommentRow
              key={comment.id}
              comment={comment}
              canEdit={own && canWrite}
              canDelete={own ? canWrite : canDeleteAny}
              providerName={provider ? t.weldmerge.provider[provider] : null}
              onEdit={edit}
              onDelete={setDeleting}
            />
          );
        })}
      </ul>
    );
  }

  return (
    <div className="space-y-4">
      {content}

      {canWrite && (
        <div className="space-y-2">
          <Textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={ti.commentPlaceholder}
            aria-label={ti.commentPlaceholder}
            rows={3}
          />
          <Button size="sm" onClick={() => void submit()} disabled={create.isPending || body.trim() === ''}>
            {create.isPending && <Loader2 className="animate-spin" />}
            {ti.commentSubmit}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={ti.commentDeleteTitle}
        description={ti.commentDeleteDescription}
        confirmLabel={t.common.actions.delete}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
