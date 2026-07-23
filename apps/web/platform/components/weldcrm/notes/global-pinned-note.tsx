
import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@weldsuite/ui/components/button';
import {
  Bold,
  Italic,
  Underline,
  List as ListIcon,
  ListOrdered,
  Link as LinkIcon,
  Minus,
  Pin as PinIcon,
  Maximize,
  X,
  Bot,
  Building,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePinnedNote } from '@/contexts/pinned-note-context';
import { NoteEditorDialog } from './note-editor-dialog';
import { useTranslations } from '@weldsuite/i18n/client';

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

// Helper to get company icon based on name
function getCompanyIcon(name?: string) {
  if (!name) return <Building className="h-3 w-3 text-muted-foreground" />;
  if (name.toLowerCase().includes('weld')) {
    return <Bot className="h-3 w-3 text-muted-foreground" />;
  }
  return <Building className="h-3 w-3 text-muted-foreground" />;
}

export function GlobalPinnedNote() {
  const t = useTranslations();
  const { pinnedNote, isOpen, onSave, closePinnedNote, unpinToDialog, unpinnedNote, unpinnedNoteSave, unpinnedNoteDelete, clearUnpinnedNote, startMinimized, setStartMinimized } = usePinnedNote();

  const [title, setTitle] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const [isSaving, setIsSaving] = useState(false);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedContentRef = useRef<string>('');
  const [isMinimized, setIsMinimized] = useState(false);

  // Sync minimized state from context when pinned note opens
  useEffect(() => {
    if (pinnedNote && isOpen) {
      setIsMinimized(startMinimized);
      setStartMinimized(false);
    }
  }, [pinnedNote, isOpen]);
  const [activeFormats, setActiveFormats] = useState({
    bold: false,
    italic: false,
    underline: false,
    unorderedList: false,
    orderedList: false,
  });

  // Check active formatting on selection change
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

  // Extract title and content from note
  useEffect(() => {
    if (pinnedNote) {
      const noteTitle = getNoteTitle(pinnedNote.content);
      setTitle(noteTitle === 'Untitled' ? '' : noteTitle);
      lastSavedContentRef.current = pinnedNote.content;

      if (titleRef.current) {
        titleRef.current.textContent = noteTitle === 'Untitled' ? '' : noteTitle;
      }
      if (contentRef.current) {
        const htmlWithoutTitle = pinnedNote.content.replace(/<h[1-3][^>]*>.*?<\/h[1-3]>/i, '');
        contentRef.current.innerHTML = htmlWithoutTitle || '';
      }
    }
  }, [pinnedNote]);

  // Auto-save with debounce
  const triggerAutoSave = useCallback(() => {
    if (!pinnedNote || !onSave) return;

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
      } catch (error) {
        console.error('Auto-save failed:', error);
      }
      setIsSaving(false);
    }, 1000);
  }, [pinnedNote, title, onSave]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

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
    setActiveFormats({
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      underline: document.queryCommandState('underline'),
      unorderedList: document.queryCommandState('insertUnorderedList'),
      orderedList: document.queryCommandState('insertOrderedList'),
    });
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

  // Only render on client
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  // Fallback dialog when unpinned from a different page — uses the same NoteEditorDialog
  if (unpinnedNote) {
    return (
      <NoteEditorDialog
        note={unpinnedNote}
        open={true}
        onOpenChange={(open) => { if (!open) clearUnpinnedNote(); }}
        onSave={unpinnedNoteSave || (async () => {})}
        onDelete={unpinnedNoteDelete || (() => clearUnpinnedNote())}
      />
    );
  }

  if (!pinnedNote || !isOpen) return null;

  const panel = (
    <div
      className={cn(
        "bg-background fixed z-50 p-0 flex flex-col gap-0 transition-all duration-200",
        "bottom-4 right-4",
        isMinimized ? "rounded-xl" : "rounded-lg"
      )}
      style={isMinimized
        ? { width: '320px', height: '50px', boxShadow: '0 2px 4px rgba(0, 0, 0, 0.06), 0 24px 56px -4px rgba(0, 0, 0, 0.2)', border: '1px solid hsl(var(--border))' }
        : { width: '440px', maxWidth: '90vw', height: '500px', boxShadow: '0 2px 4px rgba(0, 0, 0, 0.06), 0 24px 56px -4px rgba(0, 0, 0, 0.2)', border: '1px solid hsl(var(--border))' }
      }
    >
      {isMinimized ? (
        /* Minimized view */
        <div className="flex items-center h-full px-4">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {pinnedNote?.recordName && (
              <div className="flex items-center gap-1.5">
                <div className="w-4 h-4 rounded flex items-center justify-center bg-primary/10">
                  {getCompanyIcon(pinnedNote.recordName)}
                </div>
              </div>
            )}
            <span className="text-sm font-medium truncate">{title || t('sweep.weldcrm.globalPinnedNote.untitled')}</span>
            {isSaving && <span className="text-xs text-muted-foreground">{t('sweep.weldcrm.globalPinnedNote.saving')}</span>}
          </div>
        </div>
      ) : (
        /* Full view */
        <>
          <div className="px-4 border-b flex items-center justify-between h-[46px]">
            <div className="flex items-center gap-2">
              {pinnedNote?.recordName && (
                <div className="flex items-center gap-1.5 px-2 py-1 bg-muted rounded-md">
                  <div className="w-4 h-4 rounded flex items-center justify-center bg-primary/10">
                    {getCompanyIcon(pinnedNote.recordName)}
                  </div>
                  <span className="text-xs font-medium">{pinnedNote.recordName}</span>
                </div>
              )}
            </div>
          </div>

          {/* Editor */}
          <div className="flex-1 overflow-auto p-6 [&::-webkit-scrollbar]:w-[5px] [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-black/5 [&::-webkit-scrollbar-thumb]:rounded-full">
            {/* Title */}
            <div
              ref={titleRef}
              contentEditable
              suppressContentEditableWarning
              onInput={(e) => handleTitleChange(e.currentTarget.textContent || '')}
              data-placeholder={t('sweep.weldcrm.globalPinnedNote.untitled')}
              className="text-2xl font-bold outline-none mb-4 empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/40"
            />

            {/* Content */}
            <div
              ref={contentRef}
              contentEditable
              suppressContentEditableWarning
              onInput={handleContentChange}
              data-placeholder={t('sweep.weldcrm.globalPinnedNote.startWriting')}
              className="outline-none min-h-[300px] text-base leading-relaxed empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/40 [&_p]:mb-2 [&_ul]:list-disc [&_ul]:ml-6 [&_ul]:mb-2 [&_ol]:list-decimal [&_ol]:ml-6 [&_ol]:mb-2 [&_li]:mb-1"
            />
          </div>

          {/* Toolbar - at bottom */}
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
        </>
      )}

      {/* Window controls */}
      <div className={cn("absolute right-3 flex items-center gap-1", isMinimized ? "top-1/2 -translate-y-1/2" : "top-[9px]")}>
        <Button
          variant="ghost"
          onClick={() => {
            if (isMinimized) {
              unpinToDialog();
            } else {
              setIsMinimized(true);
            }
          }}
          className="rounded-md p-1.5 text-gray-500 transition-colors hover:text-gray-900 hover:bg-gray-100 dark:hover:bg-secondary"
          title={isMinimized ? t('sweep.weldcrm.globalPinnedNote.expand') : t('sweep.weldcrm.globalPinnedNote.minimize')}
        >
          {isMinimized ? <Maximize className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            if (isMinimized) {
              setIsMinimized(false);
            } else {
              unpinToDialog();
            }
          }}
          className={cn(
            "rounded-md p-1.5 transition-colors hover:text-gray-900 hover:bg-gray-100 dark:hover:bg-secondary",
            isMinimized ? "text-gray-500" : "text-blue-500"
          )}
          title={isMinimized ? t('sweep.weldcrm.globalPinnedNote.expand') : t('sweep.weldcrm.globalPinnedNote.unpin')}
        >
          <PinIcon className={cn("h-4 w-4", !isMinimized && "fill-current")} />
        </Button>
        <Button
          variant="ghost"
          onClick={closePinnedNote}
          className="rounded-md p-1.5 text-gray-500 transition-colors hover:text-gray-900 hover:bg-gray-100 dark:hover:bg-secondary"
          title={t('sweep.weldcrm.globalPinnedNote.close')}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}
