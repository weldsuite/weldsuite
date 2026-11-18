/**
 * `NotesTab` — Notes tab for the company / person object panels.
 *
 * Lists notes that have been attached to the current entity (via
 * `customerId` for companies, `contactId` for persons — both written by
 * `/weldcrm/notes` and by this tab itself) in the standard `EntityList` with
 * `TabListRow` rows, like the panel's other tabs. Clicking a row opens
 * `NoteEditorDialog` for inline edit + auto-save. "New note" opens an empty
 * editor for a note pre-attached to this entity (no record-selection step
 * needed); the note is created by the first save that has text, so closing
 * an untouched editor leaves nothing behind (TASK-1463).
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { format, isThisMonth, isThisWeek, isThisYear, isToday, isYesterday } from 'date-fns';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  useNotes,
  useCreateNote,
  useUpdateNote,
  useDeleteNote,
} from '@/hooks/queries/use-notes-queries';
import { NoteEditorDialog, type Note as DialogNote } from '@/components/weldcrm/notes/note-editor-dialog';
import { DropdownMenuItem, DropdownMenuSeparator } from '@weldsuite/ui/components/dropdown-menu';
import { cn, stripTags } from '@/lib/utils';
import { EntityList, type ActiveFilter, type FilterConfig, type HeaderColumn } from '@/components/entity-list';
import { applySelectFilters } from '@/lib/list-filters';
import { NotesIllustration, TAB_EMPTY_STATE_TABLE_CLASS } from './tab-empty-state';
import { TabListRow } from './tab-list-row';

type EntityKind = 'company' | 'person';

interface NotesTabProps {
  entityId: string;
  entityKind: EntityKind;
  entityName?: string;
}

interface NoteListItem {
  id: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  /** Flattened for the list's search. */
  title: string;
  preview: string;
}

const COLUMN = {
  title: 'min-w-0 flex-1',
  created: 'w-[140px]',
};

function stripHtml(html: string): string {
  return stripTags(html).trim();
}

/** True when the editor holds no text (an empty title and body still carry markup). */
function isBlankNote(html: string): boolean {
  return stripHtml(html.replace(/&nbsp;/gi, ' ')) === '';
}

