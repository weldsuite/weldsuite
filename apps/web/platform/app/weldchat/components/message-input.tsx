import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import { useUser } from '@clerk/clerk-react';
import { Plus, Smile, AtSign, X, CornerDownRight, FileText, Baseline, Bold, Italic, Underline, Strikethrough, Code, List, ListOrdered, Video, Mic, Square, Loader2 } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { Button } from '@weldsuite/ui/components/button';
import { EmojiPicker } from './emoji-picker';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useSendMessage, useWorkspaceMembers, useAddChannelMembers } from '@/hooks/queries/use-weldchat-queries';
import { useAgents } from '@/hooks/queries/use-agent-queries';
import { useCreateTask } from '@/hooks/queries/use-task-queries';
import { useTypingPublisher } from '@/hooks/weldchat/use-weldchat-typing';
import type { RoomClient } from '@weldsuite/realtime/client';
import { MentionAutocomplete, type MentionSelection } from './mention-autocomplete';
import { SlashCommandPalette } from './slash-command-palette';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useChatContext } from './chat-context';
import { ClipRecorder } from './clip-recorder';
import { TypingIndicator } from './typing-indicator';
import { useClipRecorder } from '@/hooks/weldchat/use-clip-recorder';
import { useDraftAutosave } from '@/hooks/weldchat/use-draft-autosave';
import type { ChatClipAttachment } from '@weldsuite/db/schema';
import { renderChatTokens, encodeEntityToken } from '../lib/render-tokens';
import { RESULT_TYPE_LABEL } from '@/lib/search/result-types';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

interface MessageInputProps {
  channelId: string;
  parentId?: string;
  placeholder?: string;
  client?: RoomClient | null;
  /**
   * When provided, replaces the default `useSendMessage` behaviour on
   * submit. Used by the entity-chat empty state, where the channel
   * doesn't exist yet and the first message has to create it. All other
   * UI (mentions, emoji, attachments, toolbar, send button styling)
   * stays identical, so the composer doesn't visually change when the
   * first message lands.
   */
  onSubmitOverride?: (payload: {
    content: string;
    mentions: string[];
    attachments: any[];
  }) => Promise<void> | void;
}

/** HTML-escape a string for inclusion in attribute values / chip body. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render raw content (with `<@…>` tokens) as React nodes for the reply preview.
 * Entity tokens render as a static (non-clickable) violet chip — clicks are
 * intentionally suppressed inside the composer's reply preview.
 */
function renderReplyPreview(text: string, membersMap: Map<string, string>): ReactNode[] {
  return renderChatTokens(text, {
    renderUser: ({ userId, displayName }, key) => (
      <span
        key={key}
        className="inline-block bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 rounded px-1.5 py-0 text-[12px] font-medium align-middle"
      >
        @{displayName ?? membersMap.get(userId) ?? userId}
      </span>
    ),
    renderEntity: ({ entityType, label, entityId }, key) => (
      <span
        key={key}
        className="inline-block bg-violet-50 dark:bg-violet-950 text-violet-700 dark:text-violet-300 rounded px-1.5 py-0 text-[12px] font-medium align-middle"
      >
        {label || `${entityType}:${entityId}`}
      </span>
    ),
    renderText: (t, key) => <span key={key}>{t}</span>,
  });
}

/** Convert raw content (with `<@…>` tokens) to HTML with badge spans. */
function contentToHtml(text: string, membersMap: Map<string, string>): string {
  return text.replace(/<@([^>]+)>/g, (full, body: string) => {
    const colonIdx = body.indexOf(':');
    if (colonIdx > 0) {
      const prefix = body.slice(0, colonIdx);
      const rest = body.slice(colonIdx + 1);
      // Entity token? type prefix in the SET, body has `id|label?`.
      // We don't need the SET on the client here — the renderer below handles it.
      // But we identify entity tokens by checking if `prefix` is a known type
      // (anything in our RESULT_TYPE_LABEL map qualifies).
      if (Object.prototype.hasOwnProperty.call(RESULT_TYPE_LABEL, prefix)) {
        const pipeIdx = rest.indexOf('|');
        const id = pipeIdx === -1 ? rest : rest.slice(0, pipeIdx);
        const label = pipeIdx === -1 ? '' : rest.slice(pipeIdx + 1);
        const display = label || `${prefix}:${id}`;
        const safeDisplay = escapeHtml(display);
        const safeData = escapeHtml(`${prefix}:${id}`);
        const safeLabel = escapeHtml(label);
        return `<span class="entity-mention-badge" contenteditable="false" data-entity="${safeData}" data-label="${safeLabel}">${safeDisplay}</span>`;
      }
      // <@userId:DisplayName> → user mention with display override
      const safeName = escapeHtml(rest || prefix);
      return `<span class="mention-badge" contenteditable="false" data-userid="${escapeHtml(body)}">@${safeName}</span>`;
    }
    // <@userId>  (special-case `everyone` so the chip stays correct even if
    // a workspace member ever has the literal userId 'everyone')
    const name = body === 'everyone' ? 'everyone' : (membersMap.get(body) ?? body);
    return `<span class="mention-badge" contenteditable="false" data-userid="${escapeHtml(body)}">@${escapeHtml(name)}</span>`;
  });
}

