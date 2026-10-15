/**
 * `NoteEditorSurface` — everything inside a note popup: the header with the
 * record, the title, the block editor and the window buttons. There is no
 * fixed formatting bar; the editor's own selection and slash menus format. The centred popup on the Notes page (`NoteEditorDialog`) and the
 * pinned panel that follows the user across pages (`GlobalPinnedNote`) both
 * render it, so the two are one design; `size="compact"` only tightens the
 * padding and the title for the small panel.
 *
 * The caller owns the frame (a dialog, or a fixed panel) and what the window
 * buttons do; this owns the note's text and saves it.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Block } from '@blocknote/core';
import { Maximize, Minus, PictureInPicture2, X } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { BlockEditor, type BlockNoteEditorInstance } from '@/components/block-editor/block-editor';
import { getNoteTitle } from './note-title';

export interface NoteEditorSurfaceNote {
  id: string;
  /** `<h1>title</h1>` followed by the body's HTML. */
  content: string;
  recordName?: string;
  recordAvatar?: string;
}

export interface NoteEditorSurfaceHandle {
  /** The title and body as they are right now, as the note's HTML. */
  getContent: () => string;
  /** Saves at once when there are edits the debounce has not written yet. */
  flushSave: () => Promise<void>;
}

interface NoteEditorSurfaceProps {
  note: NoteEditorSurfaceNote | null;
  /** While true the note is on screen; turning true (re)loads it into the editor. */
  active: boolean;
  /** The record's image when the note itself does not carry one. */
  recordAvatar?: string;
  onSave: (content: string) => Promise<void>;
  size?: 'full' | 'compact';
  /** False while the caller hides its frame (a minimized note): the editor
   *  stays mounted, and the title is measured again once it is shown. */
  visible?: boolean;
  pinTitle: string;
  onMinimize: () => void;
  onPinToggle: () => void;
  onClose: () => void;
  /** An accessible title for the frame, e.g. a visually hidden `DialogTitle`. */
  titleSlot?: ReactNode;
}

// Minimize / pin / close: the 28px ghost button of the mail compose popup's header.
const WINDOW_BUTTON =
  'h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors';

function RecordChip({
  name,
  avatarUrl,
  label,
}: Readonly<{ name?: string; avatarUrl?: string; label: ReactNode }>) {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      {name && (
        <Avatar className="h-[18px] w-[18px] !rounded-[6px] flex-shrink-0">
          {avatarUrl && <AvatarImage src={avatarUrl} alt={name} className="!rounded-[6px] object-cover" />}
          <AvatarFallback className="!rounded-[6px] text-[9px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
            {name.charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>
      )}
      {label}
    </div>
  );
}

