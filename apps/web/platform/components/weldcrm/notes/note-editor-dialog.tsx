
import { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogPortal,
} from '@weldsuite/ui/components/dialog';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  Building,
  Bot,
  X,
  Bold,
  Italic,
  Underline,
  List as ListIcon,
  ListOrdered,
  Link as LinkIcon,
  Minus,
  Pin as PinIcon,
  Maximize2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePinnedNote } from '@/contexts/pinned-note-context';
import { useTranslations } from '@weldsuite/i18n/client';

export interface Note {
  id: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  isPinned?: boolean;
  customerId?: string;
  customerName?: string;
  authorName?: string;
}

// Helper to get company icon based on name
function getCompanyIcon(name?: string) {
  if (!name) return <Building className="h-3 w-3 text-muted-foreground" />;
  if (name.toLowerCase().includes('weld')) {
    return <Bot className="h-3 w-3 text-muted-foreground" />;
  }
  return <Building className="h-3 w-3 text-muted-foreground" />;
}

// Helper to strip HTML tags
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

// Helper to get note title from content
function getNoteTitle(content: string): string {
  if (!content) return 'Untitled';
  const headingMatch = content.match(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/i);
  if (headingMatch && headingMatch[1]) {
    const title = stripHtml(headingMatch[1]).trim();
    if (title) return title;
  }
  const text = stripHtml(content);
  const firstLine = text.split('\n')[0]?.trim() || 'Untitled';
  return firstLine || 'Untitled';
}

// Helper to get note content preview (excluding title)
function getNotePreview(content: string): string {
  if (!content) return '';
  const preview = content.replace(/<h[1-3][^>]*>.*?<\/h[1-3]>/i, '');
  return stripHtml(preview).trim();
}

const DIALOG_SHADOW = '0 0 60px rgba(0, 0, 0, 0.12), 0 20px 40px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.03)';

// Minimized and pinned dialogs dock to the bottom-right corner
function getDialogPositionClass(isMinimized: boolean, isPinned: boolean): string {
  if (isMinimized || isPinned) {
    return "bottom-4 right-4 top-auto left-auto translate-x-0 translate-y-0";
  }
  return "top-[50%] left-[50%] translate-x-[-50%] translate-y-[-50%]";
}

function getDialogStyle(isMinimized: boolean, isPinned: boolean): React.CSSProperties {
  if (isMinimized) {
    return { width: '320px', height: '56px', boxShadow: DIALOG_SHADOW };
  }
  if (isPinned) {
    return { width: '440px', maxWidth: '90vw', height: '500px', boxShadow: DIALOG_SHADOW };
  }
  return { width: '860px', maxWidth: '90vw', height: '882px', maxHeight: '90vh', boxShadow: DIALOG_SHADOW };
}

interface ActiveFormats {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  unorderedList: boolean;
  orderedList: boolean;
}

function readActiveFormats(): ActiveFormats {
  return {
    bold: document.queryCommandState('bold'),
    italic: document.queryCommandState('italic'),
    underline: document.queryCommandState('underline'),
    unorderedList: document.queryCommandState('insertUnorderedList'),
    orderedList: document.queryCommandState('insertOrderedList'),
  };
}

interface FormatButtonProps {
  active?: boolean;
  title: string;
  onMouseDown: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}

function FormatButton({ active, title, onMouseDown, children }: FormatButtonProps) {
  return (
    <Button variant="ghost" size="sm" className={cn("h-7 w-7 p-0", active && "bg-muted")} onMouseDown={onMouseDown} title={title}>
      {children}
    </Button>
  );
}

interface FormatToolbarProps {
  className: string;
  activeFormats: ActiveFormats;
  onBold: (e: React.MouseEvent) => void;
  onItalic: (e: React.MouseEvent) => void;
  onUnderline: (e: React.MouseEvent) => void;
  onUnorderedList: (e: React.MouseEvent) => void;
  onOrderedList: (e: React.MouseEvent) => void;
  onLink: (e: React.MouseEvent) => void;
}

