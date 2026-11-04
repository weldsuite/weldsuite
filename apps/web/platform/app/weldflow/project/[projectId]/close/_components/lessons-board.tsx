import { useMemo, useState } from 'react';
import { ChevronUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import type { Lesson, LessonCategory } from '@weldsuite/app-api-client/domains/project-closing';
import { cn } from '@/lib/utils';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useDeleteLesson, useLessons, useToggleLessonVote } from '@/hooks/queries/use-project-closing-queries';
import { apiMessage } from '../_lib/api-error';
import { LESSON_COLUMNS, canChangeLesson, lessonsByCategory } from '../_lib/close';
import { useClose } from './close-context';
import { LessonDialog, type LessonDialogState } from './lesson-dialog';
import { PersonAvatar } from './person-avatar';
import { PublishDialog } from './publish-dialog';

const COLUMN_STYLE: Record<LessonCategory, { bg: string; title: string }> = {
  went_well: { bg: 'bg-green-50 dark:bg-green-950/20', title: 'text-green-800 dark:text-green-300' },
  went_badly: { bg: 'bg-orange-50 dark:bg-orange-950/20', title: 'text-orange-800 dark:text-orange-300' },
  do_differently: { bg: 'bg-blue-50 dark:bg-blue-950/20', title: 'text-blue-800 dark:text-blue-300' },
};

interface CardProps {
  lesson: Lesson;
  onEdit: (lesson: Lesson) => void;
  onDelete: (lesson: Lesson) => void;
}

