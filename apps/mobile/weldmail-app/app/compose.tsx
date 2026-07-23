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
  FlatList,
} from 'react-native';
import MaterialSpinner from '@/components/MaterialSpinner';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { WebView } from 'react-native-webview';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { uploadMailAttachments } from '@/utils/upload-attachment';
import { buildQuotedSuffix, resolveRecipients, resolveOptionalRecipients, mapContactSuggestions, buildSendPayload, buildScheduledPayload, sendThenQueueOnOffline } from '@/utils/compose-helpers';
import { MAX_SCHEDULE_DAYS, formatClock, isWithinScheduleWindow, stepTime } from '@/utils/schedule-time';
import SendTimePickerModal from '@/components/SendTimePickerModal';
import {
  X, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Send, Clock, Paperclip, SendHorizontal,
  Bold, Italic, Underline, List, ListOrdered, Link, Plus, CalendarClock, Sparkles,
} from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { useMail, getAvatarColor } from '@/contexts/MailContext';
import appApi, { appApiClient } from '@/services/app-api';
import { useMailOutbox } from '@/hooks/useMailOutbox';

const buildEditorHtml = (textColor: string) => `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%;background:transparent}#e{font-family:system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.5;color:${textColor};padding:10px 0;min-height:180px;outline:none;-webkit-user-select:text;word-wrap:break-word}#e:empty:before{content:attr(data-placeholder);color:#9CA3AF;pointer-events:none}#e ul,#e ol{padding-left:20px;margin:4px 0}#e a{color:#3B82F6}</style></head><body><div id="e" contenteditable="true" data-placeholder="Compose email"></div><script>var e=document.getElementById('e'),p=window.ReactNativeWebView.postMessage.bind(window.ReactNativeWebView),s=function(){p(JSON.stringify({t:'c',h:e.innerHTML,x:e.innerText}))},f=function(){p(JSON.stringify({t:'f',b:document.queryCommandState('bold'),i:document.queryCommandState('italic'),u:document.queryCommandState('underline'),l:document.queryCommandState('insertUnorderedList'),ol:document.queryCommandState('insertOrderedList')}))};e.addEventListener('input',s);e.addEventListener('focus',function(){p(JSON.stringify({t:'fo'}))});e.addEventListener('blur',function(){p(JSON.stringify({t:'bl'}))});document.addEventListener('selectionchange',f);var h=function(ev){try{var m=JSON.parse(ev.data);if(m.t==='fmt'){document.execCommand(m.c,false,m.v||null);e.focus();f();s()}}catch(x){}};document.addEventListener('message',h);window.addEventListener('message',h)</script></body></html>`;

function QuotedMessage({ mode, from, date, subject, body }: { mode: string; from: string; date: string; subject: string; body: string }) {
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
};

export type ComposeCloseInfo = { draftSaved?: boolean; draftId?: string; draftAccountId?: string; draftTo?: string; draftCc?: string; draftBcc?: string; draftSubject?: string; draftBody?: string } | undefined;

interface ComposeScreenProps {
  // When rendered as a Modal child, the parent provides these. When rendered
  // as a Stack route, we fall back to expo-router hooks.
  onCloseOverride?: (info?: ComposeCloseInfo) => void;
  prefillOverride?: ComposePrefill;
}