export const NoteEditorSurface = forwardRef<NoteEditorSurfaceHandle, Readonly<NoteEditorSurfaceProps>>(
  function NoteEditorSurface(
    {
      note,
      active,
      recordAvatar,
      onSave,
      size = 'full',
      visible = true,
      pinTitle,
      onMinimize,
      onPinToggle,
      onClose,
      titleSlot,
    },
    ref,
  ) {
    const t = useTranslations();
    const [title, setTitle] = useState('');
    const titleRef = useRef<HTMLTextAreaElement>(null);
    const editorRef = useRef<BlockNoteEditorInstance | null>(null);
    const currentBlocksRef = useRef<Block[]>([]);
    const [initialHtml, setInitialHtml] = useState<string | undefined>(undefined);
    const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const lastSavedContentRef = useRef<string>('');

    const resizeTitle = useCallback(() => {
      const el = titleRef.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }, []);

    const handleEditorReady = useCallback((e: BlockNoteEditorInstance) => {
      editorRef.current = e;
    }, []);

    const composeFullContent = useCallback((): string => {
      const ed = editorRef.current;
      let bodyHtml = '';
      if (ed) {
        try {
          bodyHtml = (ed as unknown as { blocksToHTMLLossy: (blocks: Block[]) => string }).blocksToHTMLLossy(
            currentBlocksRef.current,
          );
        } catch {
          bodyHtml = '';
        }
      }
      return title ? `<h1>${title}</h1>${bodyHtml}` : bodyHtml;
    }, [title]);

    // Load the note. The title goes straight into the textarea rather than
    // through React, which would reset the caret while the user is typing.
    useEffect(() => {
      if (!note || !active) return;
      const noteTitle = getNoteTitle(note.content);
      const resolvedTitle = noteTitle === 'Untitled' ? '' : noteTitle;
      setTitle(resolvedTitle);
      lastSavedContentRef.current = note.content;
      setInitialHtml(note.content.replace(/<h[1-3][^>]*>.*?<\/h[1-3]>/i, '') || '');

      requestAnimationFrame(() => {
        if (titleRef.current) {
          titleRef.current.value = resolvedTitle;
          resizeTitle();
        }
      });
    }, [note, active, resizeTitle]);

    // A hidden surface is `display: none`, where the title measures 0 high.
    useEffect(() => {
      if (visible) requestAnimationFrame(resizeTitle);
    }, [visible, resizeTitle]);

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

    const triggerAutoSave = useCallback(() => {
      if (!note) return;
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

      saveTimeoutRef.current = setTimeout(async () => {
        const fullContent = composeFullContent();
        if (fullContent === lastSavedContentRef.current) return;

        try {
          await onSave(fullContent);
          lastSavedContentRef.current = fullContent;
        } catch (error) {
          console.error('Auto-save failed:', error);
        }
      }, 1000);
    }, [note, composeFullContent, onSave]);

    useEffect(() => {
      return () => {
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      };
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        // Before the editor has reported its blocks there is nothing newer
        // than the note itself.
        getContent: () =>
          editorRef.current && currentBlocksRef.current.length > 0 ? composeFullContent() : (note?.content ?? ''),
        flushSave: async () => {
          if (!editorRef.current || currentBlocksRef.current.length === 0) return;
          await flushSave();
        },
      }),
      [composeFullContent, flushSave, note],
    );

    const handleBlocksChange = useCallback(
      (blocks: Block[]) => {
        currentBlocksRef.current = blocks;
        triggerAutoSave();
      },
      [triggerAutoSave],
    );

    const handleTitleInput = useCallback(
      (e: React.FormEvent<HTMLTextAreaElement>) => {
        setTitle(e.currentTarget.value);
        resizeTitle();
        triggerAutoSave();
      },
      [triggerAutoSave, resizeTitle],
    );

    const rootRef = useRef<HTMLDivElement>(null);
    const handleTitleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        (rootRef.current?.querySelector('.bn-editor') as HTMLElement | null)?.focus();
      }
    }, []);

    const compact = size === 'compact';
    const recordName = note?.recordName;
    const avatarUrl = note?.recordAvatar || recordAvatar;
    const untitled = t('sweep.weldcrm.globalPinnedNote.untitled');

    return (
      <>
        {titleSlot}

        <div ref={rootRef} className="flex flex-col flex-1 min-h-0">
          {/* The header of the mail compose popup (`compose-surface.tsx`): same
              height, padding and title type. The right padding keeps a long
              record name clear of the window buttons, which sit on top. */}
          <div className="flex items-center h-[46px] pl-4 pr-[104px] border-b border-border flex-shrink-0">
            {recordName && (
              <RecordChip
                name={recordName}
                avatarUrl={avatarUrl}
                label={<span className="text-sm font-medium text-foreground truncate min-w-0">{recordName}</span>}
              />
            )}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden [&::-webkit-scrollbar]:w-[5px] [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-black/5 [&::-webkit-scrollbar-thumb]:rounded-full">
            <div className={cn('mx-auto w-full', compact ? 'px-6 pt-6 pb-6' : 'max-w-[760px] px-12 pt-[70px] pb-10')}>
              <textarea
                ref={titleRef}
                rows={1}
                onInput={handleTitleInput}
                onKeyDown={handleTitleKeyDown}
                placeholder={untitled}
                aria-label={untitled}
                className={cn(
                  'block w-full resize-none overflow-hidden border-0 bg-transparent p-0 font-bold leading-[1.2] text-foreground outline-none mb-1 break-words placeholder:text-muted-foreground/50',
                  compact ? 'text-2xl' : 'text-4xl',
                )}
              />
              <div className={compact ? 'mt-3' : 'mt-4'}>
                <BlockEditor
                  key={note?.id}
                  initialHtml={initialHtml}
                  onContentChange={handleBlocksChange}
                  onEditorReady={handleEditorReady}
                  selectionToolbar
                />
              </div>
            </div>
          </div>
        </div>

        {/* Window buttons, centred in the 46px header. */}
        <div className="absolute right-2.5 top-[9px] flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={onMinimize}
            className={WINDOW_BUTTON}
            title={t('sweep.weldcrm.globalPinnedNote.minimize')}
          >
            <Minus className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onPinToggle}
            className={WINDOW_BUTTON}
            title={pinTitle}
          >
            {/* In the pinned panel this button goes back to the full popup, so it
                reads "maximize"; in the popup it leads to the panel. */}
            {compact ? <Maximize className="h-4 w-4" /> : <PictureInPicture2 className="h-4 w-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className={WINDOW_BUTTON}
            title={t('sweep.weldcrm.globalPinnedNote.close')}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </>
    );
  },
);
