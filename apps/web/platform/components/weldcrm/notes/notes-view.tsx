
import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Dialog,
  DialogTitle,
  DialogPortal,
} from '@weldsuite/ui/components/dialog';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  Building,
  Star,
  Trash2,
  Bot,
  X,
  Minus,
  Pin as PinIcon,
  Maximize,
  EllipsisVertical,
  Pencil,
  Contact,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format, isToday, isYesterday, isThisWeek, isThisMonth, isThisYear, subWeeks } from 'date-fns';
import {
  useCreateNote,
  useUpdateNote,
  useDeleteNote,
  useToggleNoteFavorite,
} from '@/hooks/queries/use-notes-queries';
import { toast } from 'sonner';
import { RecordSelectionModal, type SelectableRecord, type RecordKind } from '@/components/objects/_shared/record-selection-modal';
import { useObjectPanel } from '@/components/object-panel';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { useUser } from '@clerk/clerk-react';
import { usePinnedNote } from '@/contexts/pinned-note-context';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig, type ActiveFilter, type RowHandlers } from '@/components/entity-list';
import { BlockEditor, StaticFormattingToolbar, type BlockNoteEditorInstance } from '@/components/block-editor/block-editor';
import type { Block } from '@blocknote/core';
import { useTranslations } from '@weldsuite/i18n/client';

interface Note {
  id: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  isPinned?: boolean;
  recordKind?: RecordKind;
  recordId?: string;
  recordName?: string;
  recordAvatar?: string;
  authorName?: string;
  authorAvatar?: string;
}

interface NotesViewProps {
  initialNotes?: Note[];
}

// Helper to strip HTML tags
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

// Helper to get note title from content
function getNoteTitle(content: string): string {
  if (!content) return 'Untitled';

  // Try to find first h1, h2, or h3 using regex
  const headingMatch = content.match(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/i);
  if (headingMatch && headingMatch[1]) {
    const title = stripHtml(headingMatch[1]).trim();
    if (title) return title;
  }

  // Fallback to first text line
  const text = stripHtml(content);
  const firstLine = text.split('\n')[0]?.trim() || 'Untitled';
  return firstLine || 'Untitled';
}

// Helper to format date for display
function formatNoteDate(date: Date, t: (key: string) => string): string {
  if (isToday(date)) return t('sweep.weldcrm.notesView.today');
  if (isYesterday(date)) return t('sweep.weldcrm.notesView.yesterday');
  return format(date, 'MMM d, yyyy');
}

// Helper to get record icon based on kind
function getRecordIcon(note: { recordKind?: RecordKind; recordName?: string }) {
  if (note.recordKind === 'person') return <Contact className="h-3 w-3 text-emerald-600" />;
  if (note.recordName?.toLowerCase().includes('weld')) {
    return <Bot className="h-3 w-3 text-muted-foreground" />;
  }
  return <Building className="h-3 w-3 text-muted-foreground" />;
}

// Get the record's display name from the note
function getRecordName(note: { recordName?: string }): string | undefined {
  return note.recordName;
}

