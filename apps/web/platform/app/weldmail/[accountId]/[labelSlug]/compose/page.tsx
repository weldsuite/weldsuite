
import { useState, useRef, useEffect } from 'react';
import { formatAiBody } from '@/app/weldmail/lib/format-ai-body';
import { useParams, useRouter, useSearchParams } from '@/lib/router';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { mailApi } from '../../../lib/api-client';
import { useAppApi, useAppApiClient } from '@/lib/api/use-app-api';
import type { MailDraftRow } from '@weldsuite/app-api-client/domains/mail-drafts';
import { buildComposeBodies, plainTextToHtml, type ComposeBodies } from '@/app/weldmail/lib/compose-body';
import { replaceBodyKeepingSignature, userWrittenText, type SignatureMode } from '@/app/weldmail/lib/signature';
import type { DraftFields } from '@/app/weldmail/lib/draft-autosave';
import { useDraftAutosave } from '@/app/weldmail/lib/use-draft-autosave';
import { useComposeSafe } from '@/contexts/compose-context';
import { useI18n } from '@/lib/i18n/provider';
import { withPendingInput } from '@/app/weldmail/components/compose-recipients';
import { ComposeSurface } from '@/app/weldmail/components/compose-surface';
import {
  MAX_EMAIL_SIZE_BYTES,
  MailAttachmentUploadError,
  emailSizeExceedsLimit,
  uploadMailAttachments,
  type MailAttachmentRef,
  type MailUploadClient,
} from '@/app/weldmail/lib/upload-attachments';

interface ComposePageProps {
  accountId?: string;
  labelSlug?: string;
  returnUrl?: string;
}

type ComposeContextValue = ReturnType<typeof useComposeSafe>;

// Everything the send / save-draft flows read from the compose form.
interface ComposeFormSnapshot {
  toRecipients: string[];
  toInput: string;
  subject: string;
  body: string;
  ccRecipients: string;
  bccRecipients: string;
  attachedFiles: File[];
  scheduledTime: Date | null;
}

const parseRecipients = (str: string): string[] =>
  str.split(/[,;]/).map((e) => e.trim()).filter((e) => e.length > 0);

const parseOptionalRecipients = (str: string): string[] | undefined =>
  (str ? parseRecipients(str) : undefined);

const attachmentsOrUndefined = (attachments: MailAttachmentRef[]): MailAttachmentRef[] | undefined =>
  (attachments.length > 0 ? attachments : undefined);

const getErrorStatus = (err: unknown): number | undefined => {
  const e = err as { status?: number; response?: { status?: number } } | undefined;
  return e?.status || e?.response?.status;
};

function getInitialComposeValues(composeContext: ComposeContextValue) {
  const data = composeContext?.composeData;
  if (!data || !(data.to || data.subject || data.body || data.cc || data.bcc)) {
    return { to: [] as string[], subject: '', body: '', cc: '', bcc: '' };
  }
  return {
    to: data.to ? parseRecipients(data.to) : [],
    subject: data.subject || '',
    body: data.body || '',
    cc: data.cc || '',
    bcc: data.bcc || '',
  };
}

interface LoadedDraftFields {
  to?: string[];
  subject?: string;
  cc?: string;
  bcc?: string;
  body?: string;
  inReplyTo?: string;
}

function extractDraftFields(draft: MailDraftRow): LoadedDraftFields {
  const fields: LoadedDraftFields = {};
  if (draft.to && draft.to.length > 0) fields.to = draft.to;
  if (draft.subject) fields.subject = draft.subject;
  if (draft.cc?.length) fields.cc = draft.cc.join(', ');
  if (draft.bcc?.length) fields.bcc = draft.bcc.join(', ');
  // A draft made elsewhere may only have a text part; the editor needs markup.
  const draftBody = draft.htmlBody || (draft.body ? plainTextToHtml(draft.body) : '');
  if (draftBody) fields.body = draftBody;
  if (draft.inReplyTo) fields.inReplyTo = draft.inReplyTo;
  return fields;
}

