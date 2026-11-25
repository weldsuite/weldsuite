import { useId, useMemo, useState } from 'react';
import { ChevronUp, ListPlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Label } from '@weldsuite/ui/components/label';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { LESSON_TEXT_MAX } from '@weldsuite/app-api-client/schemas/project-closing';
import {
  RETRO_CATEGORIES,
  type RetroCard,
  type RetroCategory,
} from '@weldsuite/app-api-client/schemas/flow-agile';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { useParams } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import {
  useCreateRetroCard,
  useDeleteRetroCard,
  useRetroCards,
  useUpdateRetroCard,
  useVoteRetroCard,
} from '@/hooks/queries/use-flow-agile-queries';
import { useMakeRetroActionTask } from '@/hooks/queries/use-flow-agile-sprint-queries';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { apiMessage } from '@/app/weldflow/project/[projectId]/close/_lib/api-error';
import { useMemberDirectory } from '@/app/weldflow/project/[projectId]/close/_lib/members';
import { PersonAvatar } from '@/app/weldflow/project/[projectId]/close/_components/person-avatar';

const COLUMN_STYLE: Record<RetroCategory, { bg: string; title: string }> = {
  went_well: { bg: 'bg-green-50 dark:bg-green-950/20', title: 'text-green-800 dark:text-green-300' },
  went_badly: { bg: 'bg-orange-50 dark:bg-orange-950/20', title: 'text-orange-800 dark:text-orange-300' },
  do_differently: { bg: 'bg-blue-50 dark:bg-blue-950/20', title: 'text-blue-800 dark:text-blue-300' },
  action: { bg: 'bg-violet-50 dark:bg-violet-950/20', title: 'text-violet-800 dark:text-violet-300' },
};

const cardTextSchema = z.object({ text: z.string().trim().min(1).max(LESSON_TEXT_MAX) });
type CardTextValues = z.infer<typeof cardTextSchema>;

/** The text field of a new or edited card: Enter saves, Shift+Enter adds a line, Escape cancels. */
function CardEditor({
  initial,
  pending,
  onSubmit,
  onCancel,
}: Readonly<{ initial: string; pending: boolean; onSubmit: (text: string) => void; onCancel: () => void }>) {
  const { t } = useI18n();
  const copy = t.flowAgileSprints.retro;
  const form = useForm<CardTextValues>({ resolver: zodResolver(cardTextSchema), defaultValues: { text: initial }, mode: 'onChange' });
  const id = useId();
  const { ref, ...field } = form.register('text');

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit((values) => onSubmit(values.text))}
      className="grid gap-2 rounded-lg border bg-card p-2.5"
    >
      <Label htmlFor={id} className="sr-only">
        {copy.cardLabel}
      </Label>
      <Textarea
        id={id}
        autoFocus
        rows={3}
        maxLength={LESSON_TEXT_MAX}
        placeholder={copy.cardPlaceholder}
        className="min-h-16 text-[13px]"
        ref={ref}
        {...field}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
          else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void form.handleSubmit((values) => onSubmit(values.text))();
          }
        }}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {copy.cancel}
        </Button>
        <Button type="submit" size="sm" disabled={pending || !form.formState.isValid}>
          {copy.save}
        </Button>
      </div>
    </form>
  );
}

interface CardAbilities {
  vote: boolean;
  edit: boolean;
  delete: boolean;
  makeTask: boolean;
  manage: boolean;
}

function RetroCardView({
  card,
  abilities,
  userId,
  authorName,
  authorAvatar,
  projectId,
  sprintId,
  onDelete,
}: Readonly<{
  card: RetroCard;
  abilities: CardAbilities;
  userId: string | null;
  authorName: string;
  authorAvatar: string | null | undefined;
  projectId: string;
  sprintId: string;
  onDelete: (card: RetroCard) => void;
}>) {
  const { t, plural } = useI18n();
  const copy = t.flowAgileSprints.retro;
  const [editing, setEditing] = useState(false);
  const update = useUpdateRetroCard(projectId, sprintId);
  const vote = useVoteRetroCard(projectId, sprintId);
  const makeTask = useMakeRetroActionTask(projectId);
  const mayChange = abilities.manage || (userId !== null && card.authorId === userId);

  if (editing) {
    return (
      <CardEditor
        initial={card.text}
        pending={update.isPending}
        onCancel={() => setEditing(false)}
        onSubmit={(text) =>
          update.mutate(
            { id: card.id, input: { text } },
            {
              onSuccess: () => setEditing(false),
              onError: (error) => toast.error(apiMessage(error, copy.saveFailed)),
            },
          )
        }
      />
    );
  }

  const toggleVote = () =>
    vote.mutate(
      { id: card.id, voted: card.votedByMe },
      { onError: (error) => toast.error(apiMessage(error, copy.voteFailed)) },
    );

  const createTask = () =>
    makeTask.mutate(card.text, {
      onSuccess: () => toast.success(copy.taskCreated),
      onError: (error) => toast.error(apiMessage(error, copy.taskFailed)),
    });

  return (
    <article className="rounded-lg border bg-card px-3 py-2.5">
      <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{card.text}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <PersonAvatar name={authorName} avatar={authorAvatar} className="size-[22px]" />
        <span className="min-w-0 truncate text-xs text-muted-foreground">{authorName}</span>
        <div className="ml-auto flex items-center gap-1">
          {abilities.edit && mayChange ? (
            <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={copy.edit} title={copy.edit} onClick={() => setEditing(true)}>
              <Pencil aria-hidden className="size-3.5" />
            </Button>
          ) : null}
          {abilities.delete && mayChange ? (
            <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={copy.delete} title={copy.delete} onClick={() => onDelete(card)}>
              <Trash2 aria-hidden className="size-3.5" />
            </Button>
          ) : null}
          <button
            type="button"
            aria-pressed={card.votedByMe}
            aria-label={plural(card.voteCount, copy.vote)}
            disabled={!abilities.vote || vote.isPending}
            onClick={toggleVote}
            className={cn(
              'inline-flex h-[26px] items-center gap-1 rounded-full border px-2 text-xs tabular-nums outline-none transition-colors',
              'focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default',
              card.votedByMe ? 'border-foreground bg-foreground text-background' : 'text-foreground/80 hover:bg-accent disabled:hover:bg-transparent',
            )}
          >
            <ChevronUp aria-hidden className="size-3" strokeWidth={2.4} />
            {card.voteCount}
          </button>
        </div>
      </div>
      {card.category === 'action' && abilities.makeTask ? (
        <Button type="button" variant="outline" size="sm" className="mt-2" disabled={makeTask.isPending} onClick={createTask}>
          <ListPlus aria-hidden />
          {makeTask.isPending ? copy.makingTask : copy.makeTask}
        </Button>
      ) : null}
    </article>
  );
}