// Note Editor Dialog
function NoteEditorDialog({
  note,
  open,
  onOpenChange,
  onSave,
  onDelete,
}: {
  note: Note | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (content: string) => Promise<void>;
  onDelete: () => void;
}) {
  const t = useTranslations();
  const { setPinnedNote, setIsOpen: setGlobalPinnedOpen, setOnSave, setOnDelete, setStartMinimized } = usePinnedNote();
  const [title, setTitle] = useState('');
  const titleRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<BlockNoteEditorInstance | null>(null);
  const editorRef = useRef<BlockNoteEditorInstance | null>(null);
  const currentBlocksRef = useRef<Block[]>([]);
  const [initialHtml, setInitialHtml] = useState<string | undefined>(undefined);
  const [isSaving, setIsSaving] = useState(false);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedContentRef = useRef<string>('');
  const [isMinimized, setIsMinimized] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [isTransitioningToPin, setIsTransitioningToPin] = useState(false);

  const handleEditorReady = useCallback((e: BlockNoteEditorInstance) => {
    setEditor(e);
    editorRef.current = e;
  }, []);

  const composeFullContent = useCallback((): string => {
    const ed = editorRef.current;
    let bodyHtml = '';
    if (ed) {
      try {
        bodyHtml = (ed as unknown as { blocksToHTMLLossy: (blocks: Block[]) => string })
          .blocksToHTMLLossy(currentBlocksRef.current);
      } catch {
        bodyHtml = '';
      }
    }
    return title ? `<h1>${title}</h1>${bodyHtml}` : bodyHtml;
  }, [title]);

  // Handle pinning - transfer to global pinned note
  const handlePinToGlobal = useCallback(() => {
    if (note) {
      const currentContent = editorRef.current ? composeFullContent() : note.content;
      const updatedNote = { ...note, content: currentContent };
      setIsTransitioningToPin(true);
      setPinnedNote(updatedNote);
      setOnSave(onSave);
      setOnDelete(onDelete);
      setGlobalPinnedOpen(true);
      // Close dialog after a frame so opacity-0 renders first (avoids shrink animation)
      requestAnimationFrame(() => {
        onOpenChange(false);
        // Reset after dialog is closed
        setTimeout(() => setIsTransitioningToPin(false), 0);
      });
    }
  }, [note, composeFullContent, onSave, onDelete, setPinnedNote, setOnSave, setOnDelete, setGlobalPinnedOpen, onOpenChange]);

  // Extract title and content from note. Also writes the title directly to
  // the contenteditable DOM so the placeholder/value reflect the latest note
  // without the title state echoing back through React (which would reset
  // the caret position while the user is typing).
  useEffect(() => {
    if (!note || !open) return;
    const noteTitle = getNoteTitle(note.content);
    const resolvedTitle = noteTitle === 'Untitled' ? '' : noteTitle;
    setTitle(resolvedTitle);
    lastSavedContentRef.current = note.content;

    const htmlWithoutTitle = note.content.replace(/<h[1-3][^>]*>.*?<\/h[1-3]>/i, '');
    setInitialHtml(htmlWithoutTitle || '');

    requestAnimationFrame(() => {
      if (titleRef.current) {
        if (resolvedTitle) {
          titleRef.current.textContent = resolvedTitle;
        } else {
          titleRef.current.innerHTML = '';
        }
      }
    });
  }, [note, open]);

  // Flush any pending save immediately (used on close)
  const flushSave = useCallback(async () => {
    if (!note) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }

    const fullContent = composeFullContent();

    if (fullContent === lastSavedContentRef.current) return;

    try {
      await onSave(fullContent);
      lastSavedContentRef.current = fullContent;
    } catch (error) {
      console.error('Save on close failed:', error);
    }
  }, [note, composeFullContent, onSave]);

  // Auto-save with debounce
  const triggerAutoSave = useCallback(() => {
    if (!note) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(async () => {
      const fullContent = composeFullContent();

      if (fullContent === lastSavedContentRef.current) return;

      setIsSaving(true);
      try {
        await onSave(fullContent);
        lastSavedContentRef.current = fullContent;
      } catch (error) {
        console.error('Auto-save failed:', error);
      }
      setIsSaving(false);
    }, 1000);
  }, [note, composeFullContent, onSave]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  const handleBlocksChange = useCallback((blocks: Block[]) => {
    currentBlocksRef.current = blocks;
    triggerAutoSave();
  }, [triggerAutoSave]);

  const handleTitleInput = useCallback(
    (e: React.FormEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      const text = el.textContent || '';
      // contentEditable often leaves a stray <br> behind after the user
      // backspaces the last character, which prevents the :empty CSS pseudo
      // from matching — so the placeholder wouldn't come back.
      if (!text && el.innerHTML !== '') {
        el.innerHTML = '';
      }
      setTitle(text);
      triggerAutoSave();
    },
    [triggerAutoSave],
  );

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const editorEl = document.querySelector('.bn-editor') as HTMLElement | null;
        editorEl?.focus();
      }
    },
    [],
  );

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && isPinned) return;
    if (!newOpen) {
      flushSave();
      setIsMinimized(false);
      setIsPinned(false);
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPortal>
        <DialogPrimitive.Content
          onPointerDownOutside={(e) => isPinned && e.preventDefault()}
          onInteractOutside={(e) => isPinned && e.preventDefault()}
          className={cn(
            "bg-background fixed z-50 rounded-lg p-0 flex flex-col gap-0 transition-all duration-200",
            isTransitioningToPin ? "opacity-0 pointer-events-none" : "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
            isMinimized
              ? "bottom-4 right-4 top-auto left-auto translate-x-0 translate-y-0 rounded-xl"
              : isPinned
                ? "bottom-4 right-4 top-auto left-auto translate-x-0 translate-y-0"
                : "top-[50%] left-[50%] translate-x-[-50%] translate-y-[-50%]"
          )}
          style={isMinimized
            ? { width: '320px', height: '50px', boxShadow: '0 2px 4px rgba(0, 0, 0, 0.06), 0 24px 56px -4px rgba(0, 0, 0, 0.2)', border: '1px solid hsl(var(--border))' }
            : isPinned
              ? { width: '440px', maxWidth: '90vw', height: '500px', boxShadow: '0 2px 4px rgba(0, 0, 0, 0.06), 0 24px 56px -4px rgba(0, 0, 0, 0.2)', border: '1px solid hsl(var(--border))' }
              : { width: '890px', maxWidth: '90vw', height: '935px', maxHeight: '90vh', boxShadow: '0 2px 4px rgba(0, 0, 0, 0.06), 0 24px 56px -4px rgba(0, 0, 0, 0.2)', border: '1px solid hsl(var(--border))' }
          }
        >
        {isMinimized ? (
          <div className="flex items-center h-full px-4">
            <DialogTitle className="sr-only">{t('sweep.weldcrm.noteEditorDialog.editNote')}</DialogTitle>
            <div className="flex items-center gap-2 flex-1 min-w-0">
              {note?.recordName && (
                <div className="flex items-center gap-1.5">
                  <div className="w-4 h-4 rounded flex items-center justify-center bg-primary/10">
                    {note && getRecordIcon(note)}
                  </div>
                </div>
              )}
              <span className="text-sm font-medium truncate">{title || t('sweep.weldcrm.globalPinnedNote.untitled')}</span>
              {isSaving && <span className="text-xs text-muted-foreground">{t('sweep.weldcrm.globalPinnedNote.saving')}</span>}
            </div>
          </div>
        ) : (
          <>
            <div className="px-4 border-b flex flex-row items-center justify-between h-[52px]">
              <DialogTitle className="sr-only">{t('sweep.weldcrm.noteEditorDialog.editNote')}</DialogTitle>
              <div className="flex items-center gap-2">
                {note && getRecordName(note) && (
                  <div className="flex items-center gap-1.5">
                    <Avatar className="h-5 w-5 !rounded-[7px] flex-shrink-0">
                      {note.recordAvatar && (
                        <AvatarImage src={note.recordAvatar} alt={getRecordName(note)} className="!rounded-[7px]" />
                      )}
                      <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                        {getRecordName(note)!.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="text-sm font-medium">{getRecordName(note)}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden [&::-webkit-scrollbar]:w-[5px] [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-black/5 [&::-webkit-scrollbar-thumb]:rounded-full">
              <div className="max-w-[760px] mx-auto w-full px-12 pt-[70px] pb-10">
                <div
                  ref={titleRef}
                  contentEditable
                  suppressContentEditableWarning
                  onInput={handleTitleInput}
                  onKeyDown={handleTitleKeyDown}
                  data-placeholder={t('sweep.weldcrm.globalPinnedNote.untitled')}
                  className="text-4xl font-bold text-foreground outline-none mb-1 break-words empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/50"
                />
                <div className="mt-4 -ml-[53px] -mr-12">
                  <BlockEditor
                    key={note?.id}
                    initialHtml={initialHtml}
                    onContentChange={handleBlocksChange}
                    onEditorReady={handleEditorReady}
                  />
                </div>
              </div>
            </div>

            <div className="px-3 py-2 border-t">
              {editor ? (
                <StaticFormattingToolbar editor={editor} />
              ) : (
                <div className="h-[30px]" />
              )}
            </div>
          </>
        )}

        {/* Window controls */}
          <div className={cn("absolute right-3 flex items-center gap-1", isMinimized ? "top-1/2 -translate-y-1/2" : "top-3")}>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                if (isMinimized) {
                  setIsMinimized(false);
                } else {
                  // Transfer to global pinned note in minimized state so it persists across pages
                  setStartMinimized(true);
                  handlePinToGlobal();
                }
              }}
              className="rounded-md p-1.5 text-gray-500 transition-colors hover:text-gray-900 hover:bg-gray-100 dark:hover:bg-secondary"
              title={isMinimized ? t('sweep.weldcrm.globalPinnedNote.expand') : t('sweep.weldcrm.globalPinnedNote.minimize')}
            >
              {isMinimized ? <Maximize className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                if (isMinimized) {
                  setStartMinimized(false);
                  handlePinToGlobal();
                } else if (isPinned) {
                  setIsPinned(false);
                } else {
                  setStartMinimized(false);
                  handlePinToGlobal();
                }
              }}
              className={cn(
                "rounded-md p-1.5 transition-colors hover:text-gray-900 hover:bg-gray-100 dark:hover:bg-secondary",
                isPinned && !isMinimized ? "text-blue-500" : "text-gray-500"
              )}
              title={t('sweep.weldcrm.noteEditorDialog.pinToScreen')}
            >
              <PinIcon className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                flushSave();
                setIsPinned(false);
                onOpenChange(false);
              }}
              className="rounded-md p-1.5 text-gray-500 transition-colors hover:text-gray-900 hover:bg-gray-100 dark:hover:bg-secondary"
              title={t('sweep.weldcrm.globalPinnedNote.close')}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

