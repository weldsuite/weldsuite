/**
 * `NotesTab` — Notes tab for the company / person object panels.
 *
 * Lists notes that have been attached to the current entity (via
 * `customerId` for companies, `contactId` for persons — both written by
 * `/weldcrm/notes` and by this tab itself). Clicking a row opens
 * `NoteEditorDialog` for inline edit + auto-save. "New note" creates a
 * note pre-attached to this entity (no record-selection step needed).
 */

import { useCallback, useMemo, useState } from 'react';
import { Plus, StickyNote, Trash2 } from 'lucide-react';
import { format, isToday, isYesterday } from 'date-fns';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  useNotes,
  useCreateNote,
  useUpdateNote,
  useDeleteNote,
} from '@/hooks/queries/use-notes-queries';
import { NoteEditorDialog, type Note as DialogNote } from '@/components/weldcrm/notes/note-editor-dialog';
import { Button } from '@weldsuite/ui/components/button';

type EntityKind = 'company' | 'person';

interface NotesTabProps {
  entityId: string;
  entityKind: EntityKind;
  entityName?: string;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

function getNoteTitle(content: string, untitledLabel: string): string {
  if (!content) return untitledLabel;
  const heading = content.match(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/i);
  if (heading?.[1]) {
    const headingText = stripHtml(heading[1]).trim();
    if (headingText) return headingText;
  }
  const text = stripHtml(content);
  return text.split('\n')[0]?.trim() || untitledLabel;
}

function getNotePreview(content: string): string {
  if (!content) return '';
  return stripHtml(content.replace(/<h[1-3][^>]*>.*?<\/h[1-3]>/i, ''));
}

function formatNoteDate(date: Date, todayLabel: string, yesterdayLabel: string): string {
  if (isToday(date)) return todayLabel;
  if (isYesterday(date)) return yesterdayLabel;
  return format(date, 'MMM d, yyyy');
}

export function NotesTab({ entityId, entityKind, entityName }: NotesTabProps) {
  const t = useTranslations();
  const filters = useMemo(
    () => (entityKind === 'company' ? { companyId: entityId } : { personId: entityId }),
    [entityId, entityKind],
  );

  const { data, isLoading } = useNotes(filters);
  const createMut = useCreateNote();
  const updateMut = useUpdateNote();
  const deleteMut = useDeleteNote();

  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const notes = useMemo(() => {
    const rows = data?.data ?? [];
    return rows
      .map((a: Record<string, unknown>) => ({
        id: String(a.id),
        content: (a.description as string) ?? '',
        createdAt: new Date(a.createdAt as string),
        updatedAt: new Date((a.updatedAt as string) ?? (a.createdAt as string)),
      }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }, [data]);

  const activeNote = useMemo<DialogNote | null>(() => {
    if (!activeNoteId) return null;
    const n = notes.find((x) => x.id === activeNoteId);
    if (!n) return null;
    return {
      id: n.id,
      content: n.content,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      customerName: entityName,
    };
  }, [activeNoteId, notes, entityName]);

  const handleCreate = useCallback(async () => {
    try {
      const res = await createMut.mutateAsync({
        subject: 'Note',
        description: '',
        recordKind: entityKind === 'company' ? 'company' : 'person',
        recordId: entityId,
        recordName: entityName,
      });
      if (res?.id) {
        setActiveNoteId(res.id);
        setOpen(true);
      } else {
        toast.error(t('sweep.entities.createNoteFailed'));
      }
    } catch {
      toast.error(t('sweep.entities.createNoteFailed'));
    }
  }, [createMut, entityId, entityKind, entityName, t]);

  const handleSave = useCallback(
    async (content: string) => {
      if (!activeNoteId) return;
      await updateMut.mutateAsync({ id: activeNoteId, data: { description: content } });
    },
    [activeNoteId, updateMut],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteMut.mutateAsync(id);
        if (activeNoteId === id) {
          setOpen(false);
          setActiveNoteId(null);
        }
        toast.success(t('sweep.entities.noteDeleted'));
      } catch {
        toast.error(t('sweep.entities.deleteNoteFailed'));
      }
    },
    [deleteMut, activeNoteId, t],
  );

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          {isLoading
            ? t('sweep.entities.loadingEllipsis')
            : notes.length === 0
              ? t('sweep.entities.noNotesYet')
              : t(
                notes.length === 1
                  ? 'sweep.entities.notesCountSingular'
                  : 'sweep.entities.notesCountPlural',
                { count: notes.length },
              )}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5"
          onClick={handleCreate}
          disabled={createMut.isPending}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('sweep.entities.newNote')}
        </Button>
      </div>

      {!isLoading && notes.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center px-6 py-12 gap-2">
          <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
            <StickyNote className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="text-sm font-medium text-foreground">{t('sweep.entities.noNotesYet')}</div>
          <p className="text-xs text-muted-foreground max-w-[42ch]">
            {t('sweep.entities.noNotesYetDescription')}
          </p>
        </div>
      ) : (
        <ul className="p-2 space-y-0.5">
          {notes.map((n) => {
            const title = getNoteTitle(n.content, t('sweep.entities.untitled'));
            const preview = getNotePreview(n.content);
            return (
              <li key={n.id} className="group/row flex items-center gap-1">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setActiveNoteId(n.id);
                    setOpen(true);
                  }}
                  className="flex-1 text-left text-sm flex items-start justify-between gap-2 hover:bg-muted/50 rounded-md px-2 py-2 transition-colors min-w-0"
                >
                  <span className="flex flex-col min-w-0 flex-1">
                    <span className="text-sm text-foreground truncate font-medium">{title}</span>
                    {preview && preview !== title ? (
                      <span className="text-xs text-muted-foreground truncate">{preview}</span>
                    ) : null}
                  </span>
                  <span className="text-xs font-mono text-muted-foreground flex-shrink-0 pt-0.5">
                    {formatNoteDate(
                      n.createdAt,
                      t('sweep.entities.today'),
                      t('sweep.entities.yesterday'),
                    )}
                  </span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(n.id);
                  }}
                  disabled={deleteMut.isPending}
                  className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 p-1.5 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground transition-[opacity,color,background-color]"
                  aria-label={t('sweep.entities.deleteNote')}
                  title={t('sweep.entities.deleteNote')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <NoteEditorDialog
        note={activeNote}
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setActiveNoteId(null);
        }}
        onSave={handleSave}
        onDelete={() => {
          if (activeNoteId) handleDelete(activeNoteId);
        }}
      />
    </div>
  );
}
