
import { useState, useRef, useEffect, useMemo } from 'react';
import {
  useGenerateAIReply,
  useGenerateEmailDraft,
} from '@/hooks/queries/use-mail-queries';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useParams, useRouter } from '@/lib/router';
import { Mail, User } from 'lucide-react';
import { MINIMIZED_DOCK_ROOM, MinimizedDockButton, minimizedDockRight } from '@/components/shared/minimized-dock-button';
import { MinimizedDockGroup, useMinimizedDockAllowed, useMinimizedDockOccupied } from '@/components/shared/minimized-dock';
import { formatAiBody } from '@/app/weldmail/lib/format-ai-body';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { useComposeSafe, type MinimizedCompose } from '@/contexts/compose-context';
import { useCallSafe } from '@/contexts/call-context';
import { useMobileNavOptional } from '@/contexts/mobile-nav-context';
import { mailApi } from '../lib/api-client';
import { useI18n } from '@/lib/i18n/provider';
import { useAiCreditsToast } from '@/hooks/use-ai-credits-toast';
import { usePeopleByEmails } from '@/hooks/queries/use-people-queries';
import { withPendingInput } from '@/app/weldmail/components/compose-recipients';
import { ComposeSurface } from '@/app/weldmail/components/compose-surface';
import {
  MAX_EMAIL_SIZE_BYTES,
  MailAttachmentUploadError,
  emailSizeExceedsLimit,
  uploadMailAttachments,
} from '@/app/weldmail/lib/upload-attachments';
import { buildComposeBodies, type ComposeBodies } from '@/app/weldmail/lib/compose-body';
import type { DraftFields } from '@/app/weldmail/lib/draft-autosave';
import { useDraftAutosave } from '@/app/weldmail/lib/use-draft-autosave';

const getAgentRight = minimizedDockRight;

function hasComposeContent(
  composeData: { to: string; subject: string; body: string },
  editorHtml: string | undefined,
) {
  return composeData.to || composeData.subject || composeData.body || (editorHtml?.trim());
}

function parseRecipients(str: string): string[] {
  return str.split(/[,;]/).map(e => e.trim()).filter(e => e.length > 0);
}

interface PanelDraftForm {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  cc: string;
  bcc: string;
}

// `editorHtml` is the live editor content; `form.body` only follows it on blur.
function buildPanelDraftFields(form: PanelDraftForm, editorHtml: string | undefined): DraftFields {
  const { body, htmlBody } = buildComposeBodies(editorHtml ?? form.body);
  return {
    subject: form.subject,
    to: parseRecipients(form.to),
    cc: parseRecipients(form.cc),
    bcc: parseRecipients(form.bcc),
    body,
    htmlBody,
    inReplyTo: form.inReplyTo || undefined,
  };
}

type UploadedMailAttachments = Awaited<ReturnType<typeof uploadMailAttachments>>;

/** The round button of one minimized mail: mail icon, first recipient as a badge. */
function MinimizedComposeButton({
  compose,
  stacked,
  front,
  onOpen,
  onDismiss,
}: Readonly<{
  compose: MinimizedCompose;
  /** Tucked behind the one below it until the stack is hovered. */
  stacked: boolean;
  /** The one in front of the stack; the others only show their badge once fanned out. */
  front: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}>) {
  const { t } = useI18n();
  const firstRecipient = parseRecipients(compose.data.to)[0] ?? '';
  const person = usePeopleByEmails(firstRecipient ? [firstRecipient] : []).data?.data?.[0];
  const avatarUrl = person?.avatarUrl ?? null;

  return (
    <MinimizedDockButton
      label={compose.data.subject || t.mail.floatingCompose.title}
      icon={<Mail className="size-4 text-foreground" />}
      avatarUrl={avatarUrl}
      avatarAlt={firstRecipient}
      avatarFallback={<User className="size-2 text-muted-foreground" />}
      stacked={stacked}
      front={front}
      onOpen={onOpen}
      onDismiss={onDismiss}
      openLabel={t.mail.floatingCompose.expand}
      dismissLabel={t.mail.floatingCompose.close}
      testId="floating-compose-minimized-btn"
      dismissTestId="floating-compose-minimized-close-btn"
    />
  );
}