export function NotesView({ initialNotes = [] }: NotesViewProps) {
  const t = useTranslations();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useUser();
  const { setOnUnpin } = usePinnedNote();
  const { open: openPanel } = useObjectPanel();
  const createNoteMutation = useCreateNote();
  const updateNoteMutation = useUpdateNote();
  const deleteNoteMutation = useDeleteNote();
  const toggleFavoriteMutation = useToggleNoteFavorite();
  const [notes, setNotes] = useState<Note[]>(initialNotes);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [showRecordSelection, setShowRecordSelection] = useState(false);

  // Auto-open new-note flow when ?new=1 is present (e.g. from onboarding checklist)
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setShowRecordSelection(true);
      const params = new URLSearchParams(searchParams.toString());
      params.delete('new');
      const query = params.toString();
      router.replace(`/weldcrm/notes${query ? `?${query}` : ''}`);
    }
  }, [searchParams, router]);

  // Set onUnpin callback to reopen note in dialog
  useEffect(() => {
    setOnUnpin((note: Note) => {
      setSelectedNote(note);
      setShowEditor(true);
    });
    return () => setOnUnpin(null);
  }, [setOnUnpin]);

  // Memoize available records for filters
  const availableRecords = useMemo(() =>
    Array.from(new Set(notes.map(n => n.recordName).filter(Boolean))) as string[],
    [notes]
  );

  const availableAuthors = useMemo(() =>
    Array.from(new Set(notes.map(n => n.authorName).filter(Boolean))) as string[],
    [notes]
  );

  // Filter configurations
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'record',
      label: t('sweep.weldcrm.notesView.record'),
      options: availableRecords.map(name => ({ value: name, label: name })),
    },
    {
      field: 'author',
      label: t('sweep.weldcrm.notesView.author'),
      options: availableAuthors.map(name => ({ value: name, label: name })),
    },
  ], [availableRecords, availableAuthors, t]);

  // Group configurations by time
  const groupConfigs: GroupConfig<Note>[] = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
    const lastWeekStart = subWeeks(new Date(), 1);

    return [
      {
        id: 'today',
        label: t('sweep.weldcrm.notesView.createdToday'),
        sortOrder: 1,
        filter: (n) => isToday(new Date(n.createdAt)),
      },
      {
        id: 'yesterday',
        label: t('sweep.weldcrm.notesView.createdYesterday'),
        sortOrder: 2,
        filter: (n) => isYesterday(new Date(n.createdAt)),
      },
      {
        id: 'this-week',
        label: t('sweep.weldcrm.notesView.createdThisWeek'),
        sortOrder: 3,
        filter: (n) => {
          const d = new Date(n.createdAt);
          return isThisWeek(d, { weekStartsOn: 1 }) && !isToday(d) && !isYesterday(d);
        },
      },
      {
        id: 'this-month',
        label: t('sweep.weldcrm.notesView.createdThisMonth'),
        sortOrder: 4,
        filter: (n) => {
          const d = new Date(n.createdAt);
          return isThisMonth(d) && !isThisWeek(d, { weekStartsOn: 1 });
        },
      },
      {
        id: 'this-year',
        label: t('sweep.weldcrm.notesView.createdThisYear'),
        sortOrder: 5,
        filter: (n) => {
          const d = new Date(n.createdAt);
          return isThisYear(d) && !isThisMonth(d);
        },
      },
      {
        id: 'older',
        label: t('sweep.weldcrm.notesView.older'),
        sortOrder: 6,
        filter: (n) => !isThisYear(new Date(n.createdAt)),
      },
    ];
  }, [t]);

  // Apply filters
  const applyFilters = useCallback((items: Note[], filters: ActiveFilter[]) => {
    let result = items;

    filters.forEach(filter => {
      if (!filter.operator || !filter.value) return;

      if (filter.field === 'record') {
        result = filter.operator === 'is'
          ? result.filter(n => n.recordName === filter.value)
          : result.filter(n => n.recordName !== filter.value);
      } else if (filter.field === 'author') {
        result = filter.operator === 'is'
          ? result.filter(n => n.authorName === filter.value)
          : result.filter(n => n.authorName !== filter.value);
      }
    });

    return result;
  }, []);

  // Handlers
  const openEditDialog = useCallback((note: Note) => {
    setSelectedNote(note);
    setShowEditor(true);
  }, []);

  const handleDialogClose = useCallback((open: boolean) => {
    setShowEditor(open);
    if (!open) {
      setSelectedNote(null);
    }
  }, []);

  const handleSave = async (noteId: string, content: string) => {
    try {
      await updateNoteMutation.mutateAsync({ id: noteId, data: { description: content } });
      setNotes((prev) =>
        prev.map((n) => (n.id === noteId ? { ...n, content, updatedAt: new Date() } : n))
      );
    } catch (error: any) {
      throw new Error(error?.message || t('sweep.weldcrm.notesView.failedToUpdateNote'));
    }
  };

  const handleCreate = async (record: SelectableRecord) => {
    try {
      const result = await createNoteMutation.mutateAsync({
        subject: 'Note',
        description: '',
        recordKind: record.kind,
        recordId: record.id,
        recordName: record.displayName,
      });
      if (result?.id) {
        const newNote: Note = {
          id: result.id,
          content: '',
          createdAt: new Date(),
          updatedAt: new Date(),
          isPinned: false,
          recordKind: record.kind,
          recordId: record.id,
          recordName: record.displayName,
          recordAvatar: record.avatarUrl,
          authorName: user?.fullName || user?.firstName || user?.primaryEmailAddress?.emailAddress || t('sweep.weldcrm.notesView.you'),
          authorAvatar: user?.imageUrl || undefined,
        };
        setNotes([newNote, ...notes]);
        setSelectedNote(newNote);
        setShowEditor(true);
      } else {
        toast.error(t('sweep.weldcrm.notesView.failedToCreateNote'));
      }
    } catch (error) {
      console.error('Failed to create note:', error);
      toast.error(t('sweep.weldcrm.notesView.failedToCreateNote'));
    }
  };

  const handleDelete = async (noteId: string) => {
    try {
      await deleteNoteMutation.mutateAsync(noteId);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      setShowEditor(false);
      setSelectedNote(null);
      toast.success(t('sweep.weldcrm.notesView.noteDeleted'));
    } catch (error) {
      toast.error(t('sweep.weldcrm.notesView.failedToDeleteNote'));
    }
  };

  const handleToggleFavorite = async (noteId: string) => {
    const current = notes.find((n) => n.id === noteId);
    const next = !current?.isPinned;
    // Optimistic flip — keeps the star snappy.
    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, isPinned: next } : n))
    );
    try {
      await toggleFavoriteMutation.mutateAsync({ id: noteId, isFavorite: next });
    } catch {
      // Roll back on failure.
      setNotes((prev) =>
        prev.map((n) => (n.id === noteId ? { ...n, isPinned: !next } : n))
      );
      toast.error(t('sweep.weldcrm.notesView.failedToUpdateFavorite'));
    }
  };

  const handleRecordSelect = async (record: SelectableRecord) => {
    setShowRecordSelection(false);
    await handleCreate(record);
  };

  // Row renderer
  const renderNoteRow = useCallback((note: Note, handlers: RowHandlers<Note>) => (
    <div
      key={note.id}
      onClick={() => openEditDialog(note)}
      className="flex items-center gap-4 px-4 py-3 border-b border-gray-200/70 dark:border-border group cursor-pointer hover:bg-gray-50 dark:hover:bg-background/50"
    >
      {/* Favorite */}
      <div className="w-[28px] flex items-center -mr-4" onClick={(e) => e.stopPropagation()}>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => handleToggleFavorite(note.id)}
          className="p-1 rounded-md hover:bg-gray-100 dark:hover:bg-secondary"
        >
          <Star className={cn("h-[15px] w-[15px]", note.isPinned ? "fill-yellow-400 text-yellow-400" : "text-gray-300 hover:text-gray-400")} />
        </Button>
      </div>

      {/* Note Title */}
      <div className="flex items-center gap-2 flex-1 min-w-[200px]">
        <span className="text-sm font-medium text-gray-900 dark:text-foreground truncate">
          {(() => {
            const noteTitle = getNoteTitle(note.content);
            return noteTitle === 'Untitled' ? t('sweep.weldcrm.globalPinnedNote.untitled') : noteTitle;
          })()}
        </span>
      </div>

      {/* Record */}
      <div className="w-[180px] overflow-hidden">
        {getRecordName(note) ? (
          (() => {
            const canOpenPanel = !!(note.recordId && note.recordKind);
            const content = (
              <>
                <Avatar className="h-5 w-5 !rounded-[7px] flex-shrink-0">
                  {note.recordAvatar && (
                    <AvatarImage src={note.recordAvatar} alt={getRecordName(note)} className="!rounded-[7px]" />
                  )}
                  <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                    {getRecordName(note)!.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm text-foreground/80 truncate min-w-0 group-hover/record:text-primary group-hover/record:underline">
                  {getRecordName(note)}
                </span>
              </>
            );
            return canOpenPanel ? (
              <Button
                variant="ghost"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openPanel({
                    type: note.recordKind === 'person' ? 'person' : 'company',
                    id: note.recordId!,
                    stack: true,
                  });
                }}
                className="group/record flex items-center gap-1.5 w-full min-w-0 text-left hover:underline-offset-2"
              >
                {content}
              </Button>
            ) : (
              <div className="flex items-center gap-1.5 w-full min-w-0">{content}</div>
            );
          })()
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        )}
      </div>

      {/* Author */}
      <div className="w-[150px]">
        {note.authorName ? (
          <div className="flex items-center gap-1.5 min-w-0">
            <Avatar className="h-5 w-5 !rounded-[7px] flex-shrink-0">
              {note.authorAvatar && (
                <AvatarImage src={note.authorAvatar} alt={note.authorName} className="!rounded-[7px]" />
              )}
              <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                {note.authorName.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="text-sm text-foreground/80 truncate min-w-0">
              {note.authorName}
            </span>
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        )}
      </div>

      {/* Date */}
      <div className="w-[120px]">
        <span className="text-sm font-mono text-gray-500">
          {formatNoteDate(new Date(note.createdAt), t)}
        </span>
      </div>

      {/* Actions */}
      <div className="w-[40px] flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
              <EllipsisVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); openEditDialog(note); }}>
              <Pencil className="mr-0.5 h-4 w-4" />
              {t('sweep.weldcrm.notesView.edit')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleToggleFavorite(note.id); }}>
              <Star className={cn("mr-0.5 h-4 w-4", note.isPinned && "fill-yellow-400 text-yellow-400")} />
              {note.isPinned ? t('sweep.weldcrm.notesView.unfavorite') : t('sweep.weldcrm.notesView.favorite')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={(e) => { e.stopPropagation(); handleDelete(note.id); }}
              className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
            >
              <Trash2 className="mr-0.5 h-4 w-4 text-red-500" />
              {t('sweep.weldcrm.notesView.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  ), [notes, openEditDialog, t]);

  // Header column definitions
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'favorite', header: '', width: 'w-[28px] -mr-4' },
    { id: 'title', header: t('sweep.weldcrm.notesView.title'), width: 'flex-1 min-w-[200px] -ml-6' },
    { id: 'record', header: t('sweep.weldcrm.notesView.record'), width: 'w-[180px]' },
    { id: 'author', header: t('sweep.weldcrm.notesView.author'), width: 'w-[150px]' },
    { id: 'date', header: t('sweep.weldcrm.notesView.created'), width: 'w-[120px]' },
  ], [t]);

  // Sort notes: favorited first, then by date descending
  const sortedNotes = useMemo(() =>
    [...notes].sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    }),
    [notes]
  );

  return (
    <>
      <EntityList<Note>
        items={sortedNotes}
        isLoading={false}
        headerColumns={headerColumns}
        filters={filterConfigs}
        groups={groupConfigs}
        maxFilters={3}
        applyFilters={applyFilters}
        onDeleteItem={(id) => handleDelete(id)}
        renderRow={renderNoteRow}
        searchPlaceholder={t('sweep.weldcrm.notesView.searchPlaceholder')}
        searchFields={['content']}
        createButton={{
          label: t('sweep.weldcrm.notesView.newNote'),
          onClick: () => setShowRecordSelection(true),
        }}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <svg width="120" height="120" viewBox="-6 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
                {/* Pencil */}
                <g transform="rotate(-45 60 60)">
                  {/* Pencil body */}
                  <rect x="50" y="20" width="12" height="64" rx="1" className="fill-white dark:fill-white/[0.03]" />
                  <rect x="50" y="20" width="12" height="64" rx="1" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                  {/* Pencil stripe */}
                  <rect x="50" y="20" width="12" height="8" rx="1" className="fill-gray-100 dark:fill-white/8" />
                  <rect x="50" y="20" width="12" height="8" rx="1" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                  {/* Pencil tip */}
                  <path d="M50 84L56 96L62 84" className="fill-gray-50 dark:fill-white/[0.06]" />
                  <path d="M50 84L56 96L62 84" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                  {/* Tip point */}
                  <path d="M54 90L56 96L58 90" className="fill-gray-300 dark:fill-white/20" />
                </g>
                {/* Writing line scribble */}
                <path d="M30 94C36 90 42 94 48 90C54 86 60 90 66 86" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1.2" strokeLinecap="round" fill="none" />
              </svg>
            </EmptyStateIllustration>
          ),
          title: t('sweep.weldcrm.notesView.noNotesYet'),
          description: t('sweep.weldcrm.notesView.noNotesYetDescription'),
          action: {
            label: t('sweep.weldcrm.notesView.newNote'),
            onClick: () => setShowRecordSelection(true),
          },
        }}
        noResultsState={{
          title: t('sweep.weldcrm.notesView.noNotesFound'),
          description: t('sweep.weldcrm.notesView.noNotesFoundDescription'),
        }}
        dialogComponent={
          <>
            <NoteEditorDialog
              note={selectedNote}
              open={showEditor}
              onOpenChange={handleDialogClose}
              onSave={async (content) => {
                if (selectedNote) {
                  await handleSave(selectedNote.id, content);
                  setNotes((prev) =>
                    prev.map((n) =>
                      n.id === selectedNote.id ? { ...n, content, updatedAt: new Date() } : n
                    )
                  );
                }
              }}
              onDelete={() => {
                if (selectedNote) {
                  handleDelete(selectedNote.id);
                }
              }}
            />
            <RecordSelectionModal
              open={showRecordSelection}
              onOpenChange={setShowRecordSelection}
              onSelectRecord={handleRecordSelect}
            />
          </>
        }
      />
    </>
  );
}