function FormatToolbar({
  className,
  activeFormats,
  onBold,
  onItalic,
  onUnderline,
  onUnorderedList,
  onOrderedList,
  onLink,
}: FormatToolbarProps) {
  const t = useTranslations();
  return (
    <div className={className}>
      <FormatButton active={activeFormats.bold} onMouseDown={onBold} title={t('sweep.weldcrm.globalPinnedNote.boldTooltip')}>
        <Bold className="h-3.5 w-3.5" />
      </FormatButton>
      <FormatButton active={activeFormats.italic} onMouseDown={onItalic} title={t('sweep.weldcrm.globalPinnedNote.italicTooltip')}>
        <Italic className="h-3.5 w-3.5" />
      </FormatButton>
      <FormatButton active={activeFormats.underline} onMouseDown={onUnderline} title={t('sweep.weldcrm.globalPinnedNote.underlineTooltip')}>
        <Underline className="h-3.5 w-3.5" />
      </FormatButton>
      <div className="w-px h-4 bg-border mx-1" />
      <FormatButton active={activeFormats.unorderedList} onMouseDown={onUnorderedList} title={t('sweep.weldcrm.globalPinnedNote.bulletListTooltip')}>
        <ListIcon className="h-3.5 w-3.5" />
      </FormatButton>
      <FormatButton active={activeFormats.orderedList} onMouseDown={onOrderedList} title={t('sweep.weldcrm.globalPinnedNote.numberedListTooltip')}>
        <ListOrdered className="h-3.5 w-3.5" />
      </FormatButton>
      <div className="w-px h-4 bg-border mx-1" />
      <FormatButton onMouseDown={onLink} title={t('sweep.weldcrm.globalPinnedNote.insertLinkTooltip')}>
        <LinkIcon className="h-3.5 w-3.5" />
      </FormatButton>
    </div>
  );
}

interface MinimizedNoteBarProps {
  customerName?: string;
  title: string;
  isSaving: boolean;
}

function MinimizedNoteBar({ customerName, title, isSaving }: MinimizedNoteBarProps) {
  const t = useTranslations();
  return (
    <div className="flex items-center h-full px-4">
      <DialogTitle className="sr-only">{t('sweep.weldcrm.noteEditorDialog.editNote')}</DialogTitle>
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {customerName && (
          <div className="flex items-center gap-1.5">
            <div className="w-4 h-4 rounded flex items-center justify-center bg-primary/10">
              {getCompanyIcon(customerName)}
            </div>
          </div>
        )}
        <span className="text-sm font-medium truncate">{title || t('sweep.weldcrm.globalPinnedNote.untitled')}</span>
        {isSaving && <span className="text-xs text-muted-foreground">{t('sweep.weldcrm.globalPinnedNote.saving')}</span>}
      </div>
    </div>
  );
}

function NoteDialogHeader({ customerName }: { customerName?: string }) {
  const t = useTranslations();
  return (
    <DialogHeader className="p-4 pr-32 border-b flex-row items-center justify-between space-y-0 min-h-[44px]">
      <div className="flex items-center gap-2">
        <DialogTitle className="sr-only">{t('sweep.weldcrm.noteEditorDialog.editNote')}</DialogTitle>
        {customerName && (
          <div className="flex items-center gap-1.5 px-2 py-1 bg-muted rounded-md">
            <div className="w-4 h-4 rounded flex items-center justify-center bg-primary/10">
              {getCompanyIcon(customerName)}
            </div>
            <span className="text-xs font-medium">{customerName}</span>
          </div>
        )}
      </div>
    </DialogHeader>
  );
}

interface NoteWindowControlsProps {
  isMinimized: boolean;
  isPinned: boolean;
  onToggleMinimize: () => void;
  onPinClick: () => void;
  onClose: () => void;
}