// Room the open panel leaves for the minimized mails beside it: a button plus a gap.
const MINIMIZED_STACK_ROOM = MINIMIZED_DOCK_ROOM;

/**
 * The floating compose: the minimized mails, tucked into a stack that fans out
 * on hover, and the panel of the mail that is open. Opening a minimized mail
 * while another one is open puts that one aside in its place.
 */
export function FloatingComposePanel() {
  const composeContext = useComposeSafe();
  const dockAllowed = useMinimizedDockAllowed();
  // Anything docked, a minimized note included: the open panel sits beside it.
  const dockOccupied = useMinimizedDockOccupied();
  const minimizeOpenRef = useRef<(() => void) | null>(null);
  if (!composeContext) return null;

  const { minimizedComposes, restoreMinimized, dismissMinimized, composeSession } = composeContext;
  // The full-page compose has its Send button in that corner.
  const showStack = minimizedComposes.length > 0 && dockAllowed;

  return (
    <>
      {showStack && (
        <MinimizedDockGroup kind="mail" testId="floating-compose-minimized-stack">
          {minimizedComposes.map((compose, index) => (
            <MinimizedComposeButton
              key={compose.id}
              compose={compose}
              stacked={index > 0}
              front={index === minimizedComposes.length - 1}
              onOpen={() => {
                minimizeOpenRef.current?.();
                restoreMinimized(compose.id);
              }}
              onDismiss={() => dismissMinimized(compose.id)}
            />
          ))}
        </MinimizedDockGroup>
      )}
      {/* Keyed by the session, so every mail the panel opens starts from a clean form. */}
      <FloatingComposeOpen key={composeSession} minimizeRef={minimizeOpenRef} besideStack={dockOccupied && dockAllowed} />
    </>
  );
}