interface DraftFieldSetters {
  setToRecipients: (to: string[]) => void;
  setSubject: (subject: string) => void;
  setCcRecipients: (cc: string) => void;
  setShowCc: (show: boolean) => void;
  setBccRecipients: (bcc: string) => void;
  setShowBcc: (show: boolean) => void;
  setEditorContent: (html: string) => void;
  setInReplyTo: (id: string) => void;
}

function applyDraftFields(fields: LoadedDraftFields, setters: DraftFieldSetters) {
  if (fields.to) setters.setToRecipients(fields.to);
  if (fields.subject) setters.setSubject(fields.subject);
  if (fields.cc !== undefined) {
    setters.setCcRecipients(fields.cc);
    setters.setShowCc(true);
  }
  if (fields.bcc !== undefined) {
    setters.setBccRecipients(fields.bcc);
    setters.setShowBcc(true);
  }
  if (fields.body) setters.setEditorContent(fields.body);
  if (fields.inReplyTo) setters.setInReplyTo(fields.inReplyTo);
}

// An opened draft keeps the signature it was saved with (or none).
function composeSignatureMode(draftId: string | null, inReplyTo: string | undefined): SignatureMode | null {
  if (draftId) return null;
  return inReplyTo ? 'reply' : 'new';
}

type DraftFormSnapshot = Pick<
  ComposeFormSnapshot,
  'toRecipients' | 'toInput' | 'subject' | 'body' | 'ccRecipients' | 'bccRecipients'
>;

// `editorHtml` is the live editor content. The form's `body` only follows it on
// blur, so it is just the fallback for when the editor is not mounted.
function buildDraftFields(
  form: DraftFormSnapshot,
  editorHtml: string | undefined,
  inReplyTo: string | undefined,
): DraftFields {
  const html = editorHtml ?? form.body;
  const { body, htmlBody } = buildComposeBodies(html);
  return {
    subject: form.subject,
    to: withPendingInput(form.toRecipients, form.toInput),
    cc: parseRecipients(form.ccRecipients),
    bcc: parseRecipients(form.bccRecipients),
    body,
    htmlBody,
    inReplyTo,
    contentText: userWrittenText(html),
  };
}

function useComposeRouteParams({ accountId: accountIdProp, labelSlug: labelSlugProp, returnUrl: returnUrlProp }: ComposePageProps) {
  const params = useParams();
  const searchParams = useSearchParams();
  return {
    draftId: searchParams?.get('draftId') || null,
    inReplyToParam: searchParams?.get('inReplyTo') || null,
    returnUrlParam: returnUrlProp || searchParams?.get('returnUrl') || null,
    accountId: accountIdProp || (params?.accountId as string),
    labelSlug: labelSlugProp || (params?.labelSlug as string),
  };
}

// Sync from compose context if URL params were not provided
function useComposeContextSync({
  contextInReplyTo,
  contextPreviousUrl,
  draftId,
  inReplyTo,
  inReplyToParam,
  returnUrlParam,
  setInReplyTo,
  returnUrl,
}: {
  contextInReplyTo: string | undefined;
  contextPreviousUrl: string | null | undefined;
  draftId: string | null;
  inReplyTo: string | undefined;
  inReplyToParam: string | null;
  returnUrlParam: string | null;
  setInReplyTo: (id: string) => void;
  returnUrl: { current: string | null };
}) {
  useEffect(() => {
    if (!draftId && !inReplyToParam && contextInReplyTo && !inReplyTo) {
      setInReplyTo(contextInReplyTo);
    }
    if (!returnUrlParam && contextPreviousUrl && !returnUrl.current) {
      returnUrl.current = contextPreviousUrl;
    }
  }, [contextInReplyTo, contextPreviousUrl, draftId, inReplyTo, inReplyToParam, returnUrlParam, setInReplyTo, returnUrl]);
}

