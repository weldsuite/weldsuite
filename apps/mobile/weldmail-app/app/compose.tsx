import { styles } from './compose.styles';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  Platform,
  ActionSheetIOS,
  Modal,
  Keyboard,
} from 'react-native';
import MaterialSpinner from '@/components/MaterialSpinner';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { uploadMailAttachments } from '@/utils/upload-attachment';
import { buildQuotedSuffix, mapContactSuggestions, buildSendPayload, buildScheduledPayload, sendThenQueueOnOffline, withPendingInput, draftBodyFields, resolveOptionalRecipients, type ComposePayloadInput, type ContactSuggestion } from '@/utils/compose-helpers';
import { MAX_SCHEDULE_DAYS, combineDateAndTime, formatClock, isWithinScheduleWindow, stepTime } from '@/utils/schedule-time';
import SendTimePickerModal from '@/components/SendTimePickerModal';
import {
  X, ChevronDown, ChevronUp, ChevronLeft, ChevronRight,Clock, Paperclip, SendHorizontal,
  Bold, Italic, Underline, List, ListOrdered,Plus, CalendarClock, Sparkles,
} from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useMail, getAvatarColor } from '@/contexts/MailContext';
import { appApi, appApiClient } from '@/services/app-api';
import { sendFromAccount as sendMailFromAccount, createDraft, isPersonalAccount } from '@/services/mail-tenant';
import { useMailOutbox } from '@/hooks/useMailOutbox';

const buildEditorHtml = (textColor: string) => `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%;background:transparent}#e{font-family:system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.5;color:${textColor};padding:10px 0;min-height:180px;outline:none;-webkit-user-select:text;word-wrap:break-word}#e:empty:before{content:attr(data-placeholder);color:#9CA3AF;pointer-events:none}#e ul,#e ol{padding-left:20px;margin:4px 0}#e a{color:#3B82F6}</style></head><body><div id="e" contenteditable="true" data-placeholder="Compose email"></div><script>var e=document.getElementById('e'),p=window.ReactNativeWebView.postMessage.bind(window.ReactNativeWebView),s=function(){p(JSON.stringify({t:'c',h:e.innerHTML,x:e.innerText}))},f=function(){p(JSON.stringify({t:'f',b:document.queryCommandState('bold'),i:document.queryCommandState('italic'),u:document.queryCommandState('underline'),l:document.queryCommandState('insertUnorderedList'),ol:document.queryCommandState('insertOrderedList')}))};e.addEventListener('input',s);e.addEventListener('focus',function(){p(JSON.stringify({t:'fo'}))});e.addEventListener('blur',function(){p(JSON.stringify({t:'bl'}))});document.addEventListener('selectionchange',f);var h=function(ev){try{var m=JSON.parse(ev.data);if(m.t==='fmt'){document.execCommand(m.c,false,m.v||null);e.focus();f();s()}}catch(x){}};document.addEventListener('message',h);window.addEventListener('message',h)</script></body></html>`;

function QuotedMessage({ mode, from, date, subject, body }: Readonly<{ mode: string; from: string; date: string; subject: string; body: string }>) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <View style={quotedStyles.container}>
      <TouchableOpacity
        style={quotedStyles.dotsButton}
        onPress={() => setExpanded(!expanded)}
        activeOpacity={0.7}
      >
        <View style={quotedStyles.dot} />
        <View style={quotedStyles.dot} />
        <View style={quotedStyles.dot} />
      </TouchableOpacity>
      {expanded && (
        <View style={quotedStyles.content}>
          <Text style={quotedStyles.label}>
            {mode === 'forward' ? '---------- Forwarded message ---------' : '---------- Original message ---------'}
          </Text>
          <Text style={quotedStyles.meta}>
            From: {from}{'\n'}
            Date: {date}{'\n'}
            Subject: {subject}
          </Text>
          <Text style={quotedStyles.body}>{body}</Text>
        </View>
      )}
    </View>
  );
}

const quotedStyles = StyleSheet.create({
  container: { paddingHorizontal: 16, paddingBottom: 16, marginTop: 16 },
  dotsButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, backgroundColor: '#F3F4F6', alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6 },
  dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: '#9CA3AF' },
  content: { marginTop: 12, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: '#D1D5DB' },
  label: { fontSize: 12, color: '#9CA3AF', marginBottom: 8 },
  meta: { fontSize: 13, color: '#6B7280', lineHeight: 20, marginBottom: 8 },
  body: { fontSize: 14, color: '#6B7280', lineHeight: 20 },
});

export type ComposePrefill = {
  mode?: string;
  replyTo?: string;
  replyCc?: string;
  subject?: string;
  quotedFrom?: string;
  quotedDate?: string;
  quotedSubject?: string;
  quotedBody?: string;
  emailAccountId?: string;
  /** SMTP Message-ID being replied to (threading). */
  inReplyTo?: string;
  /** Space-separated References chain for the reply. */
  references?: string;
};

/** `draftIsHtml` is '1' when `draftBody` came from the rich editor (HTML). */
export type ComposeCloseInfo = { draftSaved?: boolean; draftId?: string; draftAccountId?: string; draftTo?: string; draftCc?: string; draftBcc?: string; draftSubject?: string; draftBody?: string; draftIsHtml?: '1' } | undefined;

interface ComposeScreenProps {
  // When rendered as a Modal child, the parent provides these. When rendered
  // as a Stack route, we fall back to expo-router hooks.
  onCloseOverride?: (info?: ComposeCloseInfo) => void;
  prefillOverride?: ComposePrefill;
  /**
   * Lets the overlay host route Android hardware back through this screen's
   * close handler, so unsent content is kept as a draft like the X button does.
   */
  registerCloseHandler?: (handler: (() => void) | null) => void;
}

type RecipientField = 'to' | 'cc' | 'bcc';
type ComposeMode = 'reply' | 'replyAll' | 'forward';
type ComposeAccount = ReturnType<typeof useMail>['accounts'][number];
type ThemeColors = ReturnType<typeof useTheme>['colors'];
type MailOutbox = ReturnType<typeof useMailOutbox>;
type Attachment = { name: string; uri: string; type: string };
type Formats = { b: boolean; i: boolean; u: boolean; l: boolean; ol: boolean };
type SendTimeSheet = null | 'send-later' | 'schedule';
type ContactRows = {
  data: { id: string; email: string; firstName?: string; lastName?: string; fullName?: string; company?: string | null }[];
};

const RECIPIENT_FIELDS: { field: RecipientField; label: string }[] = [
  { field: 'to', label: 'To:' },
  { field: 'cc', label: 'Cc:' },
  { field: 'bcc', label: 'Bcc:' },
];

const PREFILL_MODES = ['reply', 'replyAll', 'forward'];

const HEADER_TITLES = new Map<string, string>([
  ['reply', 'Reply'],
  ['replyAll', 'Reply All'],
  ['forward', 'Forward'],
]);

const ATTACHMENTS_SCHEDULED_SEND_MSG = 'Scheduled emails can’t include attachments yet. Send now, or remove the attachments to schedule.';
const ATTACHMENTS_SCHEDULED_LATER_MSG = 'Scheduled emails can’t include attachments yet. Remove them, or send the email now.';
const PERSONAL_SCHEDULE_SEND_MSG = 'Scheduling isn’t available for personal inboxes yet. Send now, or switch to a workspace address.';
const PERSONAL_SCHEDULE_LATER_MSG = 'Scheduling isn’t available for personal inboxes yet.';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function getHeaderTitle(mode: string | undefined): string {
  return (mode && HEADER_TITLES.get(mode)) || 'New Message';
}

