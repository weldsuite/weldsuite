
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

// Helper to strip HTML tags
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

// Helper to get note title from content
export function getNoteTitle(content: string): string {
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
  let preview = content.replace(/<h[1-3][^>]*>.*?<\/h[1-3]>/i, '');
  return stripHtml(preview).trim();
}

// Helper to get company icon
function getCompanyIcon(name?: string) {
  if (!name) return <Building className="h-3 w-3 text-muted-foreground" />;
  if (name.toLowerCase().includes('weld')) {
    return <Bot className="h-3 w-3 text-muted-foreground" />;
  }
  return <Building className="h-3 w-3 text-muted-foreground" />;
}

export function NoteEditorDialog({
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
  const { setPinnedNote, setIsOpen: setGlobalPinnedOpen, setOnSave, setOnDelete } = usePinnedNote();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedContentRef = useRef<string>('');
  const [isMinimized, setIsMinimized] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [activeFormats, setActiveFormats] = useState({
    bold: false,
    italic: false,
    underline: false,
    unorderedList: false,
    orderedList: false,
  });

  const handlePinToGlobal = useCallback(() => {
    if (note) {
      const currentContent = title ? `<h1>${title}</h1>${contentRef.current?.innerHTML || ''}` : contentRef.current?.innerHTML || '';
      const updatedNote = { ...note, content: currentContent };
      setPinnedNote(updatedNote);
      setOnSave(onSave);
      setOnDelete(onDelete);
      setGlobalPinnedOpen(true);
      onOpenChange(false);
    }
  }, [note, title, onSave, onDelete, setPinnedNote, setOnSave, setOnDelete, setGlobalPinnedOpen, onOpenChange]);

  useEffect(() => {
    const checkFormats = () => {
      setActiveFormats({
        bold: document.queryCommandState('bold'),
        italic: document.queryCommandState('italic'),
        underline: document.queryCommandState('underline'),
        unorderedList: document.queryCommandState('insertUnorderedList'),
        orderedList: document.queryCommandState('insertOrderedList'),
      });
    };
    document.addEventListener('selectionchange', checkFormats);
    return () => document.removeEventListener('selectionchange', checkFormats);
  }, []);

  useEffect(() => {
    if (note && open) {
      const noteTitle = getNoteTitle(note.content);
      const noteContent = getNotePreview(note.content);
      setTitle(noteTitle === 'Untitled' ? '' : noteTitle);
      setContent(noteContent);
      lastSavedContentRef.current = note.content;
      requestAnimationFrame(() => {
        if (titleRef.current) {
          titleRef.current.textContent = noteTitle === 'Untitled' ? '' : noteTitle;
          titleRef.current.focus();
        }
        if (contentRef.current) {
          const htmlWithoutTitle = note.content.replace(/<h[1-3][^>]*>.*?<\/h[1-3]>/i, '');
          contentRef.current.innerHTML = htmlWithoutTitle || '';
        }
      });
    }
  }, [note, open]);

  const flushSave = useCallback(async () => {
    if (!note) return;
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    const fullContent = title ? `<h1>${title}</h1>${contentRef.current?.innerHTML || ''}` : contentRef.current?.innerHTML || '';
    if (fullContent === lastSavedContentRef.current) return;
    try {
      await onSave(fullContent);
      lastSavedContentRef.current = fullContent;
    } catch (error) {
      console.error('Save on close failed:', error);
    }
  }, [note, title, onSave]);

  const triggerAutoSave = useCallback(() => {
    if (!note) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
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

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  const handleContentChange = () => triggerAutoSave();
  const handleTitleChange = (newTitle: string) => { setTitle(newTitle); triggerAutoSave(); };

  const execFormat = useCallback((command: string, value?: string) => {
    document.execCommand(command, false, value);
    setActiveFormats({
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      underline: document.queryCommandState('underline'),
      unorderedList: document.queryCommandState('insertUnorderedList'),
      orderedList: document.queryCommandState('insertOrderedList'),
    });
    triggerAutoSave();
  }, [triggerAutoSave]);

  const handleBold = (e: React.MouseEvent) => { e.preventDefault(); execFormat('bold'); };
  const handleItalic = (e: React.MouseEvent) => { e.preventDefault(); execFormat('italic'); };
  const handleUnderline = (e: React.MouseEvent) => { e.preventDefault(); execFormat('underline'); };
  const handleUnorderedList = (e: React.MouseEvent) => { e.preventDefault(); execFormat('insertUnorderedList'); };
  const handleOrderedList = (e: React.MouseEvent) => { e.preventDefault(); execFormat('insertOrderedList'); };
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
            "bg-background fixed z-50 rounded-lg p-0 flex flex-col gap-0 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 transition-all duration-200",
            isMinimized
              ? "bottom-4 right-4 top-auto left-auto translate-x-0 translate-y-0"
              : isPinned
                ? "bottom-4 right-4 top-auto left-auto translate-x-0 translate-y-0"
                : "top-[50%] left-[50%] translate-x-[-50%] translate-y-[-50%]"
          )}
          style={isMinimized
            ? { width: '320px', height: '56px', boxShadow: '0 0 60px rgba(0, 0, 0, 0.12), 0 20px 40px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.03)' }
            : isPinned
              ? { width: '440px', maxWidth: '90vw', height: '500px', boxShadow: '0 0 60px rgba(0, 0, 0, 0.12), 0 20px 40px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.03)' }
              : { width: '860px', maxWidth: '90vw', height: '882px', maxHeight: '90vh', boxShadow: '0 0 60px rgba(0, 0, 0, 0.12), 0 20px 40px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.03)' }
          }
        >
        {isMinimized ? (
          <div className="flex items-center h-full px-4">
            <DialogTitle className="sr-only">{t('sweep.weldcrm.noteEditorDialog.editNote')}</DialogTitle>
            <div className="flex items-center gap-2 flex-1 min-w-0">
              {note?.customerName && (
                <div className="flex items-center gap-1.5">
                  <div className="w-4 h-4 rounded flex items-center justify-center bg-primary/10">
                    {getCompanyIcon(note.customerName)}
                  </div>
                </div>
              )}
              <span className="text-sm font-medium truncate">{title || t('sweep.weldcrm.globalPinnedNote.untitled')}</span>
              {isSaving && <span className="text-xs text-muted-foreground">{t('sweep.weldcrm.globalPinnedNote.saving')}</span>}
            </div>
          </div>
        ) : (
          <>
            <DialogHeader className="p-4 border-b flex-row items-center justify-between space-y-0">
              <div className="flex items-center gap-2">
                <DialogTitle className="sr-only">{t('sweep.weldcrm.noteEditorDialog.editNote')}</DialogTitle>
                {note?.customerName && (
                  <div className="flex items-center gap-1.5 px-2 py-1 bg-muted rounded-md">
                    <div className="w-4 h-4 rounded flex items-center justify-center bg-primary/10">
                      {getCompanyIcon(note.customerName)}
                    </div>
                    <span className="text-xs font-medium">{note.customerName}</span>
                  </div>
                )}
              </div>
            </DialogHeader>

            {!isPinned && (
              <div className="px-4 py-2 border-b flex items-center gap-1">
                <Button variant="ghost" size="sm" className={cn("h-7 w-7 p-0", activeFormats.bold && "bg-muted")} onMouseDown={handleBold} title={t('sweep.weldcrm.globalPinnedNote.boldTooltip')}>
                  <Bold className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" className={cn("h-7 w-7 p-0", activeFormats.italic && "bg-muted")} onMouseDown={handleItalic} title={t('sweep.weldcrm.globalPinnedNote.italicTooltip')}>
                  <Italic className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" className={cn("h-7 w-7 p-0", activeFormats.underline && "bg-muted")} onMouseDown={handleUnderline} title={t('sweep.weldcrm.globalPinnedNote.underlineTooltip')}>
                  <Underline className="h-3.5 w-3.5" />
                </Button>
                <div className="w-px h-4 bg-border mx-1" />
                <Button variant="ghost" size="sm" className={cn("h-7 w-7 p-0", activeFormats.unorderedList && "bg-muted")} onMouseDown={handleUnorderedList} title={t('sweep.weldcrm.globalPinnedNote.bulletListTooltip')}>
                  <ListIcon className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" className={cn("h-7 w-7 p-0", activeFormats.orderedList && "bg-muted")} onMouseDown={handleOrderedList} title={t('sweep.weldcrm.globalPinnedNote.numberedListTooltip')}>
                  <ListOrdered className="h-3.5 w-3.5" />
                </Button>
                <div className="w-px h-4 bg-border mx-1" />
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onMouseDown={handleLink} title={t('sweep.weldcrm.globalPinnedNote.insertLinkTooltip')}>
                  <LinkIcon className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}

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

            {isPinned && (
              <div className="px-4 py-2 border-t flex items-center gap-1">
                <Button variant="ghost" size="sm" className={cn("h-7 w-7 p-0", activeFormats.bold && "bg-muted")} onMouseDown={handleBold} title={t('sweep.weldcrm.globalPinnedNote.boldTooltip')}>
                  <Bold className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" className={cn("h-7 w-7 p-0", activeFormats.italic && "bg-muted")} onMouseDown={handleItalic} title={t('sweep.weldcrm.globalPinnedNote.italicTooltip')}>
                  <Italic className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" className={cn("h-7 w-7 p-0", activeFormats.underline && "bg-muted")} onMouseDown={handleUnderline} title={t('sweep.weldcrm.globalPinnedNote.underlineTooltip')}>
                  <Underline className="h-3.5 w-3.5" />
                </Button>
                <div className="w-px h-4 bg-border mx-1" />
                <Button variant="ghost" size="sm" className={cn("h-7 w-7 p-0", activeFormats.unorderedList && "bg-muted")} onMouseDown={handleUnorderedList} title={t('sweep.weldcrm.globalPinnedNote.bulletListTooltip')}>
                  <ListIcon className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" className={cn("h-7 w-7 p-0", activeFormats.orderedList && "bg-muted")} onMouseDown={handleOrderedList} title={t('sweep.weldcrm.globalPinnedNote.numberedListTooltip')}>
                  <ListOrdered className="h-3.5 w-3.5" />
                </Button>
                <div className="w-px h-4 bg-border mx-1" />
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onMouseDown={handleLink} title={t('sweep.weldcrm.globalPinnedNote.insertLinkTooltip')}>
                  <LinkIcon className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </>
        )}

        {/* Window controls */}
          <div className="absolute top-3 right-3 flex items-center gap-1">
            <Button
              variant="ghost"
              onClick={() => setIsMinimized(!isMinimized)}
              className="rounded-md p-2 text-muted-foreground transition-colors hover:text-foreground hover:bg-muted h-auto w-auto"
              title={isMinimized ? t('sweep.weldcrm.globalPinnedNote.expand') : t('sweep.weldcrm.globalPinnedNote.minimize')}
            >
              {isMinimized ? <Maximize2 className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                if (isMinimized) {
                  setIsMinimized(false);
                  handlePinToGlobal();
                } else if (isPinned) {
                  setIsPinned(false);
                } else {
                  handlePinToGlobal();
                }
              }}
              className={cn(
                "rounded-md p-2 transition-colors hover:text-foreground hover:bg-muted h-auto w-auto",
                isPinned ? "text-blue-500" : "text-muted-foreground"
              )}
              title={t('sweep.weldcrm.noteEditorDialog.pinToScreen')}
            >
              <PinIcon className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                flushSave();
                setIsPinned(false);
                onOpenChange(false);
              }}
              className="rounded-md p-2 text-muted-foreground transition-colors hover:text-foreground hover:bg-muted h-auto w-auto"
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
