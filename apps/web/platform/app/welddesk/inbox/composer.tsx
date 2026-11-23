import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, MessageSquareText, Paperclip, Plus, StickyNote, X } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Link } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import {
  ComposerActions,
  ComposerFrame,
  ComposerSendButton,
  composerFieldClass,
  composerIconButtonClass,
} from '@weldsuite/ui/components/composer';
import { Popover, PopoverAnchor, PopoverContent } from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import {
  useApplyDeskSavedReply,
  useDeskSavedReplies,
  useUploadDeskAttachment,
  type DeskMessageAttachment,
  type DeskSavedReply,
} from '@/hooks/queries/use-desk-queries';
import {
  DESK_ATTACHMENT_ACCEPT,
  DESK_ATTACHMENT_MAX_BYTES,
  DESK_ATTACHMENT_MAX_COUNT,
  formatFileSize,
} from './attachments';
import { TranslateDraftButton } from './translation/translate-draft-button';
import { KnowledgeButton } from './knowledge-panel';

type ComposerTab = 'reply' | 'note';

interface PendingFile {
  key: string;
  name: string;
  attachment?: DeskMessageAttachment;
}

interface ComposerProps {
  conversationId: string;
  /** `{{customer.name}}`-style values for saved replies. */
  savedReplyVariables: Record<string, unknown>;
  onSend: (kind: 'message' | 'note', body: string, attachments?: DeskMessageAttachment[]) => void;
  onTyping?: () => void;
  onStopTyping?: () => void;
}

/** The shared composer field's cap (`composerFieldClass`); it scrolls past it. */
const MAX_HEIGHT_PX = 200;

/** "/" at the start of an otherwise empty box opens the saved-reply picker. */
function slashQuery(body: string): string | null {
  const match = /^\/(\S*)$/.exec(body);
  return match ? match[1] : null;
}

