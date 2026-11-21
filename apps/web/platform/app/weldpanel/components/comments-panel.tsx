/**
 * The comments on a report or dashboard: the thread, oldest first, and a box
 * to add one. Authors edit and delete their own; people who manage WeldPanel
 * projects may delete any. Bodies are Markdown.
 */

import { useState } from 'react';
import { Loader2, MessageSquare, MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import type { PanelCommentDto, PanelTargetParams } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  useCreateWeldPanelComment,
  useDeleteWeldPanelComment,
  useUpdateWeldPanelComment,
  useWeldPanelComments,
} from '@/hooks/queries/use-weldpanel-collab-queries';
import { useI18n } from '@/lib/i18n/provider';
import { formatDateTime } from '../lib/format';
import { MarkdownText } from './markdown-text';
import { useMembers } from './use-members';

const MAX_BODY = 5000;

interface CommentItemProps {
  comment: PanelCommentDto;
  author: string;
  canEdit: boolean;
  canDelete: boolean;
  onDelete: () => void;
}

function CommentItem({ comment, author, canEdit, canDelete, onDelete }: Readonly<CommentItemProps>) {
  const { t, language } = useI18n();
  const tm = t.weldpanel.collab.comments;
  const tc = t.weldpanel.analytics.common;
  const update = useUpdateWeldPanelComment();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);

  async function save() {
    try {
      await update.mutateAsync({ id: comment.id, body: draft.trim() });
      toast.success(tm.saved);
      setEditing(false);
    } catch {
      toast.error(tm.saveFailed);
    }
  }

  return (
    <li className="py-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            <span className="font-medium">{author}</span>{' '}
            <span className="text-xs text-muted-foreground">
              {formatDateTime(comment.createdAt, language)}
              {comment.edited && ` · ${tm.edited}`}
            </span>
          </p>
        </div>
        {(canEdit || canDelete) && !editing && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={tm.actions}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canEdit && (
                <DropdownMenuItem
                  onSelect={() => {
                    setDraft(comment.body);
                    setEditing(true);
                  }}
                >
                  {tc.edit}
                </DropdownMenuItem>
              )}
              {canDelete && (
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
                  {tc.delete}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {editing ? (
        <div className="mt-2 grid gap-2">
          <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} maxLength={MAX_BODY} aria-label={tm.label} disabled={update.isPending} />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="outline" disabled={update.isPending} onClick={() => setEditing(false)}>
              {tc.cancel}
            </Button>
            <Button type="button" size="sm" disabled={draft.trim() === '' || update.isPending} onClick={() => void save()}>
              {update.isPending && <Loader2 className="animate-spin" />}
              {tc.save}
            </Button>
          </div>
        </div>
      ) : (
        <MarkdownText className="mt-1">{comment.body}</MarkdownText>
      )}
    </li>
  );
}

export function CommentsPanel({ target }: Readonly<{ target: PanelTargetParams }>) {
  const { t } = useI18n();
  const tm = t.weldpanel.collab.comments;
  const tc = t.weldpanel.analytics.common;
  const canCreate = useCan('panel_reports:create');
  const canUpdate = useCan('panel_reports:update');
  const canDeleteAny = useCan('panel_reports:delete');
  const canManage = useCan('panel_projects:manage');
  const { me, nameOf } = useMembers();
  const { data: comments, isLoading, isError, refetch } = useWeldPanelComments(target);
  const create = useCreateWeldPanelComment();
  const remove = useDeleteWeldPanelComment(target);
  const [body, setBody] = useState('');
  const [deleting, setDeleting] = useState<PanelCommentDto | null>(null);

  async function post() {
    try {
      await create.mutateAsync({ ...target, body: body.trim() });
      setBody('');
      toast.success(tm.posted);
    } catch {
      toast.error(tm.postFailed);
    }
  }

  return (
    <div className="grid gap-3">
      {isLoading && (
        <div className="grid gap-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      )}
      {isError && <ErrorState message={tm.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />}
      {!isLoading && !isError && (comments ?? []).length === 0 && <EmptyState icon={MessageSquare} title={tm.title} description={tm.empty} />}
      {comments && comments.length > 0 && (
        <ul className="divide-y">
          {comments.map((comment) => {
            const own = comment.authorUserId === me;
            return (
              <CommentItem
                key={comment.id}
                comment={comment}
                author={nameOf(comment.authorUserId, { you: tc.ownedByYou, fallback: t.weldpanel.observe.common.unknown })}
                canEdit={own && canUpdate}
                canDelete={canDeleteAny && (own || canManage)}
                onDelete={() => setDeleting(comment)}
              />
            );
          })}
        </ul>
      )}
      {canCreate && (
        <div className="grid gap-2">
          <Textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={3}
            maxLength={MAX_BODY}
            placeholder={tm.placeholder}
            aria-label={tm.label}
            disabled={create.isPending}
          />
          <div className="flex justify-end">
            <Button type="button" size="sm" disabled={body.trim() === '' || create.isPending} onClick={() => void post()}>
              {create.isPending && <Loader2 className="animate-spin" />}
              {tm.post}
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={tm.deleteTitle}
        description={tm.deleteDescription}
        confirmLabel={tc.delete}
        cancelLabel={tc.cancel}
        variant="destructive"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.id);
            toast.success(tm.deleted);
            setDeleting(null);
          } catch {
            toast.error(tm.deleteFailed);
          }
        }}
      />
    </div>
  );
}