// Initialize editor with body from compose context
function useInitEditorFromContext(
  composeContext: ComposeContextValue,
  draftId: string | null,
  editorRef: React.RefObject<HTMLDivElement | null>,
  isMinimizingRef: { current: boolean },
) {
  const hasInitializedFromContext = useRef(false);
  useEffect(() => {
    if (hasInitializedFromContext.current || draftId || !composeContext || !editorRef.current) return;
    const { body } = composeContext.composeData;
    // Nothing was handed over: no body to adopt and no floating panel to take over from.
    if (!body && !composeContext.isComposeOpen) return;
    hasInitializedFromContext.current = true;
    if (body) editorRef.current.innerHTML = body;
    // This page took over, so close the floating panel (but not if we're minimizing).
    // That holds for a compose without body text too: left open, the panel stays
    // hidden behind its "expanding" flag and never comes back on Minimize.
    if (composeContext.isComposeOpen && !isMinimizingRef.current) {
      composeContext.closeCompose();
    }
  }, [composeContext, draftId, editorRef, isMinimizingRef]);
}

// Load draft from API when draftId is provided
function useLoadDraft(
  draftId: string | null,
  onLoaded: (draft: MailDraftRow) => void,
  onFailed: () => void,
) {
  const { mailDrafts } = useAppApi();
  const hasLoadedDraft = useRef(false);
  useEffect(() => {
    if (!draftId || hasLoadedDraft.current) return;
    hasLoadedDraft.current = true;
    // The API answers `{ data }` (no `success` flag) and rejects on failure.
    mailDrafts
      .get(draftId)
      .then((result) => {
        if (result.data) onLoaded(result.data);
        else onFailed();
      })
      .catch(onFailed);
  }, [draftId, mailDrafts, onLoaded, onFailed]);
}

// Generates a draft from a prompt. Resolves to whether it wrote something, which
// is when the compose surface closes its AI bar.
function useAiDraft({
  accountId,
  inReplyTo,
  subject,
  onSubject,
  onBody,
}: {
  accountId: string;
  inReplyTo: string | undefined;
  subject: string;
  onSubject: (subject: string) => void;
  onBody: (html: string) => void;
}) {
  const { t } = useI18n();
  const { getClient } = useAppApiClient();

  const applyDraft = (draft: { subject: string; body: string }) => {
    if (draft.subject && !subject) {
      onSubject(draft.subject);
    }
    if (draft.body) {
      onBody(formatAiBody(draft.body));
    }
  };

  const generateAiDraft = async (prompt: string): Promise<boolean> => {
    try {
      const client = await getClient();
      const result = await client.post<{ success: boolean; data: { subject: string; body: string } }>(
        '/mail-ai/draft',
        { prompt, accountId: accountId || undefined, replyToMessageId: inReplyTo || undefined }
      );
      if (result.success && result.data) {
        applyDraft(result.data);
        toast.success(t.mail.composePage.aiDraftGenerated);
        return true;
      }
      return false;
    } catch (err) {
      toast.error(
        getErrorStatus(err) === 402
          ? t.mail.composePage.insufficientAiCredits
          : t.mail.composePage.failedToGenerateDraft,
      );
      return false;
    }
  };

  return { generateAiDraft };
}