function isPrefillMode(mode: string | undefined): boolean {
  return !!mode && PREFILL_MODES.includes(mode);
}

function splitCommaList(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function removeAt<T>(list: T[], index: number): T[] {
  return list.filter((_, i) => i !== index);
}

/**
 * Mail can only be sent from a personal inbox or one in the active workspace:
 * the request carries the current org's token, so another workspace's
 * account 404s (and an offline-queued send to it is dropped on replay).
 */
function filterSendableAccounts(allAccounts: ComposeAccount[], organizationId: string | null | undefined): ComposeAccount[] {
  return allAccounts.filter(
    (a) => a.tenantKind === 'personal' || !a.clerkOrgId || !organizationId || a.clerkOrgId === organizationId,
  );
}

function pickSendAccount(selected: ComposeAccount | null, accounts: ComposeAccount[]): ComposeAccount | null {
  if (selected && accounts.some((a) => a.id === selected.id)) return selected;
  return accounts.length > 0 ? accounts[0] : null;
}

// Toolbar pill palette. The light values are the ones the group already used
// (colors.card is #FFFFFF and colors.info is #3B82F6 in light), so light mode
// is unchanged; only the previously-missing dark counterparts are new.
function getToolbarPalette(isDark: boolean) {
  return {
    iconColor: isDark ? '#D1D5DB' : '#374151',
    activeBg: { backgroundColor: isDark ? 'rgba(59,130,246,0.20)' : '#EFF6FF' },
  };
}

function buildQuotedProps(mode: ComposeMode | undefined, params: ComposePrefill) {
  if (!mode || !params.quotedBody) return null;
  return {
    mode,
    from: params.quotedFrom || '',
    date: params.quotedDate || '',
    subject: params.quotedSubject || '',
    body: params.quotedBody,
  };
}

function getCalendarDays(calendarMonth: Date): (number | null)[] {
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const days: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) days.push(null);
  for (let i = 1; i <= daysInMonth; i++) days.push(i);
  return days;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isBeforeToday(calendarMonth: Date, day: number): boolean {
  const d = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return d < today;
}

/** The address typed so far when it ends in a `,` / `;` separator, else null. */
function extractCommittedEmail(text: string): string | null {
  if (!text.endsWith(',') && !text.endsWith(';')) return null;
  return text.slice(0, -1).trim() || null;
}

function showAccountPicker(accounts: ComposeAccount[], selectAccount: (account: ComposeAccount) => void) {
  const options = accounts.map((a) => a.emailAddress);
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [...options, 'Cancel'], cancelButtonIndex: options.length },
      (index) => {
        if (index < accounts.length) selectAccount(accounts[index]);
      },
    );
  } else {
    Alert.alert(
      'Send from',
      undefined,
      [
        ...accounts.map((a) => ({ text: a.emailAddress, onPress: () => selectAccount(a) })),
        { text: 'Cancel', style: 'cancel' as const },
      ],
    );
  }
}

function showAttachmentMenu(onPhotos: () => void, onCamera: () => void, onFiles: () => void) {
  if (Platform.OS === 'ios') {
    const handlers = [onPhotos, onCamera, onFiles];
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ['Photo Library', 'Take Photo', 'Choose File', 'Cancel'], cancelButtonIndex: 3, title: 'Add Attachment' },
      (buttonIndex) => handlers[buttonIndex]?.(),
    );
  } else {
    Alert.alert('Add Attachment', undefined, [
      { text: 'Photo Library', onPress: onPhotos },
      { text: 'Take Photo', onPress: onCamera },
      { text: 'Choose File', onPress: onFiles },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }
}

async function pickPhotos(): Promise<Attachment[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: true,
    quality: 0.8,
  });
  if (result.canceled || !result.assets) return [];
  const stamp = Date.now();
  return result.assets.map((asset, i) => ({
    // Unnamed assets (common for camera-roll photos) need distinct names:
    // they're uploaded in parallel and the storage key is derived from
    // the name, so identical names overwrote each other.
    name: asset.fileName || `photo_${stamp}_${i + 1}.jpg`,
    uri: asset.uri,
    type: asset.mimeType || 'image/jpeg',
  }));
}

async function takePhoto(): Promise<Attachment[]> {
  const { status } = await ImagePicker.requestCameraPermissionsAsync();
  if (status !== 'granted') {
    Alert.alert('Permission required', 'Camera permission is needed to take photos.');
    return [];
  }
  const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
  if (result.canceled || !result.assets) return [];
  const asset = result.assets[0];
  return [{
    name: asset.fileName || `photo_${Date.now()}.jpg`,
    uri: asset.uri,
    type: asset.mimeType || 'image/jpeg',
  }];
}

async function pickFiles(): Promise<Attachment[]> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    multiple: true,
  });
  if (result.canceled || !result.assets) return [];
  return result.assets.map((asset) => ({
    name: asset.name,
    uri: asset.uri,
    type: asset.mimeType || 'application/octet-stream',
  }));
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

type SendCheck = { ok: true; account: ComposeAccount } | { ok: false; title: string; message: string };

/** Shared pre-send validation: an account, a recipient, and no attachments where they can't go. */
function checkSendReady(account: ComposeAccount | null, to: string, attachmentsMessage: string | null): SendCheck {
  if (!account) return { ok: false, title: 'Error', message: 'No email account available' };
  if (!to.trim()) return { ok: false, title: 'Error', message: 'Please enter a recipient' };
  if (attachmentsMessage) return { ok: false, title: 'Attachments not supported', message: attachmentsMessage };
  return { ok: true, account };
}

/** Schedules the message; false (after alerting) when the account can't schedule. */
async function scheduleMessage(
  account: ComposeAccount,
  payloadInput: ComposePayloadInput,
  date: Date,
  personalUnavailableMessage: string,
): Promise<boolean> {
  if (isPersonalAccount(account)) {
    Alert.alert('Not available', personalUnavailableMessage);
    return false;
  }
  await appApi.mailScheduled.schedule(
    buildScheduledPayload(payloadInput, account.id, date.toISOString()),
  );
  return true;
}