export function Composer({
  conversationId,
  savedReplyVariables,
  onSend,
  onTyping,
  onStopTyping,
}: Readonly<ComposerProps>) {
  const t = getTranslations('deskInbox2');
  const [tab, setTab] = useState<ComposerTab>('reply');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadDeskAttachment();
  const applySavedReply = useApplyDeskSavedReply();
  const savedReplies = useDeskSavedReplies(pickerSearch, pickerOpen);

  // Grow with the text, up to a cap.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [body]);

  useEffect(() => {
    setBody('');
    setTab('reply');
    setFiles([]);
    setPickerOpen(false);
    textareaRef.current?.focus();
  }, [conversationId]);

  const uploading = files.some((f) => !f.attachment);
  const ready = files.flatMap((f) => (f.attachment ? [f.attachment] : []));
  const canSend = !uploading && (body.trim().length > 0 || ready.length > 0);

  const handleSend = () => {
    if (!canSend) return;
    // The message appears in the thread right away (optimistic), so the box
    // clears immediately and the agent can keep typing.
    onSend(tab === 'note' ? 'note' : 'message', body.trim(), ready.length > 0 ? ready : undefined);
    setBody('');
    setFiles([]);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen && e.key === 'Escape') {
      setPickerOpen(false);
      return;
    }
    // Typed "/name" + Enter takes the best match.
    const first = savedReplies.data?.[0];
    if (pickerOpen && e.key === 'Enter' && slashQuery(body) !== null && first) {
      e.preventDefault();
      void insertSavedReply(first);
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || pickerOpen) return;
    e.preventDefault();
    handleSend();
  };

  const handleChange = (value: string) => {
    setBody(value);
    const slash = slashQuery(value);
    if (slash === null) {
      if (pickerOpen && value !== '') setPickerOpen(false);
    } else {
      setPickerSearch(slash);
      setPickerOpen(true);
    }
    // Visitors only see typing for replies — never for internal notes.
    if (tab !== 'reply') return;
    if (value.trim() && slash === null) onTyping?.();
    else onStopTyping?.();
  };

  const switchTab = (next: ComposerTab) => {
    setTab(next);
    if (next === 'note') onStopTyping?.();
    textareaRef.current?.focus();
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const room = DESK_ATTACHMENT_MAX_COUNT - files.length;
    const picked = Array.from(list).slice(0, Math.max(room, 0));
    if (list.length > picked.length) toast.error(t.composer.tooManyFiles.replace('{max}', String(DESK_ATTACHMENT_MAX_COUNT)));
    for (const file of picked) {
      if (file.size > DESK_ATTACHMENT_MAX_BYTES) {
        toast.error(t.composer.fileTooLarge.replace('{name}', file.name));
        continue;
      }
      const key = `${file.name}-${crypto.randomUUID()}`;
      setFiles((prev) => [...prev, { key, name: file.name }]);
      // mutateAsync, not mutate: mutate's per-call callbacks only fire for the
      // last call on the observer, so earlier files would never resolve.
      upload
        .mutateAsync({ conversationId, file })
        .then((attachment) => setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, attachment } : f))))
        .catch(() => {
          setFiles((prev) => prev.filter((f) => f.key !== key));
          toast.error(t.composer.uploadError.replace('{name}', file.name));
        });
    }
  };

  const insertSavedReply = async (reply: DeskSavedReply) => {
    setPickerOpen(false);
    let content = reply.content;
    try {
      content = await applySavedReply.mutateAsync({ id: reply.id, variables: savedReplyVariables });
    } catch {
      // Fall back to the raw text: the agent can still edit placeholders.
    }
    setBody((prev) => (slashQuery(prev) === null && prev.trim() ? `${prev.trimEnd()}\n${content}` : content));
    textareaRef.current?.focus();
  };

  const insertText = (text: string) => {
    setBody((prev) => (prev.trim() ? `${prev.trimEnd()}\n${text}` : text));
    textareaRef.current?.focus();
  };

  return (
    <div className="flex-shrink-0 px-3 md:px-4 pb-3 pt-2 bg-white dark:bg-background" data-testid="desk-inbox-composer">
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverAnchor asChild>
          <ComposerFrame
            // An internal note keeps its amber tint, so it never reads as a reply.
            className={cn(tab === 'note' && 'border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20')}
            onClick={(e) => {
              // Clicking the empty parts of the box focuses the field, as in every composer.
              if (!(e.target as HTMLElement).closest('button, input, textarea, a')) textareaRef.current?.focus();
            }}
          >
            <textarea
              ref={textareaRef}
              value={body}
              rows={1}
              onChange={(e) => handleChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={() => onStopTyping?.()}
              onPaste={(e) => {
                if (e.clipboardData.files.length > 0) {
                  e.preventDefault();
                  addFiles(e.clipboardData.files);
                }
              }}
              placeholder={tab === 'note' ? t.composer.notePlaceholder : t.composer.replyPlaceholder}
              className={composerFieldClass}
              data-testid="desk-inbox-composer-textarea"
            />
            {files.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-[10px] pb-2" data-testid="desk-inbox-composer-files">
                {files.map((file) => (
                  <span
                    key={file.key}
                    className="inline-flex max-w-[220px] items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2 py-1 text-xs"
                  >
                    {file.attachment ? (
                      <Paperclip className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                    ) : (
                      <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-muted-foreground" />
                    )}
                    <span className="truncate">{file.name}</span>
                    {file.attachment && (
                      <span className="text-muted-foreground flex-shrink-0">{formatFileSize(file.attachment.filesize)}</span>
                    )}
                    <button
                      type="button"
                      className="flex-shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={() => setFiles((prev) => prev.filter((f) => f.key !== file.key))}
                      aria-label={t.composer.removeFile}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <ComposerActions>
              <div className="flex items-center gap-0 min-w-0">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={DESK_ATTACHMENT_ACCEPT}
                  className="hidden"
                  onChange={(e) => {
                    addFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={composerIconButtonClass}
                  onClick={() => fileInputRef.current?.click()}
                  title={t.composer.attachFile}
                  aria-label={t.composer.attachFile}
                  data-testid="desk-inbox-composer-attach"
                >
                  <Plus className="h-[18px] w-[18px]" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={composerIconButtonClass}
                  onClick={() => {
                    setPickerSearch('');
                    setPickerOpen((open) => !open);
                  }}
                  title={t.composer.savedReplies}
                  aria-label={t.composer.savedReplies}
                  data-testid="desk-inbox-composer-saved-replies"
                >
                  <MessageSquareText className="h-[18px] w-[18px]" />
                </Button>
                <TranslateDraftButton conversationId={conversationId} body={body} disabled={tab === 'note'} onTranslated={setBody} />
                <KnowledgeButton conversationId={conversationId} onInsert={insertText} />
                {/* Pressed: the message goes out as an internal note instead of a reply. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn(
                    composerIconButtonClass,
                    tab === 'note' && 'bg-gray-100 text-gray-700 dark:bg-accent dark:text-foreground',
                  )}
                  onClick={() => switchTab(tab === 'note' ? 'reply' : 'note')}
                  aria-pressed={tab === 'note'}
                  title={t.pane.internalNote}
                  aria-label={t.pane.internalNote}
                  data-testid="desk-inbox-composer-note"
                >
                  <StickyNote className="h-[18px] w-[18px]" />
                </Button>
              </div>
              <ComposerSendButton
                type="button"
                onClick={handleSend}
                canSend={canSend}
                label={tab === 'note' ? t.composer.addNote : t.composer.sendReply}
                data-testid="desk-inbox-composer-send"
              />
            </ComposerActions>
          </ComposerFrame>
        </PopoverAnchor>
        <PopoverContent
          side="top"
          align="start"
          className="w-[min(420px,calc(100vw-32px))] p-0"
          onOpenAutoFocus={(e) => {
            // Opened by typing "/": keep the caret in the composer.
            if (slashQuery(body) !== null) e.preventDefault();
          }}
        >
          <Command shouldFilter={false}>
            {slashQuery(body) === null && (
              <CommandInput
                placeholder={t.composer.savedRepliesSearch}
                value={pickerSearch}
                onValueChange={setPickerSearch}
              />
            )}
            <CommandList className="max-h-72">
              {savedReplies.isLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <CommandEmpty>
                  <span className="block">{t.composer.savedRepliesEmpty}</span>
                  <Link href="/welddesk/saved-replies" className="mt-1 inline-block text-xs text-primary underline-offset-2 hover:underline">
                    {t.composer.savedRepliesManage}
                  </Link>
                </CommandEmpty>
              )}
              {(savedReplies.data ?? []).map((reply) => (
                <CommandItem
                  key={reply.id}
                  value={reply.id}
                  onSelect={() => void insertSavedReply(reply)}
                  className="flex flex-col items-start gap-0.5"
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="font-medium truncate">{reply.name}</span>
                    {reply.shortcut && (
                      <span className="ml-auto font-mono text-[11px] text-muted-foreground">/{reply.shortcut}</span>
                    )}
                  </span>
                  <span className="w-full truncate text-xs text-muted-foreground">{reply.content}</span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