function NoteWindowControls({ isMinimized, isPinned, onToggleMinimize, onPinClick, onClose }: NoteWindowControlsProps) {
  const t = useTranslations();
  return (
    <div className="absolute top-3 right-3 flex items-center gap-1">
      <Button
        variant="ghost"
        onClick={onToggleMinimize}
        className="rounded-md p-2 text-gray-500 transition-colors hover:text-gray-900 hover:bg-gray-100 dark:hover:bg-secondary"
        title={isMinimized ? t('sweep.weldcrm.globalPinnedNote.expand') : t('sweep.weldcrm.globalPinnedNote.minimize')}
      >
        {isMinimized ? <Maximize2 className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
      </Button>
      <Button
        variant="ghost"
        onClick={onPinClick}
        className={cn(
          "rounded-md p-2 transition-colors hover:text-gray-900 hover:bg-gray-100 dark:hover:bg-secondary",
          isPinned ? "text-blue-500" : "text-gray-500"
        )}
        title={t('sweep.weldcrm.noteEditorDialog.pinToScreen')}
      >
        <PinIcon className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        onClick={onClose}
        className="rounded-md p-2 text-gray-500 transition-colors hover:text-gray-900 hover:bg-gray-100 dark:hover:bg-secondary"
        title={t('sweep.weldcrm.globalPinnedNote.close')}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

interface NoteEditorDialogProps {
  note: Note | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (content: string) => Promise<void>;
  onDelete: () => void;
}

export function NoteEditorDialog({
  note,
  open,
  onOpenChange,
  onSave,
  onDelete,
}: NoteEditorDialogProps) {
  const t = useTranslations();
  const pinnedNoteContext = usePinnedNote();
  const [title, setTitle] = useState('');
  const [_content, setContent] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [_lastSaved, setLastSaved] = useState<Date | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedContentRef = useRef<string>('');
  const [isMinimized, setIsMinimized] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [activeFormats, setActiveFormats] = useState<ActiveFormats>({
    bold: false,
    italic: false,
    underline: false,
    unorderedList: false,
    orderedList: false,
  });

  // Handle pinning - transfer to global pinned note
  const handlePinToGlobal = useCallback(() => {
    if (note && pinnedNoteContext) {
      const currentContent = title ? `<h1>${title}</h1>${contentRef.current?.innerHTML || ''}` : contentRef.current?.innerHTML || '';
      const updatedNote = { ...note, content: currentContent };
      pinnedNoteContext.setPinnedNote(updatedNote);
      pinnedNoteContext.setOnSave(onSave);
      pinnedNoteContext.setOnDelete(onDelete);
      pinnedNoteContext.setIsOpen(true);
      onOpenChange(false);
    }
  }, [note, title, onSave, onDelete, pinnedNoteContext, onOpenChange]);

  // Check active formatting on selection change
  useEffect(() => {
    const checkFormats = () => {
      setActiveFormats(readActiveFormats());
    };

    document.addEventListener('selectionchange', checkFormats);
    return () => document.removeEventListener('selectionchange', checkFormats);
  }, []);

  // Populate the contentEditable DOM from `note.content` ONCE per
  // (note-id, open) transition — not on every prop reference change.
  //
  // Auto-save triggers a parent refetch, which produces a new `note` object
  // identity even when the persisted content is unchanged. If we re-populated
  // on every reference change we'd clobber whatever the user is currently
  // typing (notably: keystrokes in the title would wipe the body, because
  // contentRef.innerHTML gets overwritten with the server value).
  //
  // Also wait one frame after `open` flips so the Radix portal has mounted
  // the dialog content and the refs are attached.
  const noteId = note?.id;
  // Capture the latest content via a ref so the effect doesn't depend on it.
  const noteContentRef = useRef<string>('');
  noteContentRef.current = note?.content ?? '';

  useEffect(() => {
    if (!noteId || !open) return;
    const content = noteContentRef.current;
    const noteTitle = getNoteTitle(content);
    const notePreview = getNotePreview(content);
    setTitle(noteTitle === 'Untitled' ? '' : noteTitle);
    setContent(notePreview);
    lastSavedContentRef.current = content;

    const populate = () => {
      if (titleRef.current) {
        titleRef.current.textContent = noteTitle === 'Untitled' ? '' : noteTitle;
      }
      if (contentRef.current) {
        const htmlWithoutTitle = content.replace(/<h[1-3][^>]*>.*?<\/h[1-3]>/i, '');
        contentRef.current.innerHTML = htmlWithoutTitle || '';
      }
    };
    if (titleRef.current && contentRef.current) {
      populate();
    } else {
      const raf = requestAnimationFrame(populate);
      return () => cancelAnimationFrame(raf);
    }
  }, [noteId, open]);

  // Auto-save with debounce
  const triggerAutoSave = useCallback(() => {
    if (!note) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(async () => {
      const fullContent = title ? `<h1>${title}</h1>${contentRef.current?.innerHTML || ''}` : contentRef.current?.innerHTML || '';

      if (fullContent === lastSavedContentRef.current) return;

      setIsSaving(true);
      try {
        await onSave(fullContent);
        lastSavedContentRef.current = fullContent;
        setLastSaved(new Date());
      } catch (error) {
        console.error('Auto-save failed:', error);
      }
      setIsSaving(false);
    }, 1000);
  }, [note, title, onSave]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  // Synchronously flush any pending edits. Called on close to avoid the
  // pending-debounce-after-unmount race: the timeout would otherwise fire
  // after Radix unmounted the portal content, read contentRef.current as
  // null, and persist `<h1>title</h1>` (empty body) — wiping the note.
  //
  // Reads from the live DOM rather than from React state so the title +
  // body are always in sync with what the user just typed.
  const flushSave = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    if (!note) return;
    if (!titleRef.current && !contentRef.current) return;
    const liveTitle = titleRef.current?.textContent ?? '';
    const liveBody = contentRef.current?.innerHTML ?? '';
    const fullContent = liveTitle ? `<h1>${liveTitle}</h1>${liveBody}` : liveBody;
    if (fullContent === lastSavedContentRef.current) return;
    lastSavedContentRef.current = fullContent;
    // Fire-and-forget — the dialog is about to unmount, we don't want to
    // block the close. The mutation lives on the parent.
    Promise.resolve(onSave(fullContent)).catch((err) => {
      console.error('Save on close failed:', err);
    });
  }, [note, onSave]);

  // Handle content changes
  const handleContentChange = () => {
    triggerAutoSave();
  };

  // Handle title changes
  const handleTitleChange = (newTitle: string) => {
    setTitle(newTitle);
    triggerAutoSave();
  };

  // Toolbar formatting functions
  const execFormat = useCallback((command: string, value?: string) => {
    document.execCommand(command, false, value);
    setActiveFormats(readActiveFormats());
    triggerAutoSave();
  }, [triggerAutoSave]);

  const handleBold = (e: React.MouseEvent) => {
    e.preventDefault();
    execFormat('bold');
  };
  const handleItalic = (e: React.MouseEvent) => {
    e.preventDefault();
    execFormat('italic');
  };
  const handleUnderline = (e: React.MouseEvent) => {
    e.preventDefault();
    execFormat('underline');
  };
  const handleUnorderedList = (e: React.MouseEvent) => {
    e.preventDefault();
    execFormat('insertUnorderedList');
  };
  const handleOrderedList = (e: React.MouseEvent) => {
    e.preventDefault();
    execFormat('insertOrderedList');
  };
  const handleLink = (e: React.MouseEvent) => {
    e.preventDefault();
    const selection = window.getSelection();
    const hasSelection = selection && selection.toString().length > 0;
    const url = prompt(t('sweep.weldcrm.globalPinnedNote.enterUrl'));
    if (url) {
      if (!hasSelection) {
        document.execCommand('insertHTML', false, `<a href="${url}">${url}</a>`);
      } else {
        execFormat('createLink', url);
      }
    }
  };

  // Handle dialog close - prevent if pinned
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && isPinned) return;
    if (!newOpen) {
      // Flush BEFORE we tell the parent to close, so the contentEditable
      // DOM is still mounted and readable.
      flushSave();
      setIsMinimized(false);
      setIsPinned(false);
    }
    onOpenChange(newOpen);
  };

  const handlePinButtonClick = () => {
    if (isMinimized) {
      setIsMinimized(false);
      handlePinToGlobal();
      return;
    }
    if (isPinned) {
      setIsPinned(false);
      return;
    }
    handlePinToGlobal();
  };

  const handleCloseButtonClick = () => {
    setIsPinned(false);
    handleOpenChange(false);
  };

  const toolbarProps = {
    activeFormats,
    onBold: handleBold,
    onItalic: handleItalic,
    onUnderline: handleUnderline,
    onUnorderedList: handleUnorderedList,
    onOrderedList: handleOrderedList,
    onLink: handleLink,
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPortal>
        <DialogPrimitive.Content
          onPointerDownOutside={(e) => isPinned && e.preventDefault()}
          onInteractOutside={(e) => isPinned && e.preventDefault()}
          className={cn(
            "bg-background fixed z-50 rounded-lg p-0 flex flex-col gap-0 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 transition-all duration-200",
            getDialogPositionClass(isMinimized, isPinned)
          )}
          style={getDialogStyle(isMinimized, isPinned)}
        >
        {isMinimized ? (
          <MinimizedNoteBar customerName={note?.customerName} title={title} isSaving={isSaving} />
        ) : (
          <>
            <NoteDialogHeader customerName={note?.customerName} />

            {!isPinned && <FormatToolbar className="px-4 py-2 border-b flex items-center gap-1" {...toolbarProps} />}

            <div className="flex-1 overflow-auto p-6">
              <div
                ref={titleRef}
                contentEditable
                suppressContentEditableWarning
                onInput={(e) => handleTitleChange(e.currentTarget.textContent || '')}
                data-placeholder={t('sweep.weldcrm.globalPinnedNote.untitled')}
                className="text-2xl font-bold outline-none mb-4 empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/40"
              />

              <div
                ref={contentRef}
                contentEditable
                suppressContentEditableWarning
                onInput={handleContentChange}
                data-placeholder={t('sweep.weldcrm.globalPinnedNote.startWriting')}
                className="outline-none min-h-[300px] text-base leading-relaxed empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/40 [&_p]:mb-2 [&_ul]:list-disc [&_ul]:ml-6 [&_ul]:mb-2 [&_ol]:list-decimal [&_ol]:ml-6 [&_ol]:mb-2 [&_li]:mb-1"
              />
            </div>

            {isPinned && <FormatToolbar className="px-4 py-2 border-t flex items-center gap-1" {...toolbarProps} />}
          </>
        )}

        <NoteWindowControls
          isMinimized={isMinimized}
          isPinned={isPinned}
          onToggleMinimize={() => setIsMinimized(!isMinimized)}
          onPinClick={handlePinButtonClick}
          onClose={handleCloseButtonClick}
        />
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