/** Sends now (or queues offline); false (after alerting) when the account can't send attachments. */
async function sendMessageNow(
  account: ComposeAccount,
  payloadInput: ComposePayloadInput,
  attachments: Attachment[],
  outbox: MailOutbox,
): Promise<boolean> {
  if (isPersonalAccount(account) && attachments.length > 0) {
    Alert.alert(
      'Attachments not supported',
      'Personal inboxes can’t include attachments yet. Remove them, or send from a workspace address.',
    );
    return false;
  }
  const uploadedAttachments =
    attachments.length > 0 ? await uploadMailAttachments(attachments) : [];
  // One idempotency key for this composed message: it's used by the direct
  // send AND by the offline-queue fallback, so the backend dedups if the
  // direct send actually reached the server before the connection dropped.
  const idempotencyKey = `snd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const payload = buildSendPayload(payloadInput, uploadedAttachments, idempotencyKey);
  // Send now, or queue for the reconnect flush if offline. Either outcome
  // closes the composer (a queued send replays dedup-safe via the key);
  // a server reject rethrows to the caller's alert.
  await sendThenQueueOnOffline({
    send: () => sendMailFromAccount(account, payload),
    queue: () => outbox.enqueueSend(account.id, payload),
  });
  return true;
}

interface DraftFields {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  bodyHtml: string;
}

function buildDraftContent(accountId: string, f: DraftFields) {
  return {
    draftAccountId: accountId,
    draftTo: f.to,
    draftCc: f.cc,
    draftBcc: f.bcc,
    draftSubject: f.subject,
    draftBody: f.bodyHtml || f.body,
    ...(f.bodyHtml ? { draftIsHtml: '1' as const } : {}),
  };
}

/** Route fallback (no overlay): best-effort draft save; '' when it fails. */
async function saveDraftBestEffort(account: ComposeAccount, f: DraftFields): Promise<string> {
  try {
    const res = await createDraft({
      accountId: account.id,
      tenantKind: account.tenantKind,
      to: resolveOptionalRecipients([], f.to),
      cc: resolveOptionalRecipients([], f.cc),
      bcc: resolveOptionalRecipients([], f.bcc),
      subject: f.subject || undefined,
      ...draftBodyFields(f.bodyHtml || f.body, !!f.bodyHtml),
    });
    return res.data.id;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useKeyboardOpen() {
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setKeyboardOpen(true),
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboardOpen(false),
    );
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  return keyboardOpen;
}

function useContactSuggestions() {
  const [contactSuggestions, setContactSuggestions] = useState<ContactSuggestion[]>([]);
  const [, setLoadingSuggestions] = useState(false);
  const contactSearchRef = useRef<NodeJS.Timeout | undefined>(undefined);

  // Load recent contacts on mount
  useEffect(() => {
    const loadRecent = async () => {
      try {
        const { data } = await appApiClient.get<ContactRows>('/people?limit=10');
        setContactSuggestions(mapContactSuggestions(data));
      } catch {}
    };
    loadRecent();
  }, []);

  const searchContacts = useCallback((text: string) => {
    if (contactSearchRef.current) clearTimeout(contactSearchRef.current);

    if (text.trim().length === 0) {
      setContactSuggestions([]);
      return;
    }

    contactSearchRef.current = setTimeout(async () => {
      try {
        setLoadingSuggestions(true);
        const { data } = await appApiClient.get<ContactRows>(`/people?search=${encodeURIComponent(text.trim())}&limit=10`);
        setContactSuggestions(mapContactSuggestions(data));
      } catch {} finally {
        setLoadingSuggestions(false);
      }
    }, 200);
  }, []);

  return { contactSuggestions, setContactSuggestions, searchContacts };
}

/** To/Cc/Bcc chips + typed input, the active field, and the contact-suggestion flow. */
function useRecipientFields() {
  const [toRecipients, setToRecipients] = useState<string[]>([]);
  const [toInput, setToInput] = useState('');
  const [ccRecipients, setCcRecipients] = useState<string[]>([]);
  const [ccInput, setCcInput] = useState('');
  const [bccRecipients, setBccRecipients] = useState<string[]>([]);
  const [bccInput, setBccInput] = useState('');
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [activeRecipientField, setActiveRecipientField] = useState<RecipientField | null>(null);
  const activeRecipientFieldRef = useRef<RecipientField | null>(null);
  const { contactSuggestions, setContactSuggestions, searchContacts } = useContactSuggestions();

  const setActiveField = useCallback((field: RecipientField | null) => {
    activeRecipientFieldRef.current = field;
    setActiveRecipientField(field);
  }, []);

  const setters = useMemo(() => ({
    to: { setInput: setToInput, setRecipients: setToRecipients },
    cc: { setInput: setCcInput, setRecipients: setCcRecipients },
    bcc: { setInput: setBccInput, setRecipients: setBccRecipients },
  }), []);

  const recipients = useMemo(() => ({ to: toRecipients, cc: ccRecipients, bcc: bccRecipients }), [toRecipients, ccRecipients, bccRecipients]);
  const inputs = useMemo(() => ({ to: toInput, cc: ccInput, bcc: bccInput }), [toInput, ccInput, bccInput]);
  const activeInput = activeRecipientField ? inputs[activeRecipientField] : '';

  // Generic input change handler for To/Cc/Bcc with contact search
  const handleRecipientInputChange = useCallback((field: RecipientField, text: string) => {
    const { setInput, setRecipients } = setters[field];
    const email = extractCommittedEmail(text);
    if (email) {
      setRecipients(prev => [...prev, email]);
      setInput('');
      setContactSuggestions([]);
      return;
    }

    setInput(text);
    searchContacts(text);
  }, [setters, setContactSuggestions, searchContacts]);

  const handleSelectContact = useCallback((contact: { email: string; name: string }) => {
    const { setInput, setRecipients } = setters[activeRecipientField || 'to'];
    setRecipients(prev => [...prev, contact.email]);
    setInput('');
    setContactSuggestions([]);
    setActiveField(null);
    Keyboard.dismiss();
  }, [setters, activeRecipientField, setActiveField, setContactSuggestions]);

  const handleCreateContact = useCallback(async () => {
    const email = activeInput.trim();
    if (!email) return;
    try { await appApiClient.post('/people', { email }); } catch {}
    handleSelectContact({ email, name: '' });
  }, [activeInput, handleSelectContact]);

  const commitRecipientInput = useCallback((field: RecipientField) => {
    const typed = inputs[field].trim();
    if (!typed) return;
    const { setInput, setRecipients } = setters[field];
    setRecipients(prev => [...prev, typed]);
    setInput('');
    setContactSuggestions([]);
  }, [inputs, setters, setContactSuggestions]);

  const blurRecipientField = useCallback((field: RecipientField) => {
    setTimeout(() => { if (activeRecipientFieldRef.current === field) setActiveField(null); }, 150);
  }, [setActiveField]);

  return {
    recipients, inputs, setters,
    toRecipients, toInput, ccRecipients, ccInput, bccRecipients, bccInput,
    setToRecipients, setCcRecipients,
    showCcBcc, setShowCcBcc,
    activeRecipientField, activeInput, setActiveField,
    contactSuggestions,
    handleRecipientInputChange, handleSelectContact, handleCreateContact,
    commitRecipientInput, blurRecipientField,
  };
}

interface PrefillActions {
  setToRecipients: (recipients: string[]) => void;
  setCcRecipients: (recipients: string[]) => void;
  setShowCcBcc: (show: boolean) => void;
  setSubject: (subject: string) => void;
  selectAccount: (account: ComposeAccount) => void;
}

function applyPrefill(params: ComposePrefill, accounts: ComposeAccount[], actions: PrefillActions) {
  if (params.replyTo) actions.setToRecipients(splitCommaList(params.replyTo));
  if (params.replyCc) {
    actions.setCcRecipients(splitCommaList(params.replyCc));
    actions.setShowCcBcc(true);
  }
  if (params.subject) actions.setSubject(params.subject);
  const account = params.emailAccountId ? accounts.find((a) => a.id === params.emailAccountId) : undefined;
  if (account) actions.selectAccount(account);
}

/** Prefill from route params (reply/forward), once. */
function usePrefill(params: ComposePrefill, accounts: ComposeAccount[], actions: PrefillActions) {
  const prefilled = useRef(false);
  const { setToRecipients, setCcRecipients, setShowCcBcc, setSubject, selectAccount } = actions;

  useEffect(() => {
    if (prefilled.current) return;
    if (!isPrefillMode(params.mode)) return;
    prefilled.current = true;
    applyPrefill(params, accounts, { setToRecipients, setCcRecipients, setShowCcBcc, setSubject, selectAccount });
  }, [params, accounts, selectAccount, setToRecipients, setCcRecipients, setShowCcBcc, setSubject]);
}

function useRichEditor(textColor: string) {
  const [body, setBody] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [bodyFocused, setBodyFocused] = useState(false);
  const [formats, setFormats] = useState<Formats>({ b: false, i: false, u: false, l: false, ol: false });
  const [, setEditorReady] = useState(false);
  const editorRef = useRef<WebView>(null);
  const editorHtml = useRef(buildEditorHtml(textColor));

  const execFormat = useCallback((cmd: string, value?: string) => {
    editorRef.current?.postMessage(JSON.stringify({ t: 'fmt', c: cmd, v: value }));
  }, []);

  const onEditorMessage = useCallback((e: WebViewMessageEvent) => {
    try {
      const m = JSON.parse(e.nativeEvent.data);
      if (m.t === 'c') { setBody(m.x || ''); setBodyHtml(m.h || ''); }
      else if (m.t === 'fo') setBodyFocused(true);
      else if (m.t === 'bl') setBodyFocused(false);
      else if (m.t === 'f') setFormats({ b: !!m.b, i: !!m.i, u: !!m.u, l: !!m.l, ol: !!m.ol });
    } catch {}
  }, []);

  // Collapse the keyboard immediately — blur the WebView editor (which holds
  // its own first responder) AND dismiss any native keyboard from the inputs.
  const dismissKeyboard = useCallback(() => {
    editorRef.current?.injectJavaScript('if(document.activeElement){document.activeElement.blur();}true;');
    Keyboard.dismiss();
  }, []);

  const onLoadEnd = useCallback(() => setEditorReady(true), []);

  return { body, bodyHtml, bodyFocused, formats, editorRef, editorHtml, execFormat, onEditorMessage, dismissKeyboard, onLoadEnd };
}

function useAttachments() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const removeAttachment = (index: number) => {
    setAttachments(prev => removeAt(prev, index));
  };

  const addFrom = async (pick: () => Promise<Attachment[]>, errorLabel: string) => {
    try {
      const added = await pick();
      if (added.length > 0) setAttachments(prev => [...prev, ...added]);
    } catch (error) {
      console.error(errorLabel, error);
    }
  };

  const handleAttachment = () => {
    Keyboard.dismiss();
    setTimeout(() => {
      showAttachmentMenu(
        () => addFrom(pickPhotos, 'Error picking photos:'),
        () => addFrom(takePhoto, 'Error taking photo:'),
        () => addFrom(pickFiles, 'Error picking files:'),
      );
    }, 100);
  };

  return { attachments, removeAttachment, handleAttachment };
}

interface SendActionsInput {
  sendFromAccount: ComposeAccount | null;
  to: string;
  scheduledDate: Date | null;
  attachments: Attachment[];
  buildPayloadInput: () => ComposePayloadInput;
  closeComposer: () => void;
  dismissKeyboard: () => void;
  outbox: MailOutbox;
}

function useSendActions({ sendFromAccount, to, scheduledDate, attachments, buildPayloadInput, closeComposer, dismissKeyboard, outbox }: SendActionsInput) {
  const [sending, setSending] = useState(false);
  // Synchronous guard against double-send: `setSending` is async, so a fast
  // double-tap can re-enter handleSend/sendScheduled before the disabled state
  // re-renders. The ref flips immediately.
  const sendingRef = useRef(false);

  // Runs `work` behind the double-send guard; `work` resolves true when the
  // composer can close (sent, queued or scheduled).
  const runSend = useCallback(async (work: () => Promise<boolean>, failureMessage: string, logLabel: string) => {
    dismissKeyboard();
    sendingRef.current = true;
    try {
      setSending(true);
      if (await work()) closeComposer();
    } catch (error) {
      console.error(logLabel, error);
      Alert.alert('Error', failureMessage);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [dismissKeyboard, closeComposer]);

  const handleSend = useCallback(async () => {
    if (sendingRef.current) return;
    // Scheduled emails can't carry attachments yet — tell the user instead of
    // silently dropping the files they attached.
    const attachmentsMessage = scheduledDate && attachments.length > 0 ? ATTACHMENTS_SCHEDULED_SEND_MSG : null;
    const check = checkSendReady(sendFromAccount, to, attachmentsMessage);
    if (!check.ok) {
      Alert.alert(check.title, check.message);
      return;
    }
    const { account } = check;
    const payloadInput = buildPayloadInput();
    await runSend(
      () => (scheduledDate
        ? scheduleMessage(account, payloadInput, scheduledDate, PERSONAL_SCHEDULE_SEND_MSG)
        : sendMessageNow(account, payloadInput, attachments, outbox)),
      scheduledDate ? 'Failed to schedule email' : 'Failed to send email',
      'Send error:',
    );
  }, [sendFromAccount, to, scheduledDate, attachments, buildPayloadInput, runSend, outbox]);

  // Schedule the email for a given time AND send it (one-tap "Send later").
  const sendScheduled = useCallback(async (date: Date) => {
    if (sendingRef.current) return;
    const check = checkSendReady(sendFromAccount, to, attachments.length > 0 ? ATTACHMENTS_SCHEDULED_LATER_MSG : null);
    if (!check.ok) {
      Alert.alert(check.title, check.message);
      return;
    }
    const { account } = check;
    await runSend(
      () => scheduleMessage(account, buildPayloadInput(), date, PERSONAL_SCHEDULE_LATER_MSG),
      'Failed to schedule email',
      'Schedule error:',
    );
  }, [sendFromAccount, to, buildPayloadInput, attachments, runSend]);

  return { sending, handleSend, sendScheduled };
}

interface SendTimePickerInput {
  hasAccount: boolean;
  hasRecipient: boolean;
  sendScheduled: (date: Date) => Promise<void>;
  setScheduledDate: (date: Date | null) => void;
}

/** "Send later" / "Schedule send" flow: options sheet + custom date/time picker. */
function useSendTimePicker({ hasAccount, hasRecipient, sendScheduled, setScheduledDate }: SendTimePickerInput) {
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  // Which entry point opened the options sheet — they differ only in title and
  // in what a picked date does (send now vs. just stage the scheduled date).
  const [sendTimeSheet, setSendTimeSheet] = useState<SendTimeSheet>(null);
  // When the custom date picker is opened from "Send later", remember to send
  // (not just set the scheduled date) once the user confirms a time.
  const sendAfterPickRef = useRef(false);

  const applyPickedSendTime = (date: Date) => {
    setSendTimeSheet(null);
    if (sendTimeSheet === 'send-later') sendScheduled(date);
    else setScheduledDate(date);
  };

  // Shared validation for the two send-time entry points.
  const requireSendReady = (): boolean => {
    if (!hasAccount) {
      Alert.alert('Error', 'No email account available');
      return false;
    }
    if (!hasRecipient) {
      Alert.alert('Error', 'Please enter a recipient');
      return false;
    }
    return true;
  };

  const openCustomDatePicker = (sendAfter: boolean) => {
    if (sendAfter) sendAfterPickRef.current = true;
    setSendTimeSheet(null);
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
    setCalendarMonth(tomorrow); setSelectedDate(tomorrow); setShowCustomPicker(true);
  };

  const handleSendLater = () => {
    if (!requireSendReady()) return;
    setSendTimeSheet('send-later');
  };

  const handleSchedule = () => {
    if (!requireSendReady()) return;
    setSendTimeSheet('schedule');
  };

  // Recomputed on every selection change so Done reflects the same window
  // app-api enforces. `showCustomPicker` is a dep so reopening the sheet
  // re-evaluates against a fresh "now" rather than a stale render's.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- showCustomPicker is a deliberate re-evaluation trigger
  const isSelectedTimeValid = useMemo(() => isWithinScheduleWindow(selectedDate, new Date()), [selectedDate, showCustomPicker]);

  const confirmCustomDateTime = () => {
    if (!isSelectedTimeValid) return;
    const picked = new Date(selectedDate);
    picked.setSeconds(0, 0);
    setShowCustomPicker(false);
    if (sendAfterPickRef.current) {
      sendAfterPickRef.current = false;
      sendScheduled(picked);
    } else {
      setScheduledDate(picked);
    }
  };

  const shiftMonth = (delta: number) => {
    const d = new Date(calendarMonth);
    d.setMonth(d.getMonth() + delta);
    setCalendarMonth(d);
  };

  return {
    sendTimeSheet, setSendTimeSheet, showCustomPicker, setShowCustomPicker,
    calendarMonth, selectedDate, setSelectedDate, isSelectedTimeValid,
    applyPickedSendTime, openCustomDatePicker, handleSendLater, handleSchedule,
    confirmCustomDateTime,
    prevMonth: () => shiftMonth(-1),
    nextMonth: () => shiftMonth(1),
  };
}

// ---------------------------------------------------------------------------
// Presentational components
// ---------------------------------------------------------------------------

function ComposeHeader({ title, sendFromAccount, canPickAccount, colors, sending, hasContent, onClose, onSend, onFromPress }: Readonly<{
  title: string;
  sendFromAccount: ComposeAccount | null;
  canPickAccount: boolean;
  colors: ThemeColors;
  sending: boolean;
  hasContent: boolean;
  onClose: () => void;
  onSend: () => void;
  onFromPress: () => void;
}>) {
  const accountInitial = (sendFromAccount?.displayName || sendFromAccount?.emailAddress || '?').charAt(0).toUpperCase();
  const accountAvatarColor = sendFromAccount ? getAvatarColor(sendFromAccount.displayName || sendFromAccount.emailAddress) : '#6B7280';

  return (
    <View style={[styles.header, { borderBottomColor: colors.border || colors.divider }]}>
      <TouchableOpacity onPress={onClose} style={styles.closeButton} disabled={sending} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <X size={22} color={colors.text} strokeWidth={2} />
      </TouchableOpacity>

      {sendFromAccount && (
        <View style={[styles.headerAvatar, { backgroundColor: accountAvatarColor }]}>
          <Text style={styles.headerAvatarText}>{accountInitial}</Text>
        </View>
      )}

      <TouchableOpacity
        onPress={canPickAccount ? onFromPress : undefined}
        activeOpacity={canPickAccount ? 0.7 : 1}
        style={styles.headerTextBlock}
      >
        <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {title}
        </Text>
        {sendFromAccount && (
          <View style={styles.headerFromRow}>
            <Text style={[styles.headerFromEmail, { color: colors.muted }]} numberOfLines={1}>
              {sendFromAccount.emailAddress}
            </Text>
            {canPickAccount && (
              <ChevronDown size={12} color={colors.muted} strokeWidth={2} />
            )}
          </View>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        onPress={onSend}
        style={styles.sendArrow}
        disabled={sending}
        activeOpacity={0.6}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        {sending ? (
          <MaterialSpinner size={18} strokeWidth={2.4} color={colors.text} spinning />
        ) : (
          <SendHorizontal size={22} color={hasContent ? '#2563EB' : colors.muted} strokeWidth={2} />
        )}
      </TouchableOpacity>
    </View>
  );
}

function RecipientRow({ field, label, recipients, input, setRecipients, colors, showCcBcc, onToggleCcBcc, onInputChange, onFocusField, onBlurField, onCommitInput }: Readonly<{
  field: RecipientField;
  label: string;
  recipients: string[];
  input: string;
  setRecipients: React.Dispatch<React.SetStateAction<string[]>>;
  colors: ThemeColors;
  showCcBcc: boolean;
  onToggleCcBcc: () => void;
  onInputChange: (field: RecipientField, text: string) => void;
  onFocusField: (field: RecipientField) => void;
  onBlurField: (field: RecipientField) => void;
  onCommitInput: (field: RecipientField) => void;
}>) {
  const ToggleChevron = showCcBcc ? ChevronUp : ChevronDown;
  return (
    <View style={[styles.toChipRow, { borderBottomColor: colors.border || colors.divider }]}>
      <Text style={[styles.outlookFieldLabel, { color: colors.muted, marginTop: 14 }]}>{label}</Text>
      <View style={styles.toChipContainer}>
        {recipients.map((email, index) => (
          <TouchableOpacity
            key={`${field}-${email}-${index}`}
            onPress={() => setRecipients(prev => removeAt(prev, index))}
            activeOpacity={0.7}
            style={styles.recipientPill}
          >
            <Text style={styles.recipientPillText} numberOfLines={1}>{email}</Text>
            <View style={styles.recipientPillX}>
              <X size={11} color="#1E40AF" strokeWidth={2.5} />
            </View>
          </TouchableOpacity>
        ))}
        <TextInput
          style={[styles.toChipInput, { color: colors.text }]}
          value={input}
          onChangeText={(text) => onInputChange(field, text)}
          placeholder=""
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus={field === 'to'}
          onFocus={() => onFocusField(field)}
          onBlur={() => onBlurField(field)}
          onKeyPress={({ nativeEvent }) => {
            if (nativeEvent.key === 'Backspace' && input === '' && recipients.length > 0) {
              setRecipients(prev => prev.slice(0, -1));
            }
          }}
          onSubmitEditing={() => onCommitInput(field)}
        />
      </View>
      {field === 'to' && (
        <TouchableOpacity onPress={onToggleCcBcc} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={{ marginTop: 16, paddingLeft: 8 }}>
          <ToggleChevron size={18} color={colors.muted} strokeWidth={2} />
        </TouchableOpacity>
      )}
    </View>
  );
}

function SuggestionItem({ contact, colors, onSelect }: Readonly<{
  contact: ContactSuggestion;
  colors: ThemeColors;
  onSelect: (contact: { email: string; name: string }) => void;
}>) {
  return (
    <TouchableOpacity
      style={styles.suggestionItem}
      onPress={() => onSelect(contact)}
      activeOpacity={0.6}
    >
      <View style={[styles.suggestionAvatar, { backgroundColor: getAvatarColor(contact.name || contact.email) }]}>
        <Text style={styles.suggestionAvatarText}>
          {(contact.name || contact.email).charAt(0).toUpperCase()}
        </Text>
      </View>
      <View style={styles.suggestionInfo}>
        {contact.name ? (
          <>
            <Text style={[styles.suggestionName, { color: colors.text }]} numberOfLines={1}>
              {contact.name}
            </Text>
            <Text style={[styles.suggestionEmail, { color: colors.muted }]} numberOfLines={1}>
              {contact.email}
            </Text>
          </>
        ) : (
          <Text style={[styles.suggestionName, { color: colors.text }]} numberOfLines={1}>
            {contact.email}
          </Text>
        )}
      </View>
      {contact.company && (
        <Text style={[styles.suggestionCompany, { color: colors.muted }]} numberOfLines={1}>
          {contact.company}
        </Text>
      )}
    </TouchableOpacity>
  );
}

function SuggestionsList({ suggestions, activeInput, colors, onSelect, onCreate }: Readonly<{
  suggestions: ContactSuggestion[];
  activeInput: string;
  colors: ThemeColors;
  onSelect: (contact: { email: string; name: string }) => void;
  onCreate: () => void;
}>) {
  const typed = activeInput.trim();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, minHeight: 500 }}>
      {suggestions.map((contact) => (
        <SuggestionItem key={contact.id} contact={contact} colors={colors} onSelect={onSelect} />
      ))}
      <TouchableOpacity
        style={styles.createContactItem}
        onPress={onCreate}
        activeOpacity={0.6}
      >
        <View style={[styles.createContactIcon, { backgroundColor: '#F3F4F6' }]}>
          <Plus size={16} color="#9CA3AF" strokeWidth={3} />
        </View>
        <Text style={[styles.createContactText, { color: '#3B82F6' }]}>
          {typed ? `Add "${typed}"` : 'Type an email address'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

function AttachmentChips({ attachments, colors, onRemove }: Readonly<{
  attachments: Attachment[];
  colors: ThemeColors;
  onRemove: (index: number) => void;
}>) {
  return (
    <View style={styles.attachmentsList}>
      {attachments.map((attachment, index) => (
        <View key={index} style={[styles.attachmentChip, { backgroundColor: colors.card, borderColor: colors.border || colors.divider }]}>
          <Paperclip size={14} color={colors.muted} strokeWidth={2} />
          <Text style={[styles.attachmentName, { color: colors.text }]} numberOfLines={1}>
            {attachment.name}
          </Text>
          <TouchableOpacity onPress={() => onRemove(index)}>
            <X size={14} color={colors.muted} strokeWidth={2} />
          </TouchableOpacity>
        </View>
      ))}
    </View>
  );
}

/** Subject, attachments and body — hidden while contact suggestions are showing. */
function ComposeBody({ subject, onChangeSubject, attachments, onRemoveAttachment, editor, quoted, colors }: Readonly<{
  subject: string;
  onChangeSubject: (subject: string) => void;
  attachments: Attachment[];
  onRemoveAttachment: (index: number) => void;
  editor: ReturnType<typeof useRichEditor>;
  quoted: ReturnType<typeof buildQuotedProps>;
  colors: ThemeColors;
}>) {
  return (
    <>
      <View style={[styles.fieldRow, { borderBottomColor: colors.border || colors.divider }]}>
        <View style={{ flex: 1, justifyContent: 'center' }}>
          {!subject && (
            <Text style={[styles.subjectPlaceholder, { color: colors.muted }]} pointerEvents="none">
              Subject:
            </Text>
          )}
          <TextInput
            style={[styles.subjectInput, { color: colors.text }]}
            value={subject}
            onChangeText={onChangeSubject}
            placeholder=""
          />
        </View>
      </View>

      {attachments.length > 0 && (
        <AttachmentChips attachments={attachments} colors={colors} onRemove={onRemoveAttachment} />
      )}

      <View style={styles.bodySection}>
        <WebView
          ref={editor.editorRef}
          source={{ html: editor.editorHtml.current }}
          style={styles.editorWebView}
          scrollEnabled={false}
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView={true}
          originWhitelist={['*']}
          onMessage={editor.onEditorMessage}
          onLoadEnd={editor.onLoadEnd}
        />
      </View>

      {quoted && <QuotedMessage {...quoted} />}
    </>
  );
}

function FormatButton({ active, Icon, strokeWidth, onPress, colors, iconColor, activeBg }: Readonly<{
  active: boolean;
  Icon: typeof Bold;
  strokeWidth: number;
  onPress: () => void;
  colors: ThemeColors;
  iconColor: string;
  activeBg: { backgroundColor: string };
}>) {
  return (
    <TouchableOpacity style={[styles.toolbarButton, active && activeBg]} onPress={onPress}>
      <Icon size={16} color={active ? colors.info : iconColor} strokeWidth={strokeWidth} />
    </TouchableOpacity>
  );
}

function FormattingToolbar({ formats, execFormat, colors, iconColor, activeBg }: Readonly<{
  formats: Formats;
  execFormat: (cmd: string) => void;
  colors: ThemeColors;
  iconColor: string;
  activeBg: { backgroundColor: string };
}>) {
  const shared = { colors, iconColor, activeBg };
  return (
    <>
      <FormatButton active={formats.b} Icon={Bold} strokeWidth={2.5} onPress={() => execFormat('bold')} {...shared} />
      <FormatButton active={formats.i} Icon={Italic} strokeWidth={2} onPress={() => execFormat('italic')} {...shared} />
      <FormatButton active={formats.u} Icon={Underline} strokeWidth={2} onPress={() => execFormat('underline')} {...shared} />
      <View style={[styles.toolbarDivider, { backgroundColor: colors.border }]} />
      <FormatButton active={formats.l} Icon={List} strokeWidth={2} onPress={() => execFormat('insertUnorderedList')} {...shared} />
      <FormatButton active={formats.ol} Icon={ListOrdered} strokeWidth={2} onPress={() => execFormat('insertOrderedList')} {...shared} />
    </>
  );
}

function ActionsToolbar({ scheduledDate, sending, colors, iconColor, activeBg, onAttach, onSchedule, onClearSchedule, onSendLater, onAiAssist }: Readonly<{
  scheduledDate: Date | null;
  sending: boolean;
  colors: ThemeColors;
  iconColor: string;
  activeBg: { backgroundColor: string };
  onAttach: () => void;
  onSchedule: () => void;
  onClearSchedule: () => void;
  onSendLater: () => void;
  onAiAssist: () => void;
}>) {
  return (
    <>
      <TouchableOpacity style={styles.toolbarButton} onPress={onAttach} disabled={sending}>
        <Paperclip size={16} color={iconColor} strokeWidth={2} />
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.toolbarButton, scheduledDate && styles.scheduledChip, scheduledDate && activeBg]}
        onPress={onSchedule}
        onLongPress={() => scheduledDate && onClearSchedule()}
        disabled={sending}
      >
        <Clock size={16} color={scheduledDate ? colors.info : iconColor} strokeWidth={2} />
        {scheduledDate && (
          <Text style={[styles.scheduledChipText, { color: colors.info }]}>
            {scheduledDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}{' '}
            {formatClock(scheduledDate)}
          </Text>
        )}
      </TouchableOpacity>
      <TouchableOpacity style={styles.toolbarButton} onPress={onSendLater} disabled={sending}>
        <CalendarClock size={16} color={iconColor} strokeWidth={2} />
      </TouchableOpacity>
      <TouchableOpacity style={styles.toolbarButton} onPress={onAiAssist}>
        <Sparkles size={16} color="#8B5CF6" strokeWidth={2} />
      </TouchableOpacity>
    </>
  );
}

function TimeStepper({ unit, value, selectedDate, onChange, colors }: Readonly<{
  unit: 'hour' | 'minute';
  value: number;
  selectedDate: Date;
  onChange: (date: Date) => void;
  colors: ThemeColors;
}>) {
  return (
    <View style={[styles.timeStepper, { backgroundColor: colors.inputBackground, borderColor: colors.border }]}>
      <TouchableOpacity
        onPress={() => onChange(stepTime(selectedDate, unit, 1))}
        style={styles.timeStepperButton}
        accessibilityLabel={`Increase ${unit}`}
      >
        <ChevronUp size={20} color={colors.muted} strokeWidth={2.5} />
      </TouchableOpacity>
      <Text style={[styles.timeStepperValue, { color: colors.text }]}>
        {value.toString().padStart(2, '0')}
      </Text>
      <TouchableOpacity
        onPress={() => onChange(stepTime(selectedDate, unit, -1))}
        style={styles.timeStepperButton}
        accessibilityLabel={`Decrease ${unit}`}
      >
        <ChevronDown size={20} color={colors.muted} strokeWidth={2.5} />
      </TouchableOpacity>
    </View>
  );
}

function CalendarDayCell({ day, calendarMonth, selectedDate, colors, onSelect }: Readonly<{
  day: number;
  calendarMonth: Date;
  selectedDate: Date;
  colors: ThemeColors;
  onSelect: (date: Date) => void;
}>) {
  const cellDate = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day);
  const isSelected = isSameDay(selectedDate, cellDate);
  const isToday = isSameDay(new Date(), cellDate);
  const isPast = isBeforeToday(calendarMonth, day);
  return (
    <TouchableOpacity
      style={styles.calendarDayCell}
      // Keep the time already chosen; picking a day used to reset it to 00:00.
      onPress={() => !isPast && onSelect(combineDateAndTime(cellDate, selectedDate))}
      disabled={isPast}
      activeOpacity={0.6}
    >
      <View style={[
        styles.calendarDayInner,
        isSelected && styles.calendarDaySelected,
      ]}>
        <Text style={[
          styles.calendarDayText,
          { color: isPast ? '#D1D5DB' : colors.text },
          isToday && !isSelected && { color: '#3B82F6', fontWeight: '700' },
          isSelected && { color: '#FFFFFF', fontWeight: '600' },
        ]}>
          {day}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

function CustomDatePickerModal({ visible, colors, calendarMonth, selectedDate, isValid, onClose, onConfirm, onPrevMonth, onNextMonth, onChangeDate }: Readonly<{
  visible: boolean;
  colors: ThemeColors;
  calendarMonth: Date;
  selectedDate: Date;
  isValid: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onChangeDate: (date: Date) => void;
}>) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[{ flex: 1, backgroundColor: colors.background }]}>
        {/* Header */}
        <View style={styles.calendarHeader}>
          <TouchableOpacity onPress={onClose} style={{ padding: 8 }}>
            <X size={22} color={colors.text} strokeWidth={2} />
          </TouchableOpacity>
          <Text style={[styles.calendarHeaderTitle, { color: colors.text }]}>Pick Date & Time</Text>
          <TouchableOpacity
            onPress={onConfirm}
            disabled={!isValid}
            style={{ padding: 8, opacity: isValid ? 1 : 0.4 }}
          >
            <Text style={{ fontSize: 16, fontWeight: '600', color: colors.info }}>Done</Text>
          </TouchableOpacity>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
          {/* Month navigation */}
          <View style={styles.calendarMonthRow}>
            <TouchableOpacity onPress={onPrevMonth} style={{ padding: 8 }}>
              <ChevronLeft size={22} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
            <Text style={[styles.calendarMonthText, { color: colors.text }]}>
              {calendarMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </Text>
            <TouchableOpacity onPress={onNextMonth} style={{ padding: 8 }}>
              <ChevronRight size={22} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
          </View>

          {/* Weekday headers */}
          <View style={styles.calendarWeekRow}>
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
              <Text key={d} style={[styles.calendarWeekDay, { color: colors.muted }]}>{d}</Text>
            ))}
          </View>

          {/* Day grid */}
          <View style={styles.calendarGrid}>
            {getCalendarDays(calendarMonth).map((day, i) => (
              day === null
                ? <View key={`empty-${i}`} style={styles.calendarDayCell} />
                : <CalendarDayCell key={`day-${day}`} day={day} calendarMonth={calendarMonth} selectedDate={selectedDate} colors={colors} onSelect={onChangeDate} />
            ))}
          </View>

          {/* Time — custom themed stepper (replaces the native spinner, which
              rendered the stock platform clock and ignored the app theme). */}
          <View style={{ marginTop: 32 }}>
            <Text style={[styles.calendarTimeLabel, { color: colors.muted, paddingHorizontal: 24 }]}>Time</Text>
            <View style={styles.timeStepperRow}>
              <TimeStepper unit="hour" value={selectedDate.getHours()} selectedDate={selectedDate} onChange={onChangeDate} colors={colors} />

              <Text style={[styles.timeStepperColon, { color: colors.text }]}>:</Text>

              <TimeStepper unit="minute" value={selectedDate.getMinutes()} selectedDate={selectedDate} onChange={onChangeDate} colors={colors} />
            </View>
          </View>

          {/* Selected summary */}
          <View style={{ paddingHorizontal: 24, marginTop: 8 }}>
            <Text style={[styles.calendarSummary, { color: colors.text }]}>
              {selectedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              {' at '}
              {formatClock(selectedDate)}
            </Text>
            {/* app-api rejects past times and anything over MAX_SCHEDULE_DAYS
                out; say so here instead of letting the send 400. */}
            {!isValid && (
              <Text style={[styles.calendarSummaryError, { color: colors.destructive }]}>
                {selectedDate <= new Date()
                  ? 'Pick a time in the future'
                  : `Emails can be scheduled up to ${MAX_SCHEDULE_DAYS} days ahead`}
              </Text>
            )}
          </View>
        </ScrollView>

      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function ComposeScreen({ onCloseOverride, prefillOverride, registerCloseHandler }: ComposeScreenProps = {}) {
  const { colors, theme } = useTheme();
  const { iconColor: toolbarIconColor, activeBg: toolbarActiveBg } = getToolbarPalette(theme === 'dark');
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { accounts: allAccounts, selectedAccount, selectAccount } = useMail();
  const { organizationId } = useClerkAuth();
  const accounts = useMemo(() => filterSendableAccounts(allAccounts, organizationId), [allAccounts, organizationId]);
  const outbox = useMailOutbox();
  const toast = useToast();
  const routeParams = useLocalSearchParams<ComposePrefill>();
  const params = prefillOverride ?? routeParams;
  const composeMode = params.mode as ComposeMode | undefined;

  const fields = useRecipientFields();
  const { toRecipients, toInput, ccRecipients, ccInput, bccRecipients, bccInput, activeRecipientField, activeInput } = fields;
  const [subject, setSubject] = useState('');
  const editor = useRichEditor(colors.text);
  const { body, bodyHtml, dismissKeyboard } = editor;
  const { attachments, removeAttachment, handleAttachment } = useAttachments();
  const keyboardOpen = useKeyboardOpen();
  const [scheduledDate, setScheduledDate] = useState<Date | null>(null);

  usePrefill(params, accounts, {
    setToRecipients: fields.setToRecipients,
    setCcRecipients: fields.setCcRecipients,
    setShowCcBcc: fields.setShowCcBcc,
    setSubject,
    selectAccount,
  });

  const sendFromAccount = pickSendAccount(selectedAccount, accounts);
  // Chips plus anything typed but not yet committed as a chip, so an address
  // typed straight before tapping Send (or closing) isn't silently dropped.
  const allTo = useMemo(() => withPendingInput(toRecipients, toInput), [toRecipients, toInput]);
  const allCc = useMemo(() => withPendingInput(ccRecipients, ccInput), [ccRecipients, ccInput]);
  const allBcc = useMemo(() => withPendingInput(bccRecipients, bccInput), [bccRecipients, bccInput]);
  const to = allTo.join(', ');
  const cc = allCc.join(', ');
  const bcc = allBcc.join(', ');

  const buildPayloadInput = useCallback((): ComposePayloadInput => ({
    toRecipients: allTo,
    to,
    ccRecipients: allCc,
    cc,
    bccRecipients: allBcc,
    bcc,
    subject,
    body,
    bodyHtml,
    quotedSuffix: buildQuotedSuffix(composeMode, params),
    inReplyTo: params.inReplyTo || undefined,
    references: params.references ? params.references.split(/\s+/).filter(Boolean) : undefined,
  }), [allTo, to, allCc, cc, allBcc, bcc, subject, body, bodyHtml, composeMode, params]);
  const hasContent = toRecipients.length > 0 || toInput.trim() || subject.trim() || body.trim();
  const showSuggestions = activeRecipientField !== null && activeInput.trim().length > 0;

  const handleFromPress = useCallback(() => {
    if (accounts.length <= 1) return;
    showAccountPicker(accounts, selectAccount);
  }, [accounts, selectAccount]);

  const closeComposer = useCallback(() => {
    if (onCloseOverride) onCloseOverride(); else router.back();
  }, [onCloseOverride, router]);

  const { sending, handleSend, sendScheduled } = useSendActions({
    sendFromAccount, to, scheduledDate, attachments, buildPayloadInput,
    closeComposer, dismissKeyboard, outbox,
  });

  const sendTime = useSendTimePicker({
    hasAccount: !!sendFromAccount,
    hasRecipient: toRecipients.length > 0 || !!toInput.trim(),
    sendScheduled,
    setScheduledDate,
  });

  const handleClose = useCallback(async () => {
    // Drop the keyboard up front so it animates away with the sheet, not after.
    dismissKeyboard();

    if (!(hasContent && sendFromAccount)) {
      closeComposer();
      return;
    }

    const draftFields = { to, cc, bcc, subject, body, bodyHtml };
    const draftContent = buildDraftContent(sendFromAccount.id, draftFields);

    if (onCloseOverride) {
      // Close instantly and let the overlay host persist the draft in the
      // background — so the sheet + keyboard don't wait on the network.
      onCloseOverride({ draftSaved: true, ...draftContent });
      return;
    }

    // Route fallback (no overlay): save, then navigate back to the inbox.
    const draftId = await saveDraftBestEffort(sendFromAccount, draftFields);
    router.replace({
      pathname: '/',
      params: { draftSaved: '1', draftId, ...draftContent },
    } as any);
  }, [hasContent, sendFromAccount, to, cc, bcc, subject, body, bodyHtml, router, onCloseOverride, closeComposer, dismissKeyboard]);

  useEffect(() => {
    if (!registerCloseHandler) return;
    registerCloseHandler(() => { handleClose(); });
    return () => registerCloseHandler(null);
  }, [registerCloseHandler, handleClose]);

  // AI assist has been removed along with the AI backend.
  const handleAiAssist = () => {
    toast.info('AI is currently unavailable');
  };

  const suggestionsElement = showSuggestions ? (
    <SuggestionsList
      suggestions={fields.contactSuggestions}
      activeInput={activeInput}
      colors={colors}
      onSelect={fields.handleSelectContact}
      onCreate={fields.handleCreateContact}
    />
  ) : null;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Outlook header: [X] | [Avatar] [Title \n from-email ▽] | [Send arrow] */}
      <ComposeHeader
        title={getHeaderTitle(composeMode)}
        sendFromAccount={sendFromAccount}
        canPickAccount={accounts.length > 1}
        colors={colors}
        sending={sending}
        hasContent={!!hasContent}
        onClose={handleClose}
        onSend={handleSend}
        onFromPress={handleFromPress}
      />

      {/* Single ScrollView — all fields + inline suggestions */}
      <ScrollView
        style={styles.form}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {/* To / Cc / Bcc, each followed by the inline suggestions when active */}
        {RECIPIENT_FIELDS.map(({ field, label }) => (
          <React.Fragment key={field}>
            {(field === 'to' || fields.showCcBcc) && (
              <RecipientRow
                field={field}
                label={label}
                recipients={fields.recipients[field]}
                input={fields.inputs[field]}
                setRecipients={fields.setters[field].setRecipients}
                colors={colors}
                showCcBcc={fields.showCcBcc}
                onToggleCcBcc={() => fields.setShowCcBcc(!fields.showCcBcc)}
                onInputChange={fields.handleRecipientInputChange}
                onFocusField={fields.setActiveField}
                onBlurField={fields.blurRecipientField}
                onCommitInput={fields.commitRecipientInput}
              />
            )}
            {activeRecipientField === field && suggestionsElement}
          </React.Fragment>
        ))}

        {/* Subject, Attachments, Body — hidden when suggestions are showing */}
        {!showSuggestions && (
          <ComposeBody
            subject={subject}
            onChangeSubject={setSubject}
            attachments={attachments}
            onRemoveAttachment={removeAttachment}
            editor={editor}
            quoted={buildQuotedProps(composeMode, params)}
            colors={colors}
          />
        )}
      </ScrollView>

      {/* Toolbar — sticks above keyboard via KeyboardStickyView */}
      <KeyboardStickyView offset={{ closed: 0, opened: 0 }}>
        <View style={[styles.toolbarBar, { paddingBottom: 8 + (keyboardOpen ? 0 : insets.bottom), backgroundColor: colors.background }]}>
          <View style={[styles.toolbarPill, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {editor.bodyFocused ? (
              <FormattingToolbar
                formats={editor.formats}
                execFormat={editor.execFormat}
                colors={colors}
                iconColor={toolbarIconColor}
                activeBg={toolbarActiveBg}
              />
            ) : (
              <ActionsToolbar
                scheduledDate={scheduledDate}
                sending={sending}
                colors={colors}
                iconColor={toolbarIconColor}
                activeBg={toolbarActiveBg}
                onAttach={handleAttachment}
                onSchedule={sendTime.handleSchedule}
                onClearSchedule={() => setScheduledDate(null)}
                onSendLater={sendTime.handleSendLater}
                onAiAssist={handleAiAssist}
              />
            )}
          </View>
        </View>
      </KeyboardStickyView>

      {/* Send-time options — themed sheet, replaces ActionSheetIOS / Alert.alert */}
      <SendTimePickerModal
        visible={sendTime.sendTimeSheet !== null}
        title={sendTime.sendTimeSheet === 'send-later' ? 'Send Later' : 'Schedule Send'}
        onClose={() => sendTime.setSendTimeSheet(null)}
        onSelect={sendTime.applyPickedSendTime}
        onCustom={() => sendTime.openCustomDatePicker(sendTime.sendTimeSheet === 'send-later')}
      />

      {/* Custom Date/Time Picker Modal */}
      <CustomDatePickerModal
        visible={sendTime.showCustomPicker}
        colors={colors}
        calendarMonth={sendTime.calendarMonth}
        selectedDate={sendTime.selectedDate}
        isValid={sendTime.isSelectedTimeValid}
        onClose={() => sendTime.setShowCustomPicker(false)}
        onConfirm={sendTime.confirmCustomDateTime}
        onPrevMonth={sendTime.prevMonth}
        onNextMonth={sendTime.nextMonth}
        onChangeDate={sendTime.setSelectedDate}
      />
    </View>
  );
}