/** Extract raw content from the contentEditable div innerHTML, preserving formatting as markdown. */
function htmlToContent(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;

  // Replace entity-mention badges with `<@type:id|Label>` tokens FIRST so
  // they are not picked up by the user-mention selector below.
  div.querySelectorAll('.entity-mention-badge').forEach((badge) => {
    const entity = badge.getAttribute('data-entity'); // "type:id"
    const label = badge.getAttribute('data-label') || badge.textContent || '';
    if (entity) {
      const colonIdx = entity.indexOf(':');
      if (colonIdx > 0) {
        const type = entity.slice(0, colonIdx);
        const id = entity.slice(colonIdx + 1);
        // encodeEntityToken sanitizes label (strips `|`/`>`, trims, max 80 chars).
        // We pass it as EntitySheetType — runtime-checked at parse time later.
        const token = encodeEntityToken(type as never, id, label);
        badge.replaceWith(token);
      }
    }
  });

  // Replace user-mention badges with `<@userId>` tokens
  div.querySelectorAll('.mention-badge').forEach((badge) => {
    const userId = badge.getAttribute('data-userid');
    if (userId) badge.replaceWith(`<@${userId}>`);
  });

  // Convert formatting to markdown
  div.querySelectorAll('b, strong').forEach((el) => {
    el.replaceWith(`**${el.textContent}**`);
  });
  div.querySelectorAll('i, em').forEach((el) => {
    el.replaceWith(`*${el.textContent}*`);
  });
  div.querySelectorAll('u').forEach((el) => {
    el.replaceWith(`__${el.textContent}__`);
  });
  div.querySelectorAll('s, strike, del').forEach((el) => {
    el.replaceWith(`~~${el.textContent}~~`);
  });
  div.querySelectorAll('code').forEach((el) => {
    el.replaceWith(`\`${el.textContent}\``);
  });

  // Convert lists to text
  div.querySelectorAll('ul').forEach((ul) => {
    const items = Array.from(ul.querySelectorAll('li')).map((li) => `• ${li.textContent}`).join('\n');
    ul.replaceWith(items);
  });
  div.querySelectorAll('ol').forEach((ol) => {
    const items = Array.from(ol.querySelectorAll('li')).map((li, i) => `${i + 1}. ${li.textContent}`).join('\n');
    ol.replaceWith(items);
  });

  return div.innerText;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function isImageFile(fileName: string): boolean {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
  return imageExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
}

export function MessageInput({
  channelId,
  parentId,
  placeholder,
  client,
  onSubmitOverride,
}: MessageInputProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const { user } = useUser();
  const { getClient } = useAppApiClient();
  const { replyTo, setReplyTo } = useChatContext();
  const [content, setContent] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<any[]>([]);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [showToolbar, setShowToolbar] = useState(false);
  const [showClipRecorder, setShowClipRecorder] = useState(false);
  const [isVoiceRecording, setIsVoiceRecording] = useState(false);
  const [voiceUploading, setVoiceUploading] = useState(false);
  // True only AFTER this session has actually produced a recording — prevents
  // the popup from briefly rendering the Send button when the underlying
  // voiceRecorder.state still holds stale 'recorded' from a previous session.
  const [voiceHasFinished, setVoiceHasFinished] = useState(false);
  const voiceRecorder = useClipRecorder();
  const waveformHistory = useRef<number[]>(new Array(60).fill(0.08));
  const waveformInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioLevelRef = useRef(0);
  const [waveformBars, setWaveformBars] = useState<number[]>(new Array(60).fill(0.08));
  const [activeFormats, setActiveFormats] = useState<Set<string>>(new Set());
  const editorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { mutate: sendMessage, isPending } = useSendMessage();
  const { mutate: addChannelMembers } = useAddChannelMembers();
  const { mutateAsync: createTask } = useCreateTask();
  const { data: agentsList = [] } = useAgents();
  const { onKeystroke, onSend: onTypingSend } = useTypingPublisher(client ?? null);
  const { data: membersData } = useWorkspaceMembers();

  // Draft autosave — persists content while the user types and restores on mount.
  const { deleteDraft: deleteSavedDraft } = useDraftAutosave({
    channelId,
    threadParentMessageId: parentId,
    content,
    attachments,
    onRestore: (restoredContent, restoredAttachments) => {
      // Only restore if the editor is still empty (race guard).
      if (!editorRef.current || editorRef.current.innerText.trim().length > 0) return;
      setContent(restoredContent);
      if (restoredAttachments.length > 0) setAttachments(restoredAttachments);
      // Render the content into the contentEditable editor.
      editorRef.current.innerText = restoredContent;
    },
  });

  const membersMap = useRef(new Map<string, string>());
  useEffect(() => {
    const map = new Map<string, string>();
    for (const m of membersData?.data ?? []) {
      if (m.userId && m.name) map.set(m.userId, m.name);
    }
    membersMap.current = map;
  }, [membersData]);

  // Auto-focus the input when the user opens or switches channels/threads
  useEffect(() => {
    editorRef.current?.focus();
  }, [channelId, parentId]);

  // Auto-focus the input when the user clicks "Reply" on a message — they
  // shouldn't have to click the input separately to start typing.
  useEffect(() => {
    if (replyTo) editorRef.current?.focus();
  }, [replyTo]);

  // Other message actions (emoji reactions, copy link, mark unread, …) close
  // their popovers and steal focus. Listen for an explicit "return focus to
  // input" event so the user can keep typing without clicking back in.
  useEffect(() => {
    const handler = () => editorRef.current?.focus();
    window.addEventListener('weldchat-focus-input', handler);
    return () => window.removeEventListener('weldchat-focus-input', handler);
  }, []);

  const clearInput = useCallback(() => {
    setContent('');
    setMentions([]);
    setAttachments([]);
    setReplyTo(null);
    setSlashQuery(null);
    if (editorRef.current) {
      editorRef.current.innerHTML = '';
    }
    // Delete the draft now that the message has been sent.
    deleteSavedDraft();
  }, [setReplyTo, deleteSavedDraft]);

  const runInviteAgent = useCallback(
    (agent: { id: string; name: string }) => {
      addChannelMembers({
        channelId,
        userIds: [agent.id],
        memberType: 'agent',
      });
      clearInput();
    },
    [addChannelMembers, channelId, clearInput],
  );

  const tryHandleInviteCommand = useCallback(
    (text: string): boolean => {
      const match = text.match(/^\/invite\s+(.+)$/i);
      if (!match) return false;
      const needle = match[1].trim().replace(/^@/, '').toLowerCase();
      if (!needle) return true; // "/invite " alone — swallow, let the palette guide
      const agent = (agentsList as any[]).find((a) => a.name?.toLowerCase() === needle);
      if (!agent) {
        // No exact match — fall back to first prefix match
        const loose = (agentsList as any[]).find((a) => a.name?.toLowerCase().startsWith(needle));
        if (!loose) {
          // Nothing to invite — swallow the command so it doesn't become a message
          return true;
        }
        runInviteAgent({ id: loose.id, name: loose.name });
        return true;
      }
      runInviteAgent({ id: agent.id, name: agent.name });
      return true;
    },
    [agentsList, runInviteAgent],
  );

  const tryHandleCreateTaskCommand = useCallback(
    (text: string): boolean => {
      const match = text.match(/^\/createtask\s+(.+)$/is);
      if (!match) return true; // "/createtask" alone — swallow, let the palette guide
      const title = match[1].trim();
      if (!title) return true;
      const t2 = t.weldchat.slashCommandPalette;
      void createTask({ title })
        .then(() => {
          toast.success(t2.taskCreated, {
            description: title,
            action: {
              label: t2.viewTask,
              onClick: () => {
                window.location.href = '/weldflow/my-tasks';
              },
            },
          });
        })
        .catch(() => {
          toast.error(t2.taskCreateFailed);
        });
      return true;
    },
    [createTask, t],
  );

  const handleSend = useCallback(() => {
    const raw = editorRef.current ? htmlToContent(editorRef.current.innerHTML) : content;
    const trimmed = raw.trim();
    if (!trimmed && attachments.length === 0) return;

    // Intercept slash commands that should never be posted as a message.
    if (trimmed.startsWith('/invite')) {
      tryHandleInviteCommand(trimmed);
      return;
    }
    if (trimmed.startsWith('/createtask')) {
      if (tryHandleCreateTaskCommand(trimmed)) {
        clearInput();
        return;
      }
    }

    onTypingSend();

    if (onSubmitOverride) {
      void Promise.resolve(
        onSubmitOverride({ content: trimmed, mentions, attachments }),
      );
      clearInput();
      return;
    }

    const replyParentId = replyTo?.messageId || parentId;
    sendMessage({
      channelId,
      content: trimmed,
      parentId: replyParentId,
      mentions: mentions.length > 0 ? mentions : undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
      _optimisticId: `opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    } as any);
    clearInput();
  }, [content, channelId, parentId, mentions, attachments, sendMessage, isPending, onTypingSend, replyTo, tryHandleInviteCommand, tryHandleCreateTaskCommand, clearInput, onSubmitOverride]);

  const handleClipReady = useCallback((clipAttachment: ChatClipAttachment) => {
    const replyParentId = replyTo?.messageId || parentId;
    sendMessage({
      channelId,
      content: '',
      parentId: replyParentId,
      attachments: [clipAttachment],
      _optimisticId: `opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    } as any);
    setReplyTo(null);
  }, [channelId, parentId, sendMessage, replyTo, setReplyTo]);

  // Voice recording inline handlers
  // Pre-warm flag — true once we've fired startPreview from a pointerdown,
  // so the click handler doesn't redundantly call it.
  const voicePrewarmedRef = useRef(false);

  // Fired on pointerdown of the mic button — kicks off `getUserMedia` BEFORE
  // the click event fires (~50–250ms head-start) so the stream is already
  // open by the time the user releases. Without this, the user sees ~1s of
  // dead time between click and the recorder actually starting.
  const prewarmVoiceRecording = useCallback(() => {
    if (voicePrewarmedRef.current) return;
    if (voiceRecorder.state !== 'idle') return;
    voicePrewarmedRef.current = true;
    voiceRecorder.setMode('audio');
    // Don't await — we want this to run in the background. The auto-start
    // useEffect below will fire `startRecording` as soon as state flips.
    voiceRecorder.startPreview();
  }, [voiceRecorder]);

  const startVoiceRecording = useCallback(async () => {
    setIsVoiceRecording(true);
    // If the pre-warm finished before this click, the stream is already
    // open and `state === 'previewing'` — fire startRecording directly so we
    // don't wait an extra React render cycle for the auto-start useEffect.
    if (voiceRecorder.state === 'previewing' && voiceRecorder.stream) {
      voiceRecorder.startRecording();
      return;
    }
    if (!voicePrewarmedRef.current) {
      voiceRecorder.setMode('audio');
      voiceRecorder.startPreview();
    }
  }, [voiceRecorder]);

  // Auto-start recording once preview is ready
  useEffect(() => {
    if (isVoiceRecording && voiceRecorder.state === 'previewing') {
      voiceRecorder.startRecording();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVoiceRecording, voiceRecorder.state]);

  // Keep audio level ref in sync
  useEffect(() => {
    audioLevelRef.current = voiceRecorder.audioLevel;
  }, [voiceRecorder.audioLevel]);

  // Sample audio level into waveform history
  useEffect(() => {
    if (isVoiceRecording && voiceRecorder.state === 'recording') {
      waveformHistory.current = new Array(60).fill(0.08);
      waveformInterval.current = setInterval(() => {
        waveformHistory.current = [...waveformHistory.current.slice(1), Math.max(0.08, Math.min(1, audioLevelRef.current * 2))];
        setWaveformBars([...waveformHistory.current]);
      }, 80);
    } else {
      if (waveformInterval.current) {
        clearInterval(waveformInterval.current);
        waveformInterval.current = null;
      }
    }
    return () => {
      if (waveformInterval.current) {
        clearInterval(waveformInterval.current);
        waveformInterval.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVoiceRecording, voiceRecorder.state]);

  // Mark "has finished" only on the actual 'recording' → 'recorded'
  // transition during THIS popup. Watching for state==='recorded' alone is
  // unsafe — a stale 'recorded' from a previous session could already be in
  // scope when isVoiceRecording flips back to true, and the effect would
  // immediately trip voiceHasFinished even though the new recording is just
  // starting (which is exactly the bug that left the Send arrow visible
  // while the waveform was still animating).
  const prevVoiceStateRef = useRef(voiceRecorder.state);
  useEffect(() => {
    if (
      isVoiceRecording &&
      prevVoiceStateRef.current === 'recording' &&
      voiceRecorder.state === 'recorded'
    ) {
      setVoiceHasFinished(true);
    }
    prevVoiceStateRef.current = voiceRecorder.state;
  }, [isVoiceRecording, voiceRecorder.state]);

  const cancelVoiceRecording = useCallback(() => {
    voiceRecorder.reset();
    setIsVoiceRecording(false);
    setVoiceHasFinished(false);
    voicePrewarmedRef.current = false;
    waveformHistory.current = new Array(60).fill(0.08);
    setWaveformBars(new Array(60).fill(0.08));
  }, [voiceRecorder]);

  const sendVoiceRecording = useCallback(async () => {
    if (!voiceRecorder.blob) return;
    setVoiceUploading(true);

    try {
      const client = await getClient();
      const ext = voiceRecorder.blob.type.includes('mp4') ? 'mp4' : 'webm';
      const fileName = `voice-${Date.now()}.${ext}`;

      const urlRes = await client.post<any>('/storage/generate-upload-url', {
        fileName,
        fileSize: voiceRecorder.blob.size,
        contentType: voiceRecorder.blob.type,
      });

      const { uploadUrl, uploadToken, fileKey } = urlRes;

      await fetch(uploadUrl, {
        method: 'PUT',
        body: voiceRecorder.blob,
        headers: { 'Content-Type': voiceRecorder.blob.type },
      });

      const confirmRes = await client.post<any>('/storage/confirm-upload', {
        uploadToken,
        fileKey,
      });

      const fileData = confirmRes?.file ?? confirmRes;

      const clipAttachment: ChatClipAttachment = {
        id: fileData?.id ?? fileKey,
        fileName,
        fileSize: voiceRecorder.blob.size,
        mimeType: voiceRecorder.blob.type,
        url: fileData?.url ?? '',
        clipType: 'audio',
        durationSeconds: voiceRecorder.duration,
      };

      handleClipReady(clipAttachment);
    } catch (err) {
      console.error('Voice clip upload failed:', err);
    } finally {
      voiceRecorder.reset();
      setIsVoiceRecording(false);
      setVoiceUploading(false);
      setVoiceHasFinished(false);
      voicePrewarmedRef.current = false;
    }
  }, [voiceRecorder, getClient, handleClipReady]);

  const handleInput = useCallback(() => {
    if (!editorRef.current) return;
    // Clear leftover empty elements so :empty placeholder shows
    const innerText = editorRef.current.innerText.trim();
    if (!innerText || innerText === '\n') {
      editorRef.current.innerHTML = '';
    }
    const raw = htmlToContent(editorRef.current.innerHTML);
    setContent(raw);
    onKeystroke();

    const text = editorRef.current.innerText;
    const atIndex = text.lastIndexOf('@');
    if (atIndex >= 0 && (atIndex === 0 || text[atIndex - 1] === ' ' || text[atIndex - 1] === '\n')) {
      const query = text.substring(atIndex + 1);
      if (!query.includes(' ') && !query.includes('\n')) {
        setMentionQuery(query);
      } else {
        setMentionQuery(null);
      }
    } else {
      setMentionQuery(null);
    }

    if (text.startsWith('/')) {
      const firstSpace = text.indexOf(' ');
      // /invite stays open past the first space so we can show the agent picker
      if (firstSpace === -1 || text.slice(0, firstSpace) === '/invite') {
        setSlashQuery(text);
      } else {
        setSlashQuery(null);
      }
    } else {
      setSlashQuery(null);
    }
  }, [onKeystroke]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && replyTo) {
      e.preventDefault();
      e.stopPropagation();
      setReplyTo(null);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    // Shift+Enter inside a list: insert a new list item instead of <br>
    if (e.key === 'Enter' && e.shiftKey) {
      const sel = window.getSelection();
      const node = sel?.anchorNode;
      const li = node instanceof HTMLElement ? node.closest('li') : node?.parentElement?.closest('li');
      if (li) {
        e.preventDefault();
        const newLi = document.createElement('li');
        newLi.appendChild(document.createElement('br'));
        li.after(newLi);
        const range = document.createRange();
        range.setStart(newLi, 0);
        range.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  }, [handleSend, replyTo, setReplyTo]);

  const handleMentionSelect = useCallback((selection: MentionSelection) => {
    if (!editorRef.current) return;

    const sel = window.getSelection();
    const text = editorRef.current.innerText;
    const atIndex = text.lastIndexOf('@');
    if (atIndex < 0) {
      setMentionQuery(null);
      return;
    }

    const before = text.substring(0, atIndex);
    let token: string;
    let mentionEntry: string;
    if (selection.kind === 'user') {
      token = `<@${selection.userId}>`;
      mentionEntry = selection.userId;
    } else if (selection.kind === 'entity') {
      token = encodeEntityToken(selection.type, selection.id, selection.title);
      mentionEntry = `entity:${selection.type}:${selection.id}`;
    } else {
      token = `<@everyone>`;
      mentionEntry = 'everyone';
    }

    const newContent = `${before}${token} `;
    setContent(newContent);
    setMentions((prev) => (prev.includes(mentionEntry) ? prev : [...prev, mentionEntry]));

    editorRef.current.innerHTML = contentToHtml(newContent, membersMap.current) + '&nbsp;';

    const range = document.createRange();
    range.selectNodeContents(editorRef.current);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);

    setMentionQuery(null);
  }, []);

  const triggerMention = useCallback(() => {
    if (!editorRef.current) return;
    editorRef.current.focus();
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const textNode = document.createTextNode('@');
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      editorRef.current.innerHTML += '@';
    }
    setMentionQuery('');
  }, []);

  const updateActiveFormats = useCallback(() => {
    const formats = new Set<string>();
    if (document.queryCommandState('bold')) formats.add('bold');
    if (document.queryCommandState('italic')) formats.add('italic');
    if (document.queryCommandState('underline')) formats.add('underline');
    if (document.queryCommandState('strikeThrough')) formats.add('strikeThrough');
    if (document.queryCommandState('insertUnorderedList')) formats.add('insertUnorderedList');
    if (document.queryCommandState('insertOrderedList')) formats.add('insertOrderedList');
    // Check if cursor is inside a <code> element
    const sel = window.getSelection();
    if (sel && sel.anchorNode) {
      const node = sel.anchorNode;
      const codeEl = node instanceof HTMLElement ? node.closest('code') : node.parentElement?.closest('code');
      if (codeEl && editorRef.current?.contains(codeEl)) formats.add('code');
    }
    setActiveFormats(formats);
  }, []);

  // Listen for selection changes to update active format states
  useEffect(() => {
    if (!showToolbar) return;
    document.addEventListener('selectionchange', updateActiveFormats);
    return () => document.removeEventListener('selectionchange', updateActiveFormats);
  }, [showToolbar, updateActiveFormats]);

  const applyFormat = useCallback((command: string) => {
    if (!editorRef.current) return;
    editorRef.current.focus();

    if (command === 'code') {
      // Re-read selection after focus
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      // Check if cursor is already inside a <code> — toggle off
      const node = sel.anchorNode;
      const codeEl = node instanceof HTMLElement ? node.closest('code') : node?.parentElement?.closest('code');
      if (codeEl) {
        const text = codeEl.textContent || '';
        const textNode = document.createTextNode(text);
        codeEl.replaceWith(textNode);
        const range = document.createRange();
        range.setStartAfter(textNode);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else if (!sel.isCollapsed) {
        // Wrap selected text in <code>
        const range = sel.getRangeAt(0);
        const fragment = range.extractContents();
        const code = document.createElement('code');
        code.className = 'bg-gray-100 dark:bg-gray-800 text-[13px] px-1 py-0.5 rounded font-mono';
        code.appendChild(fragment);
        range.insertNode(code);
        range.setStartAfter(code);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        // No selection — insert an empty code block and place cursor inside
        const code = document.createElement('code');
        code.className = 'bg-gray-100 dark:bg-gray-800 text-[13px] px-1 py-0.5 rounded font-mono';
        code.innerHTML = '&ZeroWidthSpace;';
        const range = sel.getRangeAt(0);
        range.insertNode(code);
        range.setStart(code, 0);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      handleInput();
    } else if (command === 'insertUnorderedList' || command === 'insertOrderedList') {
      document.execCommand(command, false);
      // Ensure the editor updates content state
      handleInput();
    } else {
      document.execCommand(command, false);
    }
    updateActiveFormats();
  }, [updateActiveFormats, handleInput]);

  // Upload one or more File objects through the same presign → PUT →
  // confirm flow the paperclip button uses, then push them onto the
  // composer's attachment list. Shared so the drag-and-drop overlay
  // can feed files in identically.
  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    const client = await getClient();
    for (const file of list) {
      try {
        const urlRes = await client.post<any>('/storage/generate-upload-url', {
          fileName: file.name,
          fileSize: file.size,
          contentType: file.type,
        });
        const { uploadUrl, uploadToken, fileKey } = urlRes;
        await fetch(uploadUrl, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': file.type },
        });
        const confirmRes = await client.post<any>('/storage/confirm-upload', {
          uploadToken,
          fileKey,
        });
        const fileData = confirmRes?.file ?? confirmRes;
        setAttachments((prev) => [...prev, {
          id: fileData?.id ?? fileKey,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          url: fileData?.url ?? '',
        }]);
      } catch (err) {
        console.error('File upload failed:', err);
      }
    }
  }, [getClient]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    await uploadFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [uploadFiles]);

  // Listen for files dropped onto the chat surface (see ChatDropZone). The
  // event carries channelId + optional parentId so the file lands in the
  // correct composer — a thread panel's MessageInput shouldn't swallow drops
  // meant for the main channel and vice versa.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{
        channelId: string;
        parentId?: string | null;
        files: File[];
      }>).detail;
      if (!detail || detail.channelId !== channelId) return;
      const targetParent = detail.parentId ?? null;
      const ownParent = parentId ?? null;
      if (targetParent !== ownParent) return;
      uploadFiles(detail.files);
    };
    window.addEventListener('weldchat:dropped-files', handler);
    return () => window.removeEventListener('weldchat:dropped-files', handler);
  }, [channelId, parentId, uploadFiles]);

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const insertEmoji = (emoji: string) => {
    if (editorRef.current) {
      editorRef.current.focus();
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(emoji));
        range.collapse(false);
      } else {
        editorRef.current.innerText += emoji;
      }
      setContent(htmlToContent(editorRef.current.innerHTML));
    }
    setEmojiPickerOpen(false);
  };

  const hasContent = content.trim() || attachments.length > 0;

  return (
    <div className="px-2 pb-2 md:px-4 md:pb-4 flex-shrink-0 relative">
      {/* Badge styles */}
      <style>{`
        .mention-badge {
          display: inline-block;
          background: rgb(239 246 255);
          color: rgb(37 99 235);
          border-radius: 4px;
          padding: 2px 4px;
          font-weight: 500;
          font-size: 14px;
          line-height: 18px;
          height: 22px;
          vertical-align: middle;
          cursor: default;
          user-select: none;
        }
        .dark .mention-badge {
          background: rgb(23 37 84);
          color: rgb(96 165 250);
        }
        .entity-mention-badge {
          display: inline-block;
          background: rgb(245 243 255);
          color: rgb(109 40 217);
          border-radius: 4px;
          padding: 2px 6px;
          font-weight: 500;
          font-size: 14px;
          line-height: 18px;
          height: 22px;
          vertical-align: middle;
          cursor: default;
          user-select: none;
        }
        .dark .entity-mention-badge {
          background: rgb(46 16 101);
          color: rgb(196 181 253);
        }
        [contenteditable]:empty:before {
          content: attr(data-placeholder);
          color: #9ca3af;
          pointer-events: none;
        }
        [contenteditable] ul, [contenteditable] ol {
          padding-left: 1.5em;
          margin: 2px 0;
        }
        [contenteditable] ul {
          list-style-type: disc;
        }
        [contenteditable] ol {
          list-style-type: decimal;
        }
        [contenteditable] li {
          padding: 1px 0;
        }
      `}</style>

      <div className="absolute left-0 right-0 bottom-full pointer-events-none">
        <TypingIndicator channelId={channelId} client={client} />
      </div>

      <div
        className={cn(
          "relative bg-white dark:bg-background border border-gray-200 dark:border-border rounded-[20px] px-[10px] pb-[10px] w-full flex flex-col shadow-[0_1px_4px_-1px_rgba(0,0,0,0.03)] cursor-text",
          replyTo ? "pt-[20px]" : attachments.length > 0 ? "pt-[20px]" : "pt-[10px]"
        )}
        onClick={(e) => {
          // Focus editor when clicking anywhere in the container (but not on buttons/popovers)
          const target = e.target as HTMLElement;
          if (!target.closest('button') && !target.closest('[role="dialog"]') && editorRef.current) {
            editorRef.current.focus();
          }
        }}
      >
        {/* ============ Normal Message Input ============ */}
          <>
            {/* Reply preview */}
            {replyTo && (
              <div className="mx-1.5 -mt-1 mb-1 rounded-lg bg-gray-100 dark:bg-secondary/60">
                <div className="flex items-start gap-2 px-3 py-2.5">
                  <CornerDownRight className="h-3.5 w-3.5 text-gray-900 dark:text-foreground mt-0.5 shrink-0" />
                  <p className="flex-1 min-w-0 text-[13px] text-gray-900 dark:text-foreground line-clamp-2 leading-snug">
                    &ldquo;{renderReplyPreview(replyTo.content, membersMap.current)}&rdquo;
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setReplyTo(null)}
                    className="shrink-0 p-1.5 -m-1 -mr-[6px] rounded-lg hover:bg-gray-200 dark:hover:bg-accent transition-colors"
                  >
                    <X className="h-3.5 w-3.5 text-gray-900 dark:text-foreground" />
                  </Button>
                </div>
              </div>
            )}

            {/* Attachment previews */}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3 px-[10px]">
                {attachments.map((att, i) => (
                  <div key={i} className="relative group">
                    {isImageFile(att.fileName) && att.url ? (
                      <div className="relative">
                        <img
                          src={att.url}
                          alt={att.fileName}
                          className="h-20 w-20 rounded-lg border border-gray-200 dark:border-border object-contain bg-gray-50 dark:bg-secondary"
                        />
                        <Button
                          variant="ghost"
                          onClick={() => removeAttachment(i)}
                          className="absolute -top-1.5 -right-1.5 p-1 bg-gray-900 dark:bg-accent rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X className="h-3 w-3 text-white" />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 bg-gray-100 dark:bg-secondary rounded-lg px-3 py-2 text-sm">
                        <FileText className="h-4 w-4 text-gray-400 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-gray-700 dark:text-muted-foreground truncate max-w-[120px]">{att.fileName}</p>
                          <p className="text-xs text-gray-400">{formatFileSize(att.fileSize)}</p>
                        </div>
                        <Button
                          variant="ghost"
                          onClick={() => removeAttachment(i)}
                          className="p-0.5 hover:bg-gray-200 dark:hover:bg-accent rounded"
                        >
                          <X className="h-3.5 w-3.5 text-gray-400" />
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* ContentEditable input area */}
            <div className="relative">
              {slashQuery !== null && (
                <SlashCommandPalette
                  query={slashQuery}
                  channelId={channelId}
                  onSelect={(cmd) => {
                    setContent(cmd);
                    setSlashQuery(null);
                    if (editorRef.current) {
                      editorRef.current.innerText = cmd;
                      editorRef.current.focus();
                    }
                  }}
                  onInviteAgent={runInviteAgent}
                />
              )}

              {mentionQuery !== null && slashQuery === null && (
                <div className="absolute bottom-full -left-[10px] -right-[10px] mb-6 z-50 [&>div]:static [&>div]:mb-0 [&>div]:rounded-xl">
                  <MentionAutocomplete query={mentionQuery} channelId={channelId} onSelect={handleMentionSelect} onDismiss={() => setMentionQuery(null)} />
                </div>
              )}

              {/* Formatting toolbar */}
              {showToolbar && (
                <div className="flex items-center gap-0.5 px-[10px] -mt-[2px] pt-[2px] pb-2 mb-2 border-b border-gray-100 dark:border-border/50">
                  {[
                    { icon: Bold, command: 'bold', title: st('sweep.weldchat.messageInput.bold') },
                    { icon: Italic, command: 'italic', title: st('sweep.weldchat.messageInput.italic') },
                    { icon: Underline, command: 'underline', title: st('sweep.weldchat.messageInput.underline') },
                    { icon: Strikethrough, command: 'strikeThrough', title: st('sweep.weldchat.messageInput.strikethrough') },
                    { icon: Code, command: 'code', title: st('sweep.weldchat.messageInput.code') },
                  ].map(({ icon: Icon, command, title }) => (
                    <Button
                      key={command}
                      variant="ghost"
                      onMouseDown={(e) => { e.preventDefault(); applyFormat(command); }}
                      className={cn(
                        "p-1.5 rounded-md transition-colors",
                        activeFormats.has(command)
                          ? "bg-gray-200 dark:bg-accent text-gray-800 dark:text-foreground"
                          : "text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent"
                      )}
                      title={title}
                    >
                      <Icon className="h-4 w-4" />
                    </Button>
                  ))}
                  <div className="w-px h-4 bg-gray-200 dark:bg-border mx-1" />
                  {[
                    { icon: List, command: 'insertUnorderedList', title: st('sweep.weldchat.messageInput.bulletList') },
                    { icon: ListOrdered, command: 'insertOrderedList', title: st('sweep.weldchat.messageInput.numberedList') },
                  ].map(({ icon: Icon, command, title }) => (
                    <Button
                      key={command}
                      variant="ghost"
                      onMouseDown={(e) => { e.preventDefault(); applyFormat(command); }}
                      className={cn(
                        "p-1.5 rounded-md transition-colors",
                        activeFormats.has(command)
                          ? "bg-gray-200 dark:bg-accent text-gray-800 dark:text-foreground"
                          : "text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent"
                      )}
                      title={title}
                    >
                      <Icon className="h-4 w-4" />
                    </Button>
                  ))}
                </div>
              )}

              <div
                ref={editorRef}
                contentEditable={!isVoiceRecording}
                data-testid="chat-composer"
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                data-placeholder={placeholder || t.weldchat.messageInput.placeholder}
                className={cn(
                  "w-full bg-transparent text-[15px] text-gray-900 dark:text-foreground placeholder:text-gray-500 dark:placeholder:text-muted-foreground outline-none resize-none min-h-[40px] flex-1 pl-[10px] pt-[7px] pb-3 max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words",
                  isVoiceRecording && "pointer-events-none opacity-50"
                )}
                style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(200,200,200,0.3) transparent' }}
                role="textbox"
              />
            </div>

            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileSelect}
              accept="image/*,.pdf,.doc,.docx,.txt,.xls,.xlsx"
            />

            {/* Bottom Actions */}
            <div className="flex items-center justify-between mt-auto">
              {/* Left - Plus and Emoji */}
              <div className="flex items-center gap-0">
                <Button
                  variant="ghost"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isPending}
                  className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title={t.weldchat.messageInput.addAttachment}
                >
                  <Plus className="h-[18px] w-[18px]" />
                </Button>
                <Popover open={emojiPickerOpen} onOpenChange={setEmojiPickerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      disabled={isPending}
                      className={cn(
                        "p-1.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                        emojiPickerOpen
                          ? "bg-gray-100 dark:bg-accent text-gray-700 dark:text-foreground"
                          : "text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent"
                      )}
                      title={t.weldchat.messageInput.emoji}
                    >
                      <Smile className="h-[18px] w-[18px]" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" side="top" sideOffset={8} className="w-[min(370px,calc(100vw-24px))] p-0">
                    <EmojiPicker onSelect={insertEmoji} />
                  </PopoverContent>
                </Popover>
                <Button
                  variant="ghost"
                  onClick={triggerMention}
                  disabled={isPending}
                  className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title={t.weldchat.messageInput.mentionSomeone}
                >
                  <AtSign className="h-[18px] w-[18px]" />
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setShowToolbar(prev => !prev)}
                  disabled={isPending}
                  className={cn(
                    "p-1.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                    showToolbar
                      ? "bg-gray-100 dark:bg-accent text-gray-700 dark:text-foreground"
                      : "text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent"
                  )}
                  title={t.weldchat.messageInput.formatting}
                >
                  <Baseline className="h-[18px] w-[18px]" />
                </Button>
                <div className="w-px h-4 bg-gray-200 dark:bg-border mx-1" />
                <Button
                  variant="ghost"
                  onClick={() => setShowClipRecorder(true)}
                  disabled={isPending}
                  className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title={t.weldchat.messageInput.recordClip}
                >
                  <Video className="h-[18px] w-[18px]" />
                </Button>
                <div className="relative">
                  <Button
                    variant="ghost"
                    onMouseEnter={() => {
                      // Hover pre-warm — the longest head start on desktop.
                      // By the time the user actually clicks, the audio
                      // device is usually already acquired so recording
                      // starts truly instantly.
                      if (isPending || isVoiceRecording) return;
                      prewarmVoiceRecording();
                    }}
                    onPointerDown={(e) => {
                      // Touch/mobile fallback — fires before click.
                      if (e.button !== 0 || isPending || isVoiceRecording) return;
                      prewarmVoiceRecording();
                    }}
                    onClick={() => { if (!isVoiceRecording) startVoiceRecording(); }}
                    disabled={isPending || isVoiceRecording}
                    className={cn(
                      "p-1.5 rounded-lg transition-colors disabled:cursor-not-allowed",
                      isVoiceRecording
                        ? "bg-gray-100 dark:bg-accent text-gray-700 dark:text-foreground"
                        : "text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent disabled:opacity-50"
                    )}
                    title={t.weldchat.messageInput.recordVoiceClip}
                  >
                    <Mic className="h-[18px] w-[18px]" />
                  </Button>

                  {/* Voice recorder popup */}
                  {isVoiceRecording && (
                    <div className="absolute bottom-full left-0 mb-2 z-50">
                      <div className="bg-popover border border-border rounded-[16px] shadow-lg px-3 py-3 flex items-center gap-2 w-[min(320px,calc(100vw-32px))]">
                        {/* Cancel */}
                        <Button
                          variant="ghost"
                          onClick={cancelVoiceRecording}
                          disabled={voiceUploading}
                          className="p-[7px] text-muted-foreground hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent rounded-[10px] transition-colors disabled:opacity-50 flex-shrink-0"
                          title={t.weldchat.messageInput.cancel}
                        >
                          <X className="h-4 w-4" />
                        </Button>

                        {/* Waveform */}
                        <div className="flex-1 flex items-center gap-2 overflow-hidden">
                          <div className="flex-1 flex items-center gap-[2px] h-8 overflow-hidden" style={{ willChange: 'contents' }}>
                            {waveformBars.map((level, i) => (
                              <div
                                key={i}
                                className="bg-blue-400 flex-shrink-0"
                                style={{ width: 1, height: `${Math.min(1, level) * 100}%`, minHeight: 1 }}
                              />
                            ))}
                          </div>
                        </div>

                        {/* Timer */}
                        <span className="text-xs font-mono tabular-nums text-muted-foreground flex-shrink-0">
                          {formatDuration(voiceRecorder.duration)}
                        </span>

                        {/* Stop — shown immediately on click for instant
                            visual feedback. Gated on `voiceHasFinished` (a
                            local flag flipped only AFTER this session's
                            recorder reaches 'recorded') so any stale
                            voiceRecorder.state from a prior session can't
                            briefly render the Send button first. */}
                        {!voiceHasFinished && !voiceUploading && (
                          <Button
                            variant="ghost"
                            onClick={() => {
                              if (voiceRecorder.state === 'recording') {
                                voiceRecorder.stopRecording();
                              } else {
                                cancelVoiceRecording();
                              }
                            }}
                            className="w-7 h-7 flex items-center justify-center bg-red-500 hover:bg-red-600 text-white rounded-full transition-colors flex-shrink-0"
                            title={t.weldchat.messageInput.stopRecording}
                          >
                            <Square className="h-3 w-3 fill-current" />
                          </Button>
                        )}

                        {voiceHasFinished && !voiceUploading && (
                          <Button
                            variant="ghost"
                            onClick={sendVoiceRecording}
                            className="w-7 h-7 rounded-lg flex items-center justify-center bg-primary text-primary-foreground hover:bg-primary/90 transition-all flex-shrink-0"
                            title={t.weldchat.messageInput.sendVoiceClip}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor" className="h-3.5 w-3.5 text-primary-foreground">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
                            </svg>
                          </Button>
                        )}

                        {voiceUploading && (
                          <div className="w-7 h-7 rounded-full flex items-center justify-center bg-primary/50 flex-shrink-0">
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary-foreground" />
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Right - Send */}
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  onClick={handleSend}
                  disabled={isPending || !hasContent}
                  data-testid="chat-send"
                  className={cn(
                    'w-8 h-8 rounded-[12px] flex items-center justify-center transition-all',
                    hasContent && !isPending
                      ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                      : 'bg-gray-300 dark:bg-muted text-gray-500 dark:text-muted-foreground cursor-not-allowed'
                  )}
                  title={t.weldchat.messageInput.sendMessage}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor" className={cn("h-[15px] w-[15px]", hasContent && !isPending ? "text-primary-foreground" : "text-gray-500 dark:text-muted-foreground")}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
                  </svg>
                </Button>
              </div>
            </div>
          </>
      </div>

      {/* Clip Recorder Dialog */}
      <ClipRecorder
        open={showClipRecorder}
        onClose={() => setShowClipRecorder(false)}
        onClipReady={handleClipReady}
        initialMode="video"
      />
    </div>
  );
}