function useComposeSend({
  accountId,
  returnUrl,
  editorRef,
  form,
  onSent,
}: {
  accountId: string;
  returnUrl: { current: string | null };
  editorRef: React.RefObject<HTMLDivElement | null>;
  form: ComposeFormSnapshot;
  /** Runs after a send or schedule succeeded, e.g. to remove the draft it came from. */
  onSent: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const cp = t.mail.composePage;
  const router = useRouter();
  const { getClient } = useAppApiClient();
  const [isSending, setIsSending] = useState(false);

  const finishSend = async (fallbackUrl: string) => {
    // The message is out, so the draft it was written in must leave Drafts.
    await onSent();
    window.dispatchEvent(new Event('mail:refresh'));
    router.push(returnUrl.current || fallbackUrl);
  };

  const notifyEmailTooLarge = () =>
    toast.error(cp.emailSizeExceeded.replace('{mb}', String(MAX_EMAIL_SIZE_BYTES / (1024 * 1024))));

  // Uploads the attachments, or shows the failure toast and returns null.
  const uploadAttachmentsOrNotify = async (
    resolveClient: () => Promise<MailUploadClient>,
  ): Promise<MailAttachmentRef[] | null> => {
    try {
      const client = await resolveClient();
      return await uploadMailAttachments(client, accountId, form.attachedFiles);
    } catch (err) {
      const filename = err instanceof MailAttachmentUploadError ? err.filename : 'file';
      toast.error(cp.failedToUpload.replace('{filename}', filename));
      return null;
    }
  };

  const sendScheduled = async (toAddresses: string[], bodies: ComposeBodies, scheduledFor: Date) => {
    setIsSending(true);
    try {
      const client = await getClient();
      const { body, htmlBody } = bodies;
      if (emailSizeExceedsLimit(body, htmlBody, form.attachedFiles)) {
        notifyEmailTooLarge();
        return;
      }

      const uploadedAttachments = await uploadAttachmentsOrNotify(() => Promise.resolve(client));
      if (!uploadedAttachments) return;

      const result = await mailApi.scheduled.schedule({
        accountId,
        to: toAddresses,
        cc: parseOptionalRecipients(form.ccRecipients),
        bcc: parseOptionalRecipients(form.bccRecipients),
        subject: form.subject.trim() || cp.noSubject,
        body,
        htmlBody,
        scheduledFor,
        attachments: attachmentsOrUndefined(uploadedAttachments),
      });
      if (result.success) {
        toast.success(cp.emailScheduledFor.replace('{date}', format(scheduledFor, 'PPp')));
        await finishSend(`/weldmail/${accountId}/sent`);
      } else {
        toast.error(result.error || cp.failedToScheduleEmail);
      }
    } catch {
      toast.error(cp.failedToScheduleEmail);
    } finally {
      setIsSending(false);
    }
  };

  const sendNow = async (toAddresses: string[], bodies: ComposeBodies) => {
    setIsSending(true);
    try {
      const { body, htmlBody } = bodies;
      if (emailSizeExceedsLimit(body, htmlBody, form.attachedFiles)) {
        notifyEmailTooLarge();
        return;
      }

      const uploadedAttachments = await uploadAttachmentsOrNotify(getClient);
      if (!uploadedAttachments) return;

      const result = await mailApi.messages.send(accountId, {
        to: toAddresses,
        cc: parseOptionalRecipients(form.ccRecipients),
        bcc: parseOptionalRecipients(form.bccRecipients),
        subject: form.subject.trim() || cp.noSubject,
        body,
        htmlBody,
        attachments: attachmentsOrUndefined(uploadedAttachments),
      });

      if (result.success) {
        toast.success(cp.emailSentSuccessfully);
        await finishSend(`/weldmail/${accountId}/sent`);
      } else {
        toast.error(result.error || cp.failedToSendEmail);
      }
    } catch {
      toast.error(cp.failedToSendEmail);
    } finally {
      setIsSending(false);
    }
  };

  const handleSend = async () => {
    if (isSending) return;
    // Read the editor directly so Ctrl+Enter sends text that has not blurred yet.
    const editorHtml = editorRef.current ? editorRef.current.innerHTML : form.body;
    const bodies = buildComposeBodies(editorHtml);
    // Commit any pending input
    const toAddresses = withPendingInput(form.toRecipients, form.toInput);
    if (toAddresses.length === 0) {
      toast.error(cp.atLeastOneRecipient);
      return;
    }
    if (!userWrittenText(editorHtml)) {
      toast.error(cp.enterMessage);
      return;
    }
    if (form.scheduledTime) {
      await sendScheduled(toAddresses, bodies, form.scheduledTime);
      return;
    }
    await sendNow(toAddresses, bodies);
  };

  return { isSending, handleSend };
}

function useDraftActions({
  editorRef,
  form,
  inReplyTo,
  autosave,
  onClose,
}: {
  editorRef: React.RefObject<HTMLDivElement | null>;
  form: ComposeFormSnapshot;
  inReplyTo: string | undefined;
  autosave: Pick<ReturnType<typeof useDraftAutosave>, 'saveNow'>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const cp = t.mail.composePage;

  // Creates the draft, or updates the one autosave already made.
  const handleSaveDraft = async () => {
    const saved = await autosave.saveNow(buildDraftFields(form, editorRef.current?.innerHTML, inReplyTo));
    if (saved) {
      toast.success(cp.draftSaved);
    } else {
      toast.error(cp.failedToSaveDraft);
    }
    onClose();
  };

  return { handleSaveDraft };
}

export default function ComposePage(props: ComposePageProps = {}) {
  const { t } = useI18n();
  const router = useRouter();
  const { draftId, inReplyToParam, returnUrlParam, accountId, labelSlug } = useComposeRouteParams(props);
  const textareaRef = useRef<HTMLDivElement>(null);
  const composeContext = useComposeSafe();

  // Form state - initialize from compose context if available
  const [initial] = useState(() => getInitialComposeValues(composeContext));
  const [toRecipients, setToRecipients] = useState<string[]>(initial.to);
  const [toInput, setToInput] = useState('');
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);

  const [showCc, setShowCc] = useState(Boolean(initial.cc));
  const [showBcc, setShowBcc] = useState(Boolean(initial.bcc));
  const [ccRecipients, setCcRecipients] = useState(initial.cc);
  const [bccRecipients, setBccRecipients] = useState(initial.bcc);
  const [scheduledTime, setScheduledTime] = useState<Date | null>(
    () => composeContext?.composeData.scheduledTime ?? null,
  );
  const [attachedFiles, setAttachedFiles] = useState<File[]>(
    () => composeContext?.composeData.attachedFiles ?? [],
  );

  // Use URL params (most reliable) with compose context as fallback
  const returnUrl = useRef<string | null>(returnUrlParam || composeContext?.previousUrl || null);
  const [bodyHasText, setBodyHasText] = useState(false);
  // An opened draft is not the user's form until it has loaded; autosaving the
  // empty form over it would wipe it.
  const [draftLoaded, setDraftLoaded] = useState(!draftId);
  const [inReplyTo, setInReplyTo] = useState<string | undefined>(inReplyToParam || composeContext?.composeData.inReplyTo || undefined);
  const isMinimizingRef = useRef(false);

  useComposeContextSync({
    contextInReplyTo: composeContext?.composeData.inReplyTo,
    contextPreviousUrl: composeContext?.previousUrl,
    draftId,
    inReplyTo,
    inReplyToParam,
    returnUrlParam,
    setInReplyTo,
    returnUrl,
  });
  useInitEditorFromContext(composeContext, draftId, textareaRef, isMinimizingRef);

  // A loaded draft or an AI draft; a signature already in the editor stays below it.
  const setEditorContent = (html: string) => {
    if (!textareaRef.current) {
      setBody(html);
      return;
    }
    replaceBodyKeepingSignature(textareaRef.current, html);
    setBody(textareaRef.current.innerHTML);
  };

  const applyLoadedDraft = (draft: MailDraftRow) => {
    applyDraftFields(extractDraftFields(draft), {
      setToRecipients,
      setSubject,
      setCcRecipients,
      setShowCc,
      setBccRecipients,
      setShowBcc,
      setEditorContent,
      setInReplyTo,
    });
    setDraftLoaded(true);
  };
  const handleDraftLoadFailed = () => toast.error(t.mail.composePage.failedToLoadDraft);
  useLoadDraft(draftId, applyLoadedDraft, handleDraftLoadFailed);

  const autosave = useDraftAutosave({ accountId, initialDraftId: draftId, enabled: draftLoaded });

  const ai = useAiDraft({ accountId, inReplyTo, subject, onSubject: setSubject, onBody: setEditorContent });

  const handleClose = () => {
    router.push(returnUrl.current || `/weldmail/${accountId}/${labelSlug}`);
  };

  // Leaves the page with the mail kept: opened in the floating panel, or put
  // aside as a minimized button next to any others.
  const handleMinimize = (minimized: boolean) => {
    if (!composeContext) {
      // Fallback if context not available
      handleClose();
      return;
    }
    isMinimizingRef.current = true;

    // Get the current body content from the editor
    const currentBody = textareaRef.current?.innerHTML || body;

    const data = {
      to: withPendingInput(toRecipients, toInput).join(', '),
      subject,
      body: currentBody,
      cc: ccRecipients,
      bcc: bccRecipients,
      attachedFiles,
      scheduledTime,
      accountId,
    };
    if (minimized) {
      // The minimized mail keeps the draft this page already made.
      composeContext.minimizeCompose(data, autosave.detach());
    } else {
      // The floating panel keeps updating that draft.
      autosave.handOff();
      composeContext.minimizeToPanel(data);
    }

    // Navigate back to where the user came from
    handleClose();
  };

  const form: ComposeFormSnapshot = {
    toRecipients,
    toInput,
    subject,
    body,
    ccRecipients,
    bccRecipients,
    attachedFiles,
    scheduledTime,
  };
  const { isSending, handleSend } = useComposeSend({
    accountId,
    returnUrl,
    editorRef: textareaRef,
    form,
    onSent: autosave.discard,
  });
  const { handleSaveDraft } = useDraftActions({
    editorRef: textareaRef,
    form,
    inReplyTo,
    autosave,
    onClose: handleClose,
  });

  // Reports the form to the autosave. The first report is the baseline (the
  // pre-filled form, or the draft that was just loaded) and is not saved.
  const { schedule: scheduleDraftSave } = autosave;
  const reportDraftChange = (editorHtml: string | undefined) =>
    scheduleDraftSave(buildDraftFields(form, editorHtml, inReplyTo));
  useEffect(() => {
    scheduleDraftSave(
      buildDraftFields(
        { toRecipients, toInput, subject, body, ccRecipients, bccRecipients },
        textareaRef.current?.innerHTML,
        inReplyTo,
      ),
    );
  }, [scheduleDraftSave, draftLoaded, toRecipients, toInput, subject, body, ccRecipients, bccRecipients, inReplyTo]);

  // A body holding only the signature compose put in is not content.
  const hasContent = Boolean(toRecipients.length > 0 || toInput || subject || userWrittenText(body) || bodyHasText);

  // The compose design is shared with the floating panel (ComposeSurface); this
  // page only supplies the message, the draft and the sending.
  return (
    <ComposeSurface
      className="h-full"
      headerClassName="h-[53px]"
      toolbarClassName="h-[53px]"
      accountId={accountId}
      onMinimize={() => handleMinimize(true)}
      onPopOut={() => handleMinimize(false)}
      hideMinimizeOnMobile
      // Closing keeps what was written as a draft.
      onClose={() => (hasContent ? void handleSaveDraft() : handleClose())}
      closeTitle={hasContent ? t.mail.composePage.saveAndCloseDraft : undefined}
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
      subject={subject}
      onSubjectChange={setSubject}
      editorRef={textareaRef}
      onBodyInput={(html) => {
        setBodyHasText(Boolean(userWrittenText(html)));
        reportDraftChange(html);
      }}
      onBodyBlur={setBody}
      signatureMode={composeSignatureMode(draftId, inReplyTo)}
      attachedFiles={attachedFiles}
      onAttachedFilesChange={setAttachedFiles}
      scheduledTime={scheduledTime}
      onScheduledTimeChange={setScheduledTime}
      onAiGenerate={ai.generateAiDraft}
      onSend={() => void handleSend()}
      isSending={isSending}
    />
  );
}