function getNoteTitle(content: string, untitledLabel: string): string {
  if (!content) return untitledLabel;
  const heading = /<h[1-3][^>]*>(.*?)<\/h[1-3]>/i.exec(content);
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

/** The "Created" filter's buckets; each note falls in exactly one. */
function createdBucket(date: Date): string {
  if (isToday(date)) return 'today';
  if (isYesterday(date)) return 'yesterday';
  if (isThisWeek(date, { weekStartsOn: 1 })) return 'this-week';
  if (isThisMonth(date)) return 'this-month';
  return isThisYear(date) ? 'this-year' : 'older';
}

function applyNoteFilters(items: NoteListItem[], filters: ActiveFilter[]): NoteListItem[] {
  return applySelectFilters(items, filters, {
    created: (n, value) => createdBucket(n.createdAt) === value,
  });
}

function formatNoteDate(date: Date, todayLabel: string, yesterdayLabel: string): string {
  if (isToday(date)) return todayLabel;
  if (isYesterday(date)) return yesterdayLabel;
  return format(date, 'MMM d, yyyy');
}

export function NotesTab({ entityId, entityKind, entityName }: Readonly<NotesTabProps>) {
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
  // A new note being written: shown in the editor until it closes. It only
  // exists on the server once a save has text (`draftIdRef` then holds its id).
  const [draft, setDraft] = useState<DialogNote | null>(null);
  const draftIdRef = useRef<string | null>(null);
  const draftCreateRef = useRef<Promise<string | null> | null>(null);

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
    if (draft) return draft;
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
  }, [draft, activeNoteId, notes, entityName]);

  const handleCreate = useCallback(() => {
    draftIdRef.current = null;
    draftCreateRef.current = null;
    setActiveNoteId(null);
    const now = new Date();
    setDraft({ id: `draft-${now.getTime()}`, content: '', createdAt: now, updatedAt: now, customerName: entityName });
    setOpen(true);
  }, [entityName]);

  /** The new note's id, creating it with `content` on the first save that has text. */
  const ensureDraftNote = useCallback(
    (content: string): Promise<string | null> => {
      if (draftIdRef.current) return Promise.resolve(draftIdRef.current);
      draftCreateRef.current ??= createMut
        .mutateAsync({
          subject: 'Note',
          description: content,
          recordKind: entityKind === 'company' ? 'company' : 'person',
          recordId: entityId,
          recordName: entityName,
        })
        .then((res) => {
          draftIdRef.current = res?.id ?? null;
          if (!draftIdRef.current) toast.error(t('sweep.entities.createNoteFailed'));
          return draftIdRef.current;
        })
        .catch(() => {
          // Let the next save try again.
          draftCreateRef.current = null;
          toast.error(t('sweep.entities.createNoteFailed'));
          return null;
        });
      return draftCreateRef.current;
    },
    [createMut, entityId, entityKind, entityName, t],
  );

  const handleSave = useCallback(
    async (content: string) => {
      if (draft) {
        const creating = !draftIdRef.current && !draftCreateRef.current;
        if (creating && isBlankNote(content)) return;
        const id = await ensureDraftNote(content);
        // The create already carried this content.
        if (!id || creating) return;
        await updateMut.mutateAsync({ id, data: { description: content } });
        return;
      }
      if (!activeNoteId) return;
      await updateMut.mutateAsync({ id: activeNoteId, data: { description: content } });
    },
    [draft, ensureDraftNote, activeNoteId, updateMut],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteMut.mutateAsync(id);
        if (activeNoteId === id || draftIdRef.current === id) {
          setOpen(false);
          setActiveNoteId(null);
          setDraft(null);
        }
        toast.success(t('sweep.entities.noteDeleted'));
      } catch {
        toast.error(t('sweep.entities.deleteNoteFailed'));
      }
    },
    [deleteMut, activeNoteId, t],
  );

  const items = useMemo<NoteListItem[]>(
    () =>
      notes.map((n) => {
        const title = getNoteTitle(n.content, t('sweep.entities.untitled'));
        const preview = getNotePreview(n.content);
        return { ...n, title, preview: preview === title ? '' : preview };
      }),
    [notes, t],
  );

  const filterConfigs = useMemo<FilterConfig[]>(
    () => [
      {
        field: 'created',
        label: t('sweep.weldcrm.notesView.created'),
        options: [
          { value: 'today', label: t('sweep.weldcrm.notesView.today') },
          { value: 'yesterday', label: t('sweep.weldcrm.notesView.yesterday') },
          { value: 'this-week', label: t('sweep.weldcrm.notesSection.thisWeek') },
          { value: 'this-month', label: t('sweep.weldcrm.notesSection.thisMonth') },
          { value: 'this-year', label: t('sweep.weldcrm.notesSection.thisYear') },
          { value: 'older', label: t('sweep.weldcrm.notesView.older') },
        ],
      },
    ],
    [t],
  );

  const headerColumns = useMemo<HeaderColumn[]>(
    () => [
      { id: 'title', header: t('sweep.weldcrm.notesView.title'), width: COLUMN.title },
      { id: 'created', header: t('sweep.weldcrm.notesView.created'), width: COLUMN.created },
    ],
    [t],
  );

  const renderRow = useCallback(
    (n: NoteListItem) => {
      const openNote = () => {
        setActiveNoteId(n.id);
        setOpen(true);
      };
      return (
        <TabListRow
          key={n.id}
          label={n.title}
          onOpen={openNote}
          menuLabel={t('sweep.entities.moreActions')}
          menu={
            <>
              <DropdownMenuItem onClick={openNote}>
                <Pencil />
                {t('sweep.weldcrm.notesView.edit')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={deleteMut.isPending}
                onClick={() => void handleDelete(n.id)}
              >
                <Trash2 />
                {t('sweep.weldcrm.notesView.delete')}
              </DropdownMenuItem>
            </>
          }
        >
          <div className={cn(COLUMN.title, 'flex items-baseline gap-2')}>
            <span className="truncate text-sm font-medium text-foreground">{n.title}</span>
            {n.preview && (
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{n.preview}</span>
            )}
          </div>
          <div className={COLUMN.created}>
            <span className="whitespace-nowrap text-sm tabular-nums">
              {formatNoteDate(n.createdAt, t('sweep.entities.today'), t('sweep.entities.yesterday'))}
            </span>
          </div>
        </TabListRow>
      );
    },
    [deleteMut.isPending, handleDelete, t],
  );

  return (
    <>
      <EntityList<NoteListItem>
        items={items}
        isLoading={isLoading}
        error={null}
        filters={filterConfigs}
        applyFilters={applyNoteFilters}
        headerColumns={headerColumns}
        renderRow={renderRow}
        searchPlaceholder={t('sweep.weldcrm.notesView.searchPlaceholder')}
        searchFields={['title', 'preview']}
        createButton={{
          label: t('sweep.entities.newNote'),
          onClick: handleCreate,
        }}
        emptyStateClassName={TAB_EMPTY_STATE_TABLE_CLASS}
        emptyState={{
          icon: <NotesIllustration />,
          title: t('sweep.entities.noNotesYet'),
          description: t('sweep.entities.noNotesYetDescription'),
          action: {
            label: t('sweep.entities.newNote'),
            onClick: handleCreate,
          },
        }}
        noResultsState={{
          title: t('sweep.weldcrm.notesView.noNotesFound'),
          description: t('sweep.weldcrm.notesView.noNotesFoundDescription'),
        }}
      />

      <NoteEditorDialog
        note={activeNote}
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setActiveNoteId(null);
            setDraft(null);
          }
        }}
        onSave={handleSave}
        onDelete={() => {
          const id = draft ? draftIdRef.current : activeNoteId;
          if (id) {
            void handleDelete(id);
          } else {
            // A new note that was never saved: there is nothing to delete.
            setOpen(false);
            setDraft(null);
          }
        }}
      />
    </>
  );
}