export default function ComposeScreen({ onCloseOverride, prefillOverride }: ComposeScreenProps = {}) {
  const { colors, theme } = useTheme();
  const isDark = theme === 'dark';
  // Toolbar pill palette. The light values are the ones the group already used
  // (colors.card is #FFFFFF and colors.info is #3B82F6 in light), so light mode
  // is unchanged; only the previously-missing dark counterparts are new.
  const toolbarIconColor = isDark ? '#D1D5DB' : '#374151';
  const toolbarActiveBg = { backgroundColor: isDark ? 'rgba(59,130,246,0.20)' : '#EFF6FF' };
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { accounts, selectedAccount, selectAccount } = useMail();
  const outbox = useMailOutbox();
  const toast = useToast();
  const routeParams = useLocalSearchParams<ComposePrefill>();
  const params = prefillOverride ?? routeParams;

  const [toRecipients, setToRecipients] = useState<string[]>([]);
  const [toInput, setToInput] = useState('');
  const [ccRecipients, setCcRecipients] = useState<string[]>([]);
  const [ccInput, setCcInput] = useState('');
  const [bccRecipients, setBccRecipients] = useState<string[]>([]);
  const [bccInput, setBccInput] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [sending, setSending] = useState(false);
  // Synchronous guard against double-send: `setSending` is async, so a fast
  // double-tap can re-enter handleSend/sendScheduled before the disabled state
  // re-renders. The ref flips immediately.
  const sendingRef = useRef(false);
  const [scheduledDate, setScheduledDate] = useState<Date | null>(null);
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [bodyFocused, setBodyFocused] = useState(false);
  const [attachments, setAttachments] = useState<Array<{ name: string; uri: string; type: string }>>([]);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const [bodyHtml, setBodyHtml] = useState('');
  const [formats, setFormats] = useState({ b: false, i: false, u: false, l: false, ol: false });
  const editorRef = useRef<WebView>(null);
  const editorHtml = useRef(buildEditorHtml(colors.text));
  const [activeRecipientField, setActiveRecipientField] = useState<'to' | 'cc' | 'bcc' | null>(null);
  const activeRecipientFieldRef = useRef<'to' | 'cc' | 'bcc' | null>(null);
  const setActiveField = useCallback((field: 'to' | 'cc' | 'bcc' | null) => {
    activeRecipientFieldRef.current = field;
    setActiveRecipientField(field);
  }, []);
  const [contactSuggestions, setContactSuggestions] = useState<Array<{ id: string; email: string; name: string; company?: string | null }>>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const contactSearchRef = useRef<NodeJS.Timeout>();

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

  // Prefill from route params (reply/forward)
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current) return;
    if (params.mode && (params.mode === 'reply' || params.mode === 'replyAll' || params.mode === 'forward')) {
      prefilled.current = true;
      if (params.replyTo) setToRecipients(params.replyTo.split(',').map(s => s.trim()).filter(Boolean));
      if (params.replyCc) {
        setCcRecipients(params.replyCc.split(',').map(s => s.trim()).filter(Boolean));
        setShowCcBcc(true);
      }
      if (params.subject) setSubject(params.subject);
      if (params.emailAccountId) {
        const account = accounts.find(a => a.id === params.emailAccountId);
        if (account) selectAccount(account);
      }
    }
  }, [params, accounts, selectAccount]);

  const composeMode = params.mode as 'reply' | 'replyAll' | 'forward' | undefined;

  // Load recent contacts on mount
  useEffect(() => {
    const loadRecent = async () => {
      try {
        const { data } = await appApiClient.get<{ data: Array<{ id: string; email: string; firstName?: string; lastName?: string; fullName?: string; company?: string | null }> }>('/people?limit=10');
        setContactSuggestions(mapContactSuggestions(data));
      } catch {}
    };
    loadRecent();
  }, []);

  // Generic input change handler for To/Cc/Bcc with contact search
  const handleRecipientInputChange = useCallback((field: 'to' | 'cc' | 'bcc', text: string) => {
    const setInput = field === 'to' ? setToInput : field === 'cc' ? setCcInput : setBccInput;
    const setRecipients = field === 'to' ? setToRecipients : field === 'cc' ? setCcRecipients : setBccRecipients;

    if (text.endsWith(',') || text.endsWith(';')) {
      const email = text.slice(0, -1).trim();
      if (email) {
        setRecipients(prev => [...prev, email]);
        setInput('');
        setContactSuggestions([]);
        return;
      }
    }

    setInput(text);

    if (contactSearchRef.current) clearTimeout(contactSearchRef.current);

    if (text.trim().length === 0) {
      setContactSuggestions([]);
      return;
    }

    contactSearchRef.current = setTimeout(async () => {
      try {
        setLoadingSuggestions(true);
        const { data } = await appApiClient.get<{ data: Array<{ id: string; email: string; firstName?: string; lastName?: string; fullName?: string; company?: string | null }> }>(`/people?search=${encodeURIComponent(text.trim())}&limit=10`);
        setContactSuggestions(mapContactSuggestions(data));
      } catch {} finally {
        setLoadingSuggestions(false);
      }
    }, 200);
  }, []);

  const handleSelectContact = useCallback((contact: { email: string; name: string }) => {
    const field = activeRecipientField || 'to';
    const setRecipients = field === 'to' ? setToRecipients : field === 'cc' ? setCcRecipients : setBccRecipients;
    const setInput = field === 'to' ? setToInput : field === 'cc' ? setCcInput : setBccInput;
    setRecipients(prev => [...prev, contact.email]);
    setInput('');
    setContactSuggestions([]);
    setActiveField(null);
    Keyboard.dismiss();
  }, [activeRecipientField]);

  const removeRecipient = useCallback((index: number) => {
    setToRecipients(prev => prev.filter((_, i) => i !== index));
  }, []);

  const sendFromAccount = selectedAccount || (accounts.length > 0 ? accounts[0] : null);
  const to = toRecipients.join(', ');
  const cc = ccRecipients.join(', ');
  const bcc = bccRecipients.join(', ');
  const hasContent = toRecipients.length > 0 || toInput.trim() || subject.trim() || body.trim();
  const activeInput = activeRecipientField === 'to' ? toInput : activeRecipientField === 'cc' ? ccInput : activeRecipientField === 'bcc' ? bccInput : '';
  const showSuggestions = activeRecipientField !== null && activeInput.trim().length > 0;

  const handleFromPress = useCallback(() => {
    if (accounts.length <= 1) return;
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
  }, [accounts, selectAccount]);

  // Collapse the keyboard immediately — blur the WebView editor (which holds
  // its own first responder) AND dismiss any native keyboard from the inputs.
  const dismissKeyboard = useCallback(() => {
    editorRef.current?.injectJavaScript('if(document.activeElement){document.activeElement.blur();}true;');
    Keyboard.dismiss();
  }, []);

  const handleSend = useCallback(async () => {
    if (sendingRef.current) return;
    if (!sendFromAccount) {
      Alert.alert('Error', 'No email account available');
      return;
    }
    if (!to.trim()) {
      Alert.alert('Error', 'Please enter a recipient');
      return;
    }
    // Scheduled emails can't carry attachments yet — tell the user instead of
    // silently dropping the files they attached.
    if (scheduledDate && attachments.length > 0) {
      Alert.alert(
        'Attachments not supported',
        'Scheduled emails can’t include attachments yet. Send now, or remove the attachments to schedule.',
      );
      return;
    }

    dismissKeyboard();
    sendingRef.current = true;
    try {
      setSending(true);
      const quotedSuffix = buildQuotedSuffix(composeMode, params);
      const payloadInput = {
        toRecipients,
        to,
        ccRecipients,
        cc,
        bccRecipients,
        bcc,
        subject,
        body,
        bodyHtml,
        quotedSuffix,
      };

      if (scheduledDate) {
        await appApi.mailScheduled.schedule(
          buildScheduledPayload(payloadInput, sendFromAccount.id, scheduledDate.toISOString()),
        );
        if (onCloseOverride) onCloseOverride(); else router.back();
      } else {
        // Upload any attachments first; on failure we throw and abort the send
        // (the catch below alerts) instead of sending the email without them.
        const uploadedAttachments =
          attachments.length > 0 ? await uploadMailAttachments(attachments) : [];
        // One idempotency key for this composed message: it's used by the direct
        // send AND by the offline-queue fallback, so the backend dedups if the
        // direct send actually reached the server before the connection dropped.
        const idempotencyKey = `snd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        const payload = buildSendPayload(payloadInput, uploadedAttachments, idempotencyKey);
        // Send now, or queue for the reconnect flush if offline. Either outcome
        // closes the composer (a queued send replays dedup-safe via the key);
        // a server reject rethrows to the outer catch's alert.
        await sendThenQueueOnOffline({
          send: () => appApi.mailAccounts.send(sendFromAccount.id, payload),
          queue: () => outbox.enqueueSend(sendFromAccount.id, payload),
        });
        if (onCloseOverride) onCloseOverride(); else router.back();
      }
    } catch (error) {
      console.error('Send error:', error);
      Alert.alert('Error', scheduledDate ? 'Failed to schedule email' : 'Failed to send email');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [sendFromAccount, to, cc, bcc, subject, body, bodyHtml, scheduledDate, attachments, toRecipients, ccRecipients, bccRecipients, composeMode, params, router, onCloseOverride, dismissKeyboard, outbox]);

  const handleClose = useCallback(async () => {
    // Drop the keyboard up front so it animates away with the sheet, not after.
    dismissKeyboard();

    if (!(hasContent && sendFromAccount)) {
      if (onCloseOverride) onCloseOverride(); else router.back();
      return;
    }

    const draftContent = {
      draftAccountId: sendFromAccount.id,
      draftTo: to,
      draftCc: cc,
      draftBcc: bcc,
      draftSubject: subject,
      draftBody: bodyHtml || body,
    };

    if (onCloseOverride) {
      // Close instantly and let the overlay host persist the draft in the
      // background — so the sheet + keyboard don't wait on the network.
      onCloseOverride({ draftSaved: true, ...draftContent });
      return;
    }

    // Route fallback (no overlay): save, then navigate back to the inbox.
    let draftId = '';
    try {
      const res = await appApi.mailDrafts.create({
        accountId: sendFromAccount.id,
        to: to.trim() ? to.trim().split(/[,;]\s*/).filter(Boolean) : undefined,
        cc: cc.trim() ? cc.trim().split(/[,;]\s*/).filter(Boolean) : undefined,
        bcc: bcc.trim() ? bcc.trim().split(/[,;]\s*/).filter(Boolean) : undefined,
        subject: subject || undefined,
        body: bodyHtml ? undefined : ((bodyHtml || body) || undefined),
        htmlBody: bodyHtml || undefined,
      });
      draftId = res.data.id;
    } catch {}
    router.replace({
      pathname: '/',
      params: { draftSaved: '1', draftId, ...draftContent },
    } as any);
  }, [hasContent, sendFromAccount, to, cc, bcc, subject, body, bodyHtml, router, onCloseOverride, dismissKeyboard]);

  // Schedule the email for a given time AND send it (one-tap "Send later").
  const sendScheduled = useCallback(async (date: Date) => {
    if (sendingRef.current) return;
    if (!sendFromAccount) {
      Alert.alert('Error', 'No email account available');
      return;
    }
    if (toRecipients.length === 0 && !to.trim()) {
      Alert.alert('Error', 'Please enter a recipient');
      return;
    }
    if (attachments.length > 0) {
      Alert.alert(
        'Attachments not supported',
        'Scheduled emails can’t include attachments yet. Remove them, or send the email now.',
      );
      return;
    }
    dismissKeyboard();
    sendingRef.current = true;
    try {
      setSending(true);
      const quotedSuffix = buildQuotedSuffix(composeMode, params);
      const fullBody = (bodyHtml || body) + quotedSuffix;
      const toList = resolveRecipients(toRecipients, to);
      const ccList = resolveOptionalRecipients(ccRecipients, cc);
      const bccList = resolveOptionalRecipients(bccRecipients, bcc);
      await appApi.mailScheduled.schedule({
        accountId: sendFromAccount.id,
        to: toList,
        cc: ccList,
        bcc: bccList,
        subject: subject.trim() || undefined,
        body: fullBody || undefined,
        htmlBody: bodyHtml ? fullBody : undefined,
        scheduledFor: date.toISOString(),
      });
      if (onCloseOverride) onCloseOverride(); else router.back();
    } catch (error) {
      console.error('Schedule error:', error);
      Alert.alert('Error', 'Failed to schedule email');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [sendFromAccount, to, cc, bcc, subject, body, bodyHtml, toRecipients, ccRecipients, bccRecipients, composeMode, params, attachments, onCloseOverride, router, dismissKeyboard]);

  // When the custom date picker is opened from "Send later", remember to send
  // (not just set the scheduled date) once the user confirms a time.
  const sendAfterPickRef = useRef(false);

  // AI assist has been removed along with the AI backend.
  const handleAiAssist = () => {
    toast.info('AI is currently unavailable');
  };

  // Which entry point opened the options sheet — they differ only in title and
  // in what a picked date does (send now vs. just stage the scheduled date).
  const [sendTimeSheet, setSendTimeSheet] = useState<null | 'send-later' | 'schedule'>(null);

  const applyPickedSendTime = (date: Date) => {
    setSendTimeSheet(null);
    if (sendTimeSheet === 'send-later') sendScheduled(date);
    else setScheduledDate(date);
  };

  // Shared validation + custom-picker open for the two send-time entry points.
  const requireSendReady = (): boolean => {
    if (!sendFromAccount) {
      Alert.alert('Error', 'No email account available');
      return false;
    }
    if (toRecipients.length === 0 && !toInput.trim()) {
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
  const isSelectedTimeValid = useMemo(
    () => isWithinScheduleWindow(selectedDate, new Date()),
    [selectedDate, showCustomPicker],
  );

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

  const getCalendarDays = () => {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const days: (number | null)[] = [];
    for (let i = 0; i < firstDay; i++) days.push(null);
    for (let i = 1; i <= daysInMonth; i++) days.push(i);
    return days;
  };

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  const isBeforeToday = (day: number) => {
    const d = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return d < today;
  };

  const prevMonth = () => {
    const d = new Date(calendarMonth);
    d.setMonth(d.getMonth() - 1);
    setCalendarMonth(d);
  };

  const nextMonth = () => {
    const d = new Date(calendarMonth);
    d.setMonth(d.getMonth() + 1);
    setCalendarMonth(d);
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const handleAttachment = () => {
    Keyboard.dismiss();
    const options = ['Photo Library', 'Take Photo', 'Choose File', 'Cancel'];
    const cancelButtonIndex = 3;

    setTimeout(() => {
      if (Platform.OS === 'ios') {
        ActionSheetIOS.showActionSheetWithOptions(
          { options, cancelButtonIndex, title: 'Add Attachment' },
          (buttonIndex) => {
            if (buttonIndex === 0) handlePickPhotos();
            else if (buttonIndex === 1) handleTakePhoto();
            else if (buttonIndex === 2) handlePickFiles();
          },
        );
      } else {
        Alert.alert('Add Attachment', undefined, [
          { text: 'Photo Library', onPress: handlePickPhotos },
          { text: 'Take Photo', onPress: handleTakePhoto },
          { text: 'Choose File', onPress: handlePickFiles },
          { text: 'Cancel', style: 'cancel' },
        ]);
      }
    }, 100);
  };

  const handlePickPhotos = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        allowsMultipleSelection: true,
        quality: 0.8,
      });
      if (!result.canceled && result.assets) {
        const newAttachments = result.assets.map(asset => ({
          name: asset.fileName || `photo_${Date.now()}.jpg`,
          uri: asset.uri,
          type: asset.mimeType || 'image/jpeg',
        }));
        setAttachments(prev => [...prev, ...newAttachments]);
      }
    } catch (error) {
      console.error('Error picking photos:', error);
    }
  };

  const handleTakePhoto = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission required', 'Camera permission is needed to take photos.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
      if (!result.canceled && result.assets) {
        const asset = result.assets[0];
        setAttachments(prev => [...prev, {
          name: asset.fileName || `photo_${Date.now()}.jpg`,
          uri: asset.uri,
          type: asset.mimeType || 'image/jpeg',
        }]);
      }
    } catch (error) {
      console.error('Error taking photo:', error);
    }
  };

  const handlePickFiles = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        multiple: true,
      });
      if (!result.canceled && result.assets) {
        const newAttachments = result.assets.map(asset => ({
          name: asset.name,
          uri: asset.uri,
          type: asset.mimeType || 'application/octet-stream',
        }));
        setAttachments(prev => [...prev, ...newAttachments]);
      }
    } catch (error) {
      console.error('Error picking files:', error);
    }
  };

  const execFormat = useCallback((cmd: string, value?: string) => {
    editorRef.current?.postMessage(JSON.stringify({ t: 'fmt', c: cmd, v: value }));
  }, []);

  const onEditorMessage = useCallback((e: any) => {
    try {
      const m = JSON.parse(e.nativeEvent.data);
      if (m.t === 'c') { setBody(m.x || ''); setBodyHtml(m.h || ''); }
      else if (m.t === 'fo') setBodyFocused(true);
      else if (m.t === 'bl') setBodyFocused(false);
      else if (m.t === 'f') setFormats({ b: !!m.b, i: !!m.i, u: !!m.u, l: !!m.l, ol: !!m.ol });
    } catch {}
  }, []);

  const renderRecipientField = (
    field: 'to' | 'cc' | 'bcc',
    label: string,
    recipients: string[],
    input: string,
    setRecipients: React.Dispatch<React.SetStateAction<string[]>>,
    c: typeof colors,
  ) => (
    <View style={[styles.toChipRow, { borderBottomColor: c.border || c.divider }]} key={field}>
      <Text style={[styles.outlookFieldLabel, { color: c.muted, marginTop: 14 }]}>{label}</Text>
      <View style={styles.toChipContainer}>
        {recipients.map((email, index) => (
          <TouchableOpacity
            key={`${field}-${email}-${index}`}
            onPress={() => setRecipients(prev => prev.filter((_, i) => i !== index))}
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
          style={[styles.toChipInput, { color: c.text }]}
          value={input}
          onChangeText={(text) => handleRecipientInputChange(field, text)}
          placeholder=""
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus={field === 'to'}
          onFocus={() => setActiveField(field)}
          onBlur={() => setTimeout(() => { if (activeRecipientFieldRef.current === field) setActiveField(null); }, 150)}
          onKeyPress={({ nativeEvent }) => {
            if (nativeEvent.key === 'Backspace' && input === '' && recipients.length > 0) {
              setRecipients(prev => prev.slice(0, -1));
            }
          }}
          onSubmitEditing={() => {
            if (input.trim()) {
              setRecipients(prev => [...prev, input.trim()]);
              const setInput = field === 'to' ? setToInput : field === 'cc' ? setCcInput : setBccInput;
              setInput('');
              setContactSuggestions([]);
            }
          }}
        />
      </View>
      {field === 'to' && (
        <TouchableOpacity onPress={() => setShowCcBcc(!showCcBcc)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={{ marginTop: 16, paddingLeft: 8 }}>
          {showCcBcc ? (
            <ChevronUp size={18} color={c.muted} strokeWidth={2} />
          ) : (
            <ChevronDown size={18} color={c.muted} strokeWidth={2} />
          )}
        </TouchableOpacity>
      )}
    </View>
  );

  const suggestionsListElement = showSuggestions ? (
    <View style={{ flex: 1, backgroundColor: colors.background, minHeight: 500 }}>
      {contactSuggestions.map((contact) => (
        <TouchableOpacity
          key={contact.id}
          style={styles.suggestionItem}
          onPress={() => handleSelectContact(contact)}
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
      ))}
      <TouchableOpacity
        style={styles.createContactItem}
        onPress={async () => {
          const email = activeInput.trim();
          if (!email) return;
          try { await appApiClient.post('/people', { email }); } catch {}
          handleSelectContact({ email, name: '' });
        }}
        activeOpacity={0.6}
      >
        <View style={[styles.createContactIcon, { backgroundColor: '#F3F4F6' }]}>
          <Plus size={16} color="#9CA3AF" strokeWidth={3} />
        </View>
        <Text style={[styles.createContactText, { color: '#3B82F6' }]}>
          {activeInput.trim() ? `Add "${activeInput.trim()}"` : 'Type an email address'}
        </Text>
      </TouchableOpacity>
    </View>
  ) : null;

  const headerTitle = composeMode === 'reply'
    ? 'Reply'
    : composeMode === 'replyAll'
      ? 'Reply All'
      : composeMode === 'forward'
        ? 'Forward'
        : 'New Message';
  const accountInitial = (sendFromAccount?.displayName || sendFromAccount?.emailAddress || '?').charAt(0).toUpperCase();
  const accountAvatarColor = sendFromAccount ? getAvatarColor(sendFromAccount.displayName || sendFromAccount.emailAddress) : '#6B7280';

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Outlook header: [X] | [Avatar] [Title \n from-email ▽] | [Send arrow] */}
      <View style={[styles.header, { borderBottomColor: colors.border || colors.divider }]}>
        <TouchableOpacity onPress={handleClose} style={styles.closeButton} disabled={sending} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <X size={22} color={colors.text} strokeWidth={2} />
        </TouchableOpacity>

        {sendFromAccount && (
          <View style={[styles.headerAvatar, { backgroundColor: accountAvatarColor }]}>
            <Text style={styles.headerAvatarText}>{accountInitial}</Text>
          </View>
        )}

        <TouchableOpacity
          onPress={accounts.length > 1 ? handleFromPress : undefined}
          activeOpacity={accounts.length > 1 ? 0.7 : 1}
          style={styles.headerTextBlock}
        >
          <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
            {headerTitle}
          </Text>
          {sendFromAccount && (
            <View style={styles.headerFromRow}>
              <Text style={[styles.headerFromEmail, { color: colors.muted }]} numberOfLines={1}>
                {sendFromAccount.emailAddress}
              </Text>
              {accounts.length > 1 && (
                <ChevronDown size={12} color={colors.muted} strokeWidth={2} />
              )}
            </View>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handleSend}
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

      {/* Single ScrollView — all fields + inline suggestions */}
      <ScrollView
        style={styles.form}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {/* To */}
        {renderRecipientField('to', 'To:', toRecipients, toInput, setToRecipients, colors)}
        {activeRecipientField === 'to' && showSuggestions && suggestionsListElement}

        {/* Cc */}
        {showCcBcc && renderRecipientField('cc', 'Cc:', ccRecipients, ccInput, setCcRecipients, colors)}
        {activeRecipientField === 'cc' && showSuggestions && suggestionsListElement}

        {/* Bcc */}
        {showCcBcc && renderRecipientField('bcc', 'Bcc:', bccRecipients, bccInput, setBccRecipients, colors)}
        {activeRecipientField === 'bcc' && showSuggestions && suggestionsListElement}

        {/* Subject, Attachments, Body — hidden when suggestions are showing */}
        {!showSuggestions && (
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
                  onChangeText={setSubject}
                  placeholder=""
                />
              </View>
            </View>

            {attachments.length > 0 && (
              <View style={styles.attachmentsList}>
                {attachments.map((attachment, index) => (
                  <View key={index} style={[styles.attachmentChip, { backgroundColor: colors.card, borderColor: colors.border || colors.divider }]}>
                    <Paperclip size={14} color={colors.muted} strokeWidth={2} />
                    <Text style={[styles.attachmentName, { color: colors.text }]} numberOfLines={1}>
                      {attachment.name}
                    </Text>
                    <TouchableOpacity onPress={() => removeAttachment(index)}>
                      <X size={14} color={colors.muted} strokeWidth={2} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            <View style={styles.bodySection}>
              <WebView
                ref={editorRef}
                source={{ html: editorHtml.current }}
                style={styles.editorWebView}
                scrollEnabled={false}
                keyboardDisplayRequiresUserAction={false}
                hideKeyboardAccessoryView={true}
                originWhitelist={['*']}
                onMessage={onEditorMessage}
                onLoadEnd={() => setEditorReady(true)}
              />
            </View>

            {composeMode && params.quotedBody && (
              <QuotedMessage
                mode={composeMode}
                from={params.quotedFrom || ''}
                date={params.quotedDate || ''}
                subject={params.quotedSubject || ''}
                body={params.quotedBody}
              />
            )}
          </>
        )}
      </ScrollView>

      {/* Toolbar — sticks above keyboard via KeyboardStickyView */}
      <KeyboardStickyView offset={{ closed: 0, opened: 0 }}>
        <View style={[styles.toolbarBar, { paddingBottom: 8 + (keyboardOpen ? 0 : insets.bottom), backgroundColor: colors.background }]}>
          <View style={[styles.toolbarPill, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {bodyFocused ? (
              <>
                <TouchableOpacity
                  style={[styles.toolbarButton, formats.b && toolbarActiveBg]}
                  onPress={() => execFormat('bold')}
                >
                  <Bold size={16} color={formats.b ? colors.info : toolbarIconColor} strokeWidth={2.5} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.toolbarButton, formats.i && toolbarActiveBg]}
                  onPress={() => execFormat('italic')}
                >
                  <Italic size={16} color={formats.i ? colors.info : toolbarIconColor} strokeWidth={2} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.toolbarButton, formats.u && toolbarActiveBg]}
                  onPress={() => execFormat('underline')}
                >
                  <Underline size={16} color={formats.u ? colors.info : toolbarIconColor} strokeWidth={2} />
                </TouchableOpacity>
                <View style={[styles.toolbarDivider, { backgroundColor: colors.border }]} />
                <TouchableOpacity
                  style={[styles.toolbarButton, formats.l && toolbarActiveBg]}
                  onPress={() => execFormat('insertUnorderedList')}
                >
                  <List size={16} color={formats.l ? colors.info : toolbarIconColor} strokeWidth={2} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.toolbarButton, formats.ol && toolbarActiveBg]}
                  onPress={() => execFormat('insertOrderedList')}
                >
                  <ListOrdered size={16} color={formats.ol ? colors.info : toolbarIconColor} strokeWidth={2} />
                </TouchableOpacity>
              </>
            ) : (
              <>
                <TouchableOpacity style={styles.toolbarButton} onPress={handleAttachment} disabled={sending}>
                  <Paperclip size={16} color={toolbarIconColor} strokeWidth={2} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.toolbarButton, scheduledDate && styles.scheduledChip, scheduledDate && toolbarActiveBg]}
                  onPress={handleSchedule}
                  onLongPress={() => scheduledDate && setScheduledDate(null)}
                  disabled={sending}
                >
                  <Clock size={16} color={scheduledDate ? colors.info : toolbarIconColor} strokeWidth={2} />
                  {scheduledDate && (
                    <Text style={[styles.scheduledChipText, { color: colors.info }]}>
                      {scheduledDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}{' '}
                      {formatClock(scheduledDate)}
                    </Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity style={styles.toolbarButton} onPress={handleSendLater} disabled={sending}>
                  <CalendarClock size={16} color={toolbarIconColor} strokeWidth={2} />
                </TouchableOpacity>
                <TouchableOpacity style={styles.toolbarButton} onPress={handleAiAssist}>
                  <Sparkles size={16} color="#8B5CF6" strokeWidth={2} />
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </KeyboardStickyView>

      {/* Send-time options — themed sheet, replaces ActionSheetIOS / Alert.alert */}
      <SendTimePickerModal
        visible={sendTimeSheet !== null}
        title={sendTimeSheet === 'send-later' ? 'Send Later' : 'Schedule Send'}
        onClose={() => setSendTimeSheet(null)}
        onSelect={applyPickedSendTime}
        onCustom={() => openCustomDatePicker(sendTimeSheet === 'send-later')}
      />

      {/* Custom Date/Time Picker Modal */}
      <Modal
        visible={showCustomPicker}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowCustomPicker(false)}
      >
        <View style={[{ flex: 1, backgroundColor: colors.background }]}>
          {/* Header */}
          <View style={styles.calendarHeader}>
            <TouchableOpacity onPress={() => setShowCustomPicker(false)} style={{ padding: 8 }}>
              <X size={22} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
            <Text style={[styles.calendarHeaderTitle, { color: colors.text }]}>Pick Date & Time</Text>
            <TouchableOpacity
              onPress={confirmCustomDateTime}
              disabled={!isSelectedTimeValid}
              style={{ padding: 8, opacity: isSelectedTimeValid ? 1 : 0.4 }}
            >
              <Text style={{ fontSize: 16, fontWeight: '600', color: colors.info }}>Done</Text>
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
            {/* Month navigation */}
            <View style={styles.calendarMonthRow}>
              <TouchableOpacity onPress={prevMonth} style={{ padding: 8 }}>
                <ChevronLeft size={22} color={colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <Text style={[styles.calendarMonthText, { color: colors.text }]}>
                {calendarMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
              </Text>
              <TouchableOpacity onPress={nextMonth} style={{ padding: 8 }}>
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
              {getCalendarDays().map((day, i) => {
                if (day === null) return <View key={`empty-${i}`} style={styles.calendarDayCell} />;
                const cellDate = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day);
                const isSelected = isSameDay(selectedDate, cellDate);
                const isToday = isSameDay(new Date(), cellDate);
                const isPast = isBeforeToday(day);
                return (
                  <TouchableOpacity
                    key={`day-${day}`}
                    style={styles.calendarDayCell}
                    onPress={() => !isPast && setSelectedDate(cellDate)}
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
              })}
            </View>

            {/* Time — custom themed stepper (replaces the native spinner, which
                rendered the stock platform clock and ignored the app theme). */}
            <View style={{ marginTop: 32 }}>
              <Text style={[styles.calendarTimeLabel, { color: colors.muted, paddingHorizontal: 24 }]}>Time</Text>
              <View style={styles.timeStepperRow}>
                <View style={[styles.timeStepper, { backgroundColor: colors.inputBackground, borderColor: colors.border }]}>
                  <TouchableOpacity
                    onPress={() => setSelectedDate(stepTime(selectedDate, 'hour', 1))}
                    style={styles.timeStepperButton}
                    accessibilityLabel="Increase hour"
                  >
                    <ChevronUp size={20} color={colors.muted} strokeWidth={2.5} />
                  </TouchableOpacity>
                  <Text style={[styles.timeStepperValue, { color: colors.text }]}>
                    {selectedDate.getHours().toString().padStart(2, '0')}
                  </Text>
                  <TouchableOpacity
                    onPress={() => setSelectedDate(stepTime(selectedDate, 'hour', -1))}
                    style={styles.timeStepperButton}
                    accessibilityLabel="Decrease hour"
                  >
                    <ChevronDown size={20} color={colors.muted} strokeWidth={2.5} />
                  </TouchableOpacity>
                </View>

                <Text style={[styles.timeStepperColon, { color: colors.text }]}>:</Text>

                <View style={[styles.timeStepper, { backgroundColor: colors.inputBackground, borderColor: colors.border }]}>
                  <TouchableOpacity
                    onPress={() => setSelectedDate(stepTime(selectedDate, 'minute', 1))}
                    style={styles.timeStepperButton}
                    accessibilityLabel="Increase minute"
                  >
                    <ChevronUp size={20} color={colors.muted} strokeWidth={2.5} />
                  </TouchableOpacity>
                  <Text style={[styles.timeStepperValue, { color: colors.text }]}>
                    {selectedDate.getMinutes().toString().padStart(2, '0')}
                  </Text>
                  <TouchableOpacity
                    onPress={() => setSelectedDate(stepTime(selectedDate, 'minute', -1))}
                    style={styles.timeStepperButton}
                    accessibilityLabel="Decrease minute"
                  >
                    <ChevronDown size={20} color={colors.muted} strokeWidth={2.5} />
                  </TouchableOpacity>
                </View>
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
              {!isSelectedTimeValid && (
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
    </View>
  );
}