function FloatingComposeOpen({
  minimizeRef,
  besideStack,
}: Readonly<{
  /** Set while the panel is open: puts its mail aside as a minimized one. */
  minimizeRef: React.RefObject<(() => void) | null>;
  besideStack: boolean;
}>) {
  const { t } = useI18n();
  const handleAiCreditsError = useAiCreditsToast();
  const router = useRouter();
  const params = useParams();
  const composeContext = useComposeSafe();
  const accountId = (params?.accountId as string) || composeContext?.composeData?.accountId;
  const callContext = useCallSafe();
  const isDialerOpen = callContext?.isDialerOpen;
  const setIsDialerOpen = callContext?.setIsDialerOpen;
  const mobileNav = useMobileNavOptional();
  const { getClient } = useAppApiClient();
  const generateAIReplyMutation = useGenerateAIReply();
  const generateEmailDraftMutation = useGenerateEmailDraft();
  const agentRight = getAgentRight(mobileNav);
  // What is minimized keeps the corner; the open panel sits beside it.
  const panelRight = besideStack ? `calc(${agentRight} + ${MINIMIZED_STACK_ROOM})` : agentRight;

  // Only one floating panel at a time: close the call dialer when compose opens
  useEffect(() => {
    if (composeContext?.isComposeOpen && isDialerOpen) {
      setIsDialerOpen?.(false);
    }
  }, [composeContext?.isComposeOpen, isDialerOpen, setIsDialerOpen]);
  const textareaRef = useRef<HTMLDivElement>(null);
  const bodyInitializedRef = useRef(false);

  const [isSending, setIsSending] = useState(false);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [ccRecipients, setCcRecipients] = useState('');
  const [bccRecipients, setBccRecipients] = useState('');
  const [scheduledTime, setScheduledTime] = useState<Date | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const attachmentsInitializedRef = useRef(false);

  // To field, shared with the full-page compose: the committed recipients live
  // in the compose context (a comma-separated string, so both surfaces can hand
  // it to each other); the text still being typed stays local.
  const [toInput, setToInput] = useState('');
  const committedTo = composeContext?.composeData.to ?? '';
  const updateTo = composeContext?.updateComposeData;
  const toRecipients = useMemo(() => parseRecipients(committedTo), [committedTo]);
  const setToRecipients: React.Dispatch<React.SetStateAction<string[]>> = (action) => {
    const next = typeof action === 'function' ? action(toRecipients) : action;
    updateTo?.({ to: next.join(', ') });
  };
  // What would be sent right now: the chips plus anything not committed yet.
  const toWithPending = withPendingInput(toRecipients, toInput).join(', ');

  // Initialize body content only once when panel opens
  useEffect(() => {
    if (composeContext?.isComposeOpen && textareaRef.current && !bodyInitializedRef.current) {
      textareaRef.current.innerHTML = composeContext.composeData.body || '';
      bodyInitializedRef.current = true;
    }
    // Reset when panel closes
    if (!composeContext?.isComposeOpen) {
      bodyInitializedRef.current = false;
    }
  }, [composeContext?.isComposeOpen, composeContext?.composeData.body]);

  // Hydrate attachments from the compose context when the panel opens (e.g. popping
  // a reply out of message-detail). Don't re-run while the user is adding files.
  useEffect(() => {
    if (composeContext?.isComposeOpen && !attachmentsInitializedRef.current) {
      setAttachedFiles(composeContext.composeData.attachedFiles ?? []);
      attachmentsInitializedRef.current = true;
    }
    if (!composeContext?.isComposeOpen) {
      attachmentsInitializedRef.current = false;
      setAttachedFiles([]);
    }
  }, [composeContext?.isComposeOpen, composeContext?.composeData.attachedFiles]);

  // Hydrate Cc/Bcc and the scheduled time the same way (popped out of the full-page compose).
  const isComposeOpen = composeContext?.isComposeOpen ?? false;
  const contextCc = composeContext?.composeData.cc;
  const contextBcc = composeContext?.composeData.bcc;
  const contextScheduledTime = composeContext?.composeData.scheduledTime;
  const [ccHydrated, setCcHydrated] = useState(false);
  useEffect(() => {
    if (!isComposeOpen) {
      setCcRecipients('');
      setBccRecipients('');
      setShowCc(false);
      setShowBcc(false);
      setToInput('');
      setScheduledTime(null);
      setCcHydrated(false);
      return;
    }
    if (ccHydrated) return;
    setCcRecipients(contextCc ?? '');
    setBccRecipients(contextBcc ?? '');
    setShowCc(Boolean(contextCc));
    setShowBcc(Boolean(contextBcc));
    setScheduledTime(contextScheduledTime ?? null);
    setCcHydrated(true);
  }, [isComposeOpen, ccHydrated, contextCc, contextBcc, contextScheduledTime]);

  // Autosave the compose as a draft. The first report after the panel opens is
  // the baseline (a pre-filled reply) and is not saved on its own.
  const autosave = useDraftAutosave({ accountId, active: isComposeOpen });
  const { schedule: scheduleDraftSave } = autosave;
  const draftTo = toWithPending;
  const draftSubject = composeContext?.composeData.subject ?? '';
  const draftBody = composeContext?.composeData.body ?? '';
  const draftInReplyTo = composeContext?.composeData.inReplyTo;
  useEffect(() => {
    if (!isComposeOpen || !ccHydrated) return;
    scheduleDraftSave(
      buildPanelDraftFields(
        { to: draftTo, subject: draftSubject, body: draftBody, inReplyTo: draftInReplyTo, cc: ccRecipients, bcc: bccRecipients },
        textareaRef.current?.innerHTML,
      ),
    );
  }, [isComposeOpen, ccHydrated, scheduleDraftSave, draftTo, draftSubject, draftBody, draftInReplyTo, ccRecipients, bccRecipients]);

  const applyGeneratedBody = (body: string) => {
    if (!textareaRef.current) return;
    const html = formatAiBody(body);
    textareaRef.current.innerHTML = html;
    updateComposeData({ body: html });
  };

  // For replies, use the reply endpoint (body only)
  const generateAiReply = async (prompt: string): Promise<boolean> => {
    const result = await generateAIReplyMutation.mutateAsync({ userPrompt: prompt, messageId: composeData.inReplyTo, accountId: accountId || undefined });
    if (!(result.success && result.body)) return false;
    applyGeneratedBody(result.body);
    return true;
  };

  // For new emails, use the draft endpoint (subject + body)
  const generateAiDraft = async (prompt: string): Promise<boolean> => {
    const result = await generateEmailDraftMutation.mutateAsync({ prompt });
    if (!(result.success && result.data)) return false;
    if (result.data.subject) {
      updateComposeData({ subject: result.data.subject });
    }
    if (result.data.body) {
      applyGeneratedBody(result.data.body);
    }
    return true;
  };

  // Resolves to whether content was written, which is when the surface closes its AI bar.
  const handleAiGenerate = async (prompt: string): Promise<boolean> => {
    try {
      const generated = composeData.inReplyTo ? await generateAiReply(prompt) : await generateAiDraft(prompt);
      if (generated) {
        toast.success(t.mail.floatingCompose.aiContentGenerated);
      } else {
        toast.error(t.mail.floatingCompose.failedToGenerateContent);
      }
      return generated;
    } catch (err) {
      if (!handleAiCreditsError(err)) {
        toast.error(t.mail.floatingCompose.failedToGenerateContent);
      }
      return false;
    }
  };

  const [isExpanding, setIsExpanding] = useState(false);
  const prevIsComposeOpenRef = useRef(false);

  // Reset the expanding flag when compose re-opens (e.g., after minimizing from compose page)
  useEffect(() => {
    const isOpen = composeContext?.isComposeOpen ?? false;
    if (isOpen && !prevIsComposeOpenRef.current) {
      // Compose just opened (false → true transition), reset expanding flag
      setIsExpanding(false);
    }
    prevIsComposeOpenRef.current = isOpen;
  }, [composeContext?.isComposeOpen]);

  // Puts this mail aside as a minimized one, with everything the panel keeps to
  // itself and the saver of its draft, and closes the panel.
  const minimizeSelf = () => {
    if (!composeContext) return;
    const editorHtml = textareaRef.current?.innerHTML;
    const form = { ...composeContext.composeData, to: toWithPending, cc: ccRecipients, bcc: bccRecipients };
    // The draft gets the latest text before it is put aside.
    scheduleDraftSave(buildPanelDraftFields(form, editorHtml));
    composeContext.minimizeCompose(
      { ...form, body: editorHtml ?? form.body, attachedFiles, scheduledTime, accountId },
      autosave.detach(),
    );
    composeContext.closeCompose();
  };
  // The minimized stack calls this when one of its mails is opened over this one.
  useEffect(() => {
    if (!isComposeOpen) return undefined;
    minimizeRef.current = minimizeSelf;
    return () => {
      minimizeRef.current = null;
    };
  });

  if (!composeContext?.isComposeOpen || isExpanding) {
    return null;
  }

  const { composeData, updateComposeData, closeCompose } = composeContext;

  const handleExpand = () => {
    setIsExpanding(true);
    // Hand over everything this panel keeps to itself: what is still being typed
    // in To, Cc/Bcc, the attachments and the scheduled time.
    updateComposeData({
      to: toWithPending,
      cc: ccRecipients,
      bcc: bccRecipients,
      attachedFiles,
      scheduledTime,
    });
    // The full-page compose keeps updating the draft this panel already made.
    autosave.handOff();
    router.push(`/weldmail/${accountId}/inbox/compose`);
  };

  const handleClose = () => {
    closeCompose();
  };

  const showEmailSizeExceeded = () => {
    toast.error(t.mail.floatingCompose.emailSizeExceeded.replace('{mb}', String(MAX_EMAIL_SIZE_BYTES / (1024 * 1024))));
  };

  // Uploads the attachments; on failure shows the toast and resolves to null.
  const uploadAttachmentsOrToast = async (
    targetAccountId: string,
    resolveClient: () => Awaited<ReturnType<typeof getClient>> | Promise<Awaited<ReturnType<typeof getClient>>>,
  ): Promise<UploadedMailAttachments | null> => {
    try {
      const client = await resolveClient();
      return await uploadMailAttachments(client, targetAccountId, attachedFiles);
    } catch (err) {
      const filename = err instanceof MailAttachmentUploadError ? err.filename : 'file';
      toast.error(t.mail.floatingCompose.failedToUpload.replace('{filename}', filename));
      return null;
    }
  };

  // Runs once the message is out: the draft it was written in must leave Drafts.
  const finishSent = async () => {
    await autosave.discard();
    window.dispatchEvent(new Event('mail:refresh'));
    closeCompose();
  };

  const sendScheduledEmail = async (
    targetAccountId: string,
    bodies: ComposeBodies,
    toAddresses: string[],
    sendAt: Date,
  ) => {
    setIsSending(true);
    try {
      const client = await getClient();
      const ccAddresses = ccRecipients ? parseRecipients(ccRecipients) : undefined;
      const bccAddresses = bccRecipients ? parseRecipients(bccRecipients) : undefined;

      const { body, htmlBody } = bodies;
      if (emailSizeExceedsLimit(body, htmlBody, attachedFiles)) {
        showEmailSizeExceeded();
        return;
      }

      const uploadedAttachments = await uploadAttachmentsOrToast(targetAccountId, () => client);
      if (!uploadedAttachments) return;

      const result = await mailApi.scheduled.schedule({
        accountId: targetAccountId,
        to: toAddresses,
        cc: ccAddresses,
        bcc: bccAddresses,
        subject: composeData.subject.trim() || t.mail.composePage.noSubject,
        body,
        htmlBody,
        scheduledFor: sendAt,
        inReplyTo: composeData.inReplyTo || undefined,
        attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
      });
      if (result.success) {
        toast.success(t.mail.floatingCompose.emailScheduledFor.replace('{date}', format(sendAt, 'PPp')));
        await finishSent();
      } else {
        toast.error(result.error || t.mail.floatingCompose.failedToScheduleEmail);
      }
    } catch {
      toast.error(t.mail.floatingCompose.failedToScheduleEmail);
    } finally {
      setIsSending(false);
    }
  };

  const sendEmailNow = async (targetAccountId: string, bodies: ComposeBodies, toAddresses: string[]) => {
    setIsSending(true);
    try {
      const { body, htmlBody } = bodies;
      if (emailSizeExceedsLimit(body, htmlBody, attachedFiles)) {
        showEmailSizeExceeded();
        return;
      }

      let uploadedAttachments: UploadedMailAttachments = [];
      if (attachedFiles.length > 0) {
        const uploaded = await uploadAttachmentsOrToast(targetAccountId, getClient);
        if (!uploaded) return;
        uploadedAttachments = uploaded;
      }

      const result = await mailApi.messages.send(targetAccountId, {
        to: toAddresses,
        cc: ccRecipients ? parseRecipients(ccRecipients) : undefined,
        bcc: bccRecipients ? parseRecipients(bccRecipients) : undefined,
        subject: composeData.subject.trim() || t.mail.composePage.noSubject,
        body,
        htmlBody,
        inReplyTo: composeData.inReplyTo || undefined,
        attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
      });

      if (result.success) {
        toast.success(t.mail.floatingCompose.emailSentSuccessfully);
        await finishSent();
      } else {
        toast.error(result.error || t.mail.floatingCompose.failedToSendEmail);
      }
    } catch {
      toast.error(t.mail.floatingCompose.failedToSendEmail);
    } finally {
      setIsSending(false);
    }
  };

  const handleSend = async () => {
    if (isSending) return;
    // Get body content directly from the ref (may not be synced to context yet)
    const bodies = buildComposeBodies(textareaRef.current ? textareaRef.current.innerHTML : composeData.body || '');

    if (!toWithPending.trim()) {
      toast.error(t.mail.composePage.atLeastOneRecipient);
      return;
    }
    if (!accountId) {
      toast.error(t.mail.composePage.noAccountSelected);
      return;
    }
    if (!bodies.body) {
      toast.error(t.mail.composePage.enterMessage);
      return;
    }

    const toAddresses = parseRecipients(toWithPending);

    if (scheduledTime) {
      await sendScheduledEmail(accountId, bodies, toAddresses, scheduledTime);
      return;
    }
    await sendEmailNow(accountId, bodies, toAddresses);
  };

  // Creates the draft, or updates the one autosave already made.
  const handleSaveDraft = async () => {
    if (!accountId) {
      toast.error(t.mail.composePage.noAccountSelected);
      return;
    }
    const saved = await autosave.saveNow(
      buildPanelDraftFields({ ...composeData, to: toWithPending, cc: ccRecipients, bcc: bccRecipients }, textareaRef.current?.innerHTML),
    );
    if (saved) {
      toast.success(t.mail.floatingCompose.draftSaved);
    } else {
      toast.error(t.mail.floatingCompose.failedToSaveDraft);
    }
    handleClose();
  };

  const hasContent = hasComposeContent({ ...composeData, to: toWithPending }, textareaRef.current?.innerHTML);

  return (
    <>
      {/* The compose design itself is shared with the full-page compose. */}
      <ComposeSurface
        className={cn(
          'fixed bottom-3 z-50 w-[640px] min-h-[min(500px,80vh)] max-h-[80vh] rounded-xl border border-border shadow-[0_0_20px_rgba(0,0,0,0.06)] dark:shadow-[0_0_20px_rgba(0,0,0,0.3)]',
        )}
        style={{ right: panelRight, maxWidth: `calc(100vw - ${panelRight} - 12px)` }}
        testIdPrefix="floating-compose"
        accountId={accountId}
        onMinimize={minimizeSelf}
        onExpand={handleExpand}
        // Closing keeps what was written as a draft.
        onClose={() => (hasContent ? void handleSaveDraft() : handleClose())}
        closeTitle={hasContent ? t.mail.floatingCompose.saveAndCloseDraft : undefined}
        toRecipients={toRecipients}
        setToRecipients={setToRecipients}
        toInput={toInput}
        setToInput={setToInput}
        showCc={showCc}
        showBcc={showBcc}
        onShowCc={() => setShowCc(true)}
        onShowBcc={() => setShowBcc(true)}
        cc={ccRecipients}
        bcc={bccRecipients}
        onCcChange={setCcRecipients}
        onBccChange={setBccRecipients}
        subject={composeData.subject}
        onSubjectChange={(subject) => updateComposeData({ subject })}
        editorRef={textareaRef}
        onBodyInput={(html) =>
          scheduleDraftSave(
            buildPanelDraftFields({ ...composeData, to: toWithPending, cc: ccRecipients, bcc: bccRecipients }, html),
          )
        }
        onBodyBlur={(body) => updateComposeData({ body })}
        attachedFiles={attachedFiles}
        onAttachedFilesChange={setAttachedFiles}
        scheduledTime={scheduledTime}
        onScheduledTimeChange={setScheduledTime}
        onAiGenerate={handleAiGenerate}
        onSend={() => void handleSend()}
        isSending={isSending}
      />
    </>
  );
}