function LessonCard({ lesson, onEdit, onDelete }: Readonly<CardProps>) {
  const { t, plural } = useI18n();
  const copy = t.flowClosing.close.lessons;
  const { abilities, userId, isManager, memberOf, projectId } = useClose();
  const toggle = useToggleLessonVote(projectId);
  const author = memberOf(lesson.authorId);
  const authorName = author?.name ?? t.flowClosing.shared.unknownMember;
  const mayChange = canChangeLesson(lesson, userId, isManager);
  const voting = toggle.isPending && toggle.variables?.id === lesson.id;

  const vote = () =>
    toggle.mutate(
      { id: lesson.id, vote: !lesson.votedByMe },
      { onError: (error) => toast.error(apiMessage(error, copy.voteFailed)) },
    );

  return (
    <article className="rounded-lg border bg-card px-3 py-2.5">
      <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{lesson.text}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <PersonAvatar name={authorName} avatar={author?.avatar} className="size-[22px]" />
        <span className="min-w-0 truncate text-xs text-muted-foreground">{authorName}</span>
        {lesson.knowPageId ? (
          <Link
            href={`/weldknow/page/${lesson.knowPageId}`}
            aria-label={copy.publishedAria}
            className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground/80 hover:underline"
          >
            {copy.published}
          </Link>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {abilities.editLessons && mayChange ? (
            <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={copy.edit} title={copy.edit} onClick={() => onEdit(lesson)}>
              <Pencil aria-hidden className="size-3.5" />
            </Button>
          ) : null}
          {abilities.deleteLessons && mayChange ? (
            <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={copy.deleteLesson} title={copy.deleteLesson} onClick={() => onDelete(lesson)}>
              <Trash2 aria-hidden className="size-3.5" />
            </Button>
          ) : null}
          <button
            type="button"
            aria-pressed={lesson.votedByMe}
            aria-label={plural(lesson.voteCount, copy.vote)}
            disabled={!abilities.voteLessons || voting}
            onClick={vote}
            className={cn(
              'inline-flex h-[26px] items-center gap-1 rounded-full border px-2 text-xs tabular-nums outline-none transition-colors',
              'focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default',
              lesson.votedByMe ? 'border-foreground bg-foreground text-background' : 'text-foreground/80 hover:bg-accent disabled:hover:bg-transparent',
            )}
          >
            <ChevronUp aria-hidden className="size-3" strokeWidth={2.4} />
            {lesson.voteCount}
          </button>
        </div>
      </div>
    </article>
  );
}

/** The lessons board: went well, didn't go well, do differently. */
export function LessonsBoard() {
  const { t, plural, format } = useI18n();
  const copy = t.flowClosing.close.lessons;
  const { projectId, abilities } = useClose();
  const query = useLessons(projectId);
  const remove = useDeleteLesson();
  const [dialog, setDialog] = useState<LessonDialogState | null>(null);
  const [deleting, setDeleting] = useState<Lesson | null>(null);
  const [publishing, setPublishing] = useState(false);

  const lessons = useMemo(() => query.data ?? [], [query.data]);
  const columns = useMemo(() => lessonsByCategory(lessons), [lessons]);
  const publishedCount = lessons.filter((lesson) => lesson.knowPageId !== null).length;

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      toast.success(copy.deleteConfirm.success);
      setDeleting(null);
    } catch (error) {
      toast.error(apiMessage(error, copy.deleteConfirm.failed));
    }
  };

  return (
    <section aria-labelledby="close-lessons-title" className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <h3 id="close-lessons-title" className="text-sm font-semibold">
          {copy.title}
        </h3>
        {query.data ? (
          <span className="text-xs text-muted-foreground">
            {[plural(lessons.length, copy.summary), publishedCount > 0 ? format(copy.publishedSummary, { count: publishedCount }) : null]
              .filter(Boolean)
              .join(' · ')}
          </span>
        ) : null}
        <div className="flex-1" />
        {abilities.addLessons ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setDialog({ mode: 'create', category: 'went_well' })}>
            <Plus aria-hidden />
            {copy.add}
          </Button>
        ) : null}
        {abilities.publishLessons ? (
          <Button type="button" variant="outline" size="sm" disabled={lessons.length === 0} onClick={() => setPublishing(true)} title={lessons.length === 0 ? copy.publishNeedsLessons : undefined}>
            {copy.publish}
          </Button>
        ) : null}
      </div>

      {query.isLoading ? (
        <div role="status" aria-busy="true" className="mt-3 grid gap-3 md:grid-cols-3">
          {LESSON_COLUMNS.map((category) => (
            <Skeleton key={category} className="h-40 rounded-lg" />
          ))}
        </div>
      ) : null}

      {!query.isLoading && query.isError ? (
        <div role="alert" className="mt-3 flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-8 text-center">
          <p className="text-sm text-destructive">{copy.loadFailed}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
            {t.flowClosing.shared.retry}
          </Button>
        </div>
      ) : null}

      {!query.isLoading && !query.isError ? (
        <div className="mt-3 grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(17rem,1fr))]">
          {LESSON_COLUMNS.map((category) => {
            const items = columns[category];
            return (
              <div key={category} role="group" aria-label={copy.columns[category]} className={cn('flex flex-col gap-2 rounded-lg p-3', COLUMN_STYLE[category].bg)}>
                <div className="flex items-center gap-2">
                  <h4 className={cn('text-[13px] font-semibold', COLUMN_STYLE[category].title)}>
                    {copy.columns[category]} <span className="font-medium text-muted-foreground">{items.length}</span>
                  </h4>
                  {abilities.addLessons ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="ml-auto size-6"
                      aria-label={format(copy.addToColumn, { column: copy.columns[category] })}
                      onClick={() => setDialog({ mode: 'create', category })}
                    >
                      <Plus aria-hidden className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
                {items.length === 0 ? (
                  <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">{copy.emptyColumn[category]}</p>
                ) : (
                  items.map((lesson) => <LessonCard key={lesson.id} lesson={lesson} onEdit={(l) => setDialog({ mode: 'edit', lesson: l })} onDelete={setDeleting} />)
                )}
              </div>
            );
          })}
        </div>
      ) : null}

      <LessonDialog state={dialog} onClose={() => setDialog(null)} />
      <PublishDialog open={publishing} onClose={() => setPublishing(false)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        title={copy.deleteConfirm.title}
        description={copy.deleteConfirm.description}
        confirmLabel={copy.deleteConfirm.confirm}
        cancelLabel={t.flowClosing.shared.cancel}
        variant="destructive"
        onConfirm={confirmDelete}
      />
    </section>
  );
}