/** Sprint, Retro: four columns of cards (went well, didn't go well, try next, actions) with votes; an action can become a task. */
export default function SprintRetroPage() {
  const { t, plural, format } = useI18n();
  const copy = t.flowAgileSprints.retro;
  const params = useParams();
  const projectId = params.projectId as string;
  const sprintId = params.sprintId as string;
  const { userId } = useAuth();
  const { canWrite, isAdmin } = useProjectPermissions();
  const { can } = usePermissions();
  const { memberOf } = useMemberDirectory();
  const query = useRetroCards(projectId, sprintId);
  const create = useCreateRetroCard(projectId, sprintId);
  const remove = useDeleteRetroCard(projectId, sprintId);
  const [adding, setAdding] = useState<RetroCategory | null>(null);
  const [deleting, setDeleting] = useState<RetroCard | null>(null);

  const abilities: CardAbilities = {
    vote: canWrite && can('projects:update'),
    edit: canWrite && can('projects:update'),
    delete: canWrite && can('projects:delete'),
    makeTask: canWrite && can('tasks:create'),
    manage: isAdmin,
  };
  const mayAdd = canWrite && can('projects:create');

  const columns = useMemo(() => {
    const grouped = Object.fromEntries(RETRO_CATEGORIES.map((category) => [category, [] as RetroCard[]])) as Record<RetroCategory, RetroCard[]>;
    for (const card of query.data ?? []) grouped[card.category]?.push(card);
    for (const category of RETRO_CATEGORIES) {
      grouped[category].sort((a, b) => b.voteCount - a.voteCount || a.createdAt.localeCompare(b.createdAt));
    }
    return grouped;
  }, [query.data]);

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      setDeleting(null);
    } catch (error) {
      toast.error(apiMessage(error, copy.deleteFailed));
    }
  };

  return (
    <section aria-labelledby="sprint-retro-title" className="grid gap-3">
      <div>
        <div className="flex flex-wrap items-center gap-2.5">
          <h3 id="sprint-retro-title" className="text-base font-semibold">
            {copy.title}
          </h3>
          {query.data ? <span className="text-xs text-muted-foreground">{plural(query.data.length, copy.summary)}</span> : null}
        </div>
        <p className="text-sm text-muted-foreground">{copy.description}</p>
      </div>

      {query.isLoading ? (
        <div role="status" aria-busy="true" className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {RETRO_CATEGORIES.map((category) => (
            <Skeleton key={category} className="h-48 rounded-lg" />
          ))}
        </div>
      ) : null}

      {query.isError ? <ErrorState message={copy.loadFailed} onRetry={() => void query.refetch()} /> : null}

      {!query.isLoading && !query.isError ? (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(16rem,1fr))]">
          {RETRO_CATEGORIES.map((category) => {
            const cards = columns[category];
            return (
              <div key={category} role="group" aria-label={copy.columns[category]} className={cn('flex flex-col gap-2 rounded-lg p-3', COLUMN_STYLE[category].bg)}>
                <div className="flex items-center gap-2">
                  <h4 className={cn('text-[13px] font-semibold', COLUMN_STYLE[category].title)}>
                    {copy.columns[category]} <span className="font-medium text-muted-foreground">{cards.length}</span>
                  </h4>
                  {mayAdd ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="ml-auto size-6"
                      aria-label={format(copy.addToColumn, { column: copy.columns[category] })}
                      onClick={() => setAdding(category)}
                    >
                      <Plus aria-hidden className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
                {adding === category ? (
                  <CardEditor
                    initial=""
                    pending={create.isPending}
                    onCancel={() => setAdding(null)}
                    onSubmit={(text) =>
                      create.mutate(
                        { category, text },
                        {
                          onSuccess: () => setAdding(null),
                          onError: (error) => toast.error(apiMessage(error, copy.saveFailed)),
                        },
                      )
                    }
                  />
                ) : null}
                {cards.length === 0 && adding !== category ? (
                  <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">{copy.empty[category]}</p>
                ) : null}
                {cards.map((card) => {
                  const author = memberOf(card.authorId);
                  return (
                    <RetroCardView
                      key={card.id}
                      card={card}
                      abilities={abilities}
                      userId={userId ?? null}
                      authorName={author?.name ?? t.flowClosing.shared.unknownMember}
                      authorAvatar={author?.avatar}
                      projectId={projectId}
                      sprintId={sprintId}
                      onDelete={setDeleting}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        title={copy.deleteTitle}
        description={copy.deleteDescription}
        confirmLabel={copy.deleteConfirm}
        cancelLabel={copy.cancel}
        variant="destructive"
        onConfirm={confirmDelete}
      />
    </section>
  );
}
