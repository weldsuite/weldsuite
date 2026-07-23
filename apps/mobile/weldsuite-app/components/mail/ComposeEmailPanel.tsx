import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Modal,
  Pressable,
  Dimensions,
  ActionSheetIOS,
  Alert,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import {
  Send,
  Paperclip,
  X,
  Clock,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMail } from '@/contexts/MailContext';
import { useToast } from '@/contexts/ToastContext';
import { useEditorBridge, RichText } from '@10play/tentap-editor';
import { EmailEditorToolbar } from './EmailEditorToolbar';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

interface ComposeEmailPanelProps {
  onClose: () => void;
  onSent?: () => void;
  draftId?: string | null;
  isEmbedded?: boolean;
}

export default function ComposeEmailPanel({
  onClose,
  onSent,
  draftId,
  isEmbedded = false,
}: ComposeEmailPanelProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();

  const {
    accounts,
    selectedAccount,
    loading: mailLoading,
    isConnected,
    loadAccounts,
    loadMessage,
    sendEmail,
    saveDraft: saveDraftToContext,
    scheduleEmail,
  } = useMail();

  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isDraft, setIsDraft] = useState(false);
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
  const [showDiscardModal, setShowDiscardModal] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [scheduledDate, setScheduledDate] = useState<Date | null>(null);
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [selectedDay, setSelectedDay] = useState(0);
  const [selectedHour, setSelectedHour] = useState(9);
  const [selectedMinute, setSelectedMinute] = useState(0);
  const [linkUrl, setLinkUrl] = useState('');
  const [attachments, setAttachments] = useState<Array<{ name: string; uri: string; type: string }>>([]);
  const bodyContentRef = useRef<string>('');

  // Initialize rich text editor
  const editor = useEditorBridge({
    autofocus: false,
    avoidIosKeyboard: true,
    initialContent: '',
    onChange: async () => {
      const html = await editor.getHTML();
      bodyContentRef.current = html;
      setBody(html);
    },
    theme: {
      webview: {
        backgroundColor: 'transparent',
      },
      content: {
        css: `
          * {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          }
          body {
            font-size: 16px;
            line-height: 1.5;
            color: ${colors.text};
            padding: 0;
            margin: 0;
          }
          p {
            margin: 0 0 8px 0;
          }
        `,
      },
    },
  });

  const hasContent = to || cc || bcc || subject || body;

  // Common emojis for quick access
  const commonEmojis = ['😊', '👍', '🎉', '❤️', '🙏', '😂', '🔥', '✨', '👋', '💯', '🤝', '📧'];

  useEffect(() => {
    if (accounts.length === 0) {
      loadAccounts();
    }
  }, []);

  useEffect(() => {
    if (draftId) {
      loadDraft(draftId);
    } else {
      setTo('');
      setCc('');
      setBcc('');
      setSubject('');
      setBody('');
      setShowCcBcc(false);
      setIsDraft(false);
      setCurrentDraftId(null);
    }
  }, [draftId]);

  const loadDraft = async (id: string) => {
    try {
      setLoading(true);
      const draft = await loadMessage(id);

      if (draft) {
        setTo(draft.to || '');
        setCc(draft.cc || '');
        setBcc(draft.bcc || '');
        setSubject(draft.subject || '');
        setBody(draft.body || '');
        editor.setContent(draft.body || '');
        bodyContentRef.current = draft.body || '';
        setShowCcBcc(!!(draft.cc || draft.bcc));
        setIsDraft(true);
        setCurrentDraftId(id);
      } else {
        toast.error('Failed to load draft');
        onClose();
      }
    } catch (error) {
      console.error('Error loading draft:', error);
      toast.error('Failed to load draft');
      onClose();
    } finally {
      setLoading(false);
    }
  };

  const handleSend = () => {
    if (!selectedAccount) {
      toast.error('No email account available');
      return;
    }
    if (!to.trim()) {
      toast.error('Please enter a recipient');
      return;
    }
    if (!subject.trim()) {
      toast.warning('Sending message without a subject');
    }
    handleSendEmail();
  };

  const handleSendEmail = async () => {
    if (!selectedAccount) return;

    try {
      setSending(true);

      const success = await sendEmail({
        emailAccountId: selectedAccount.id,
        to: to.trim(),
        cc: cc.trim() || undefined,
        bcc: bcc.trim() || undefined,
        subject: subject.trim(),
        body: body,
        draftId: currentDraftId || undefined,
      });

      if (success) {
        toast.success('Email sent successfully');
        onSent?.();
        onClose();
      } else if (!isConnected) {
        toast.warning('Email queued for when you\'re back online');
        onClose();
      } else {
        toast.error('Failed to send email');
      }
    } catch (error) {
      console.error('Error sending email:', error);
      toast.error('Failed to send email');
    } finally {
      setSending(false);
    }
  };

  const saveDraft = async () => {
    if (!selectedAccount) {
      toast.error('No email account available');
      return;
    }

    if (!to && !cc && !bcc && !subject && !body) {
      toast.error('Draft is empty');
      return;
    }

    try {
      setSaving(true);

      const success = await saveDraftToContext({
        emailAccountId: selectedAccount.id,
        to: to.trim() || undefined,
        cc: cc.trim() || undefined,
        bcc: bcc.trim() || undefined,
        subject: subject.trim() || '(No subject)',
        body: body || '',
        draftId: currentDraftId || undefined,
      });

      if (success) {
        toast.success(currentDraftId ? 'Draft updated' : 'Draft saved');
        onClose();
      } else if (!isConnected) {
        toast.warning('Draft queued for when you\'re back online');
        onClose();
      } else {
        toast.error('Failed to save draft');
      }
    } catch (error) {
      console.error('Error saving draft:', error);
      toast.error('Failed to save draft');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (hasContent) {
      setShowDiscardModal(true);
    } else {
      onClose();
    }
  };

  const handleSaveAndClose = async () => {
    setShowDiscardModal(false);
    await saveDraft();
  };

  const handleDiscardAndClose = () => {
    setShowDiscardModal(false);
    onClose();
  };

  // Schedule send helpers
  const getScheduleOptions = () => {
    const now = new Date();
    const options: { label: string; date: Date }[] = [];

    // In 1 hour
    const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
    options.push({ label: 'In 1 hour', date: inOneHour });

    // In 2 hours
    const inTwoHours = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    options.push({ label: 'In 2 hours', date: inTwoHours });

    // Tomorrow morning at 9 AM
    const tomorrowMorning = new Date(now);
    tomorrowMorning.setDate(tomorrowMorning.getDate() + 1);
    tomorrowMorning.setHours(9, 0, 0, 0);
    options.push({ label: 'Tomorrow morning (9:00 AM)', date: tomorrowMorning });

    // Tomorrow afternoon at 2 PM
    const tomorrowAfternoon = new Date(now);
    tomorrowAfternoon.setDate(tomorrowAfternoon.getDate() + 1);
    tomorrowAfternoon.setHours(14, 0, 0, 0);
    options.push({ label: 'Tomorrow afternoon (2:00 PM)', date: tomorrowAfternoon });

    // Next Monday at 9 AM (if not already Monday)
    const dayOfWeek = now.getDay();
    if (dayOfWeek !== 1) {
      const nextMonday = new Date(now);
      const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
      nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
      nextMonday.setHours(9, 0, 0, 0);
      options.push({ label: 'Monday morning (9:00 AM)', date: nextMonday });
    }

    return options;
  };

  const formatScheduledDate = (date: Date) => {
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    };
    return date.toLocaleDateString('en-US', options);
  };

  // Get available days for custom picker
  const getAvailableDays = () => {
    const days = [];
    const now = new Date();
    for (let i = 0; i < 14; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() + i);
      const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      days.push({ label, date });
    }
    return days;
  };

  const handleSchedule = () => {
    if (!selectedAccount) {
      toast.error('No email account available');
      return;
    }
    if (!to.trim()) {
      toast.error('Please enter a recipient');
      return;
    }

    const scheduleOptions = getScheduleOptions();
    const options = [...scheduleOptions.map(o => o.label), 'Pick date & time', 'Cancel'];
    const customButtonIndex = options.length - 2;
    const cancelButtonIndex = options.length - 1;

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex,
          title: 'Schedule Send',
          message: 'Choose when to send this email',
        },
        (buttonIndex) => {
          if (buttonIndex === customButtonIndex) {
            setSelectedDay(1);
            setSelectedHour(9);
            setSelectedMinute(0);
            setShowCustomPicker(true);
          } else if (buttonIndex !== cancelButtonIndex) {
            const selectedOption = scheduleOptions[buttonIndex];
            setScheduledDate(selectedOption.date);
            setShowScheduleModal(true);
          }
        }
      );
    } else {
      Alert.alert(
        'Schedule Send',
        'Choose when to send this email',
        [
          ...scheduleOptions.map((option) => ({
            text: option.label,
            onPress: () => {
              setScheduledDate(option.date);
              setShowScheduleModal(true);
            },
          })),
          {
            text: 'Pick date & time',
            onPress: () => {
              setSelectedDay(1);
              setSelectedHour(9);
              setSelectedMinute(0);
              setShowCustomPicker(true);
            },
          },
          { text: 'Cancel', style: 'cancel' },
        ]
      );
    }
  };

  const confirmCustomDateTime = () => {
    const days = getAvailableDays();
    const selectedDate = new Date(days[selectedDay].date);
    selectedDate.setHours(selectedHour, selectedMinute, 0, 0);
    setShowCustomPicker(false);
    setScheduledDate(selectedDate);
    setShowScheduleModal(true);
  };

  const confirmScheduleSend = async () => {
    if (!selectedAccount || !scheduledDate) return;

    try {
      setSending(true);
      setShowScheduleModal(false);

      // Parse recipients - split by comma for multiple
      const toList = to.trim().split(/[,;]\s*/).filter(Boolean);
      const ccList = cc.trim() ? cc.trim().split(/[,;]\s*/).filter(Boolean) : undefined;
      const bccList = bcc.trim() ? bcc.trim().split(/[,;]\s*/).filter(Boolean) : undefined;

      const result = await scheduleEmail({
        accountId: selectedAccount.id,
        to: toList,
        cc: ccList,
        bcc: bccList,
        subject: subject.trim() || '(No subject)',
        body: body || undefined,
        htmlBody: body || undefined,
        scheduledFor: scheduledDate.toISOString(),
      });

      if (result) {
        toast.success(`Email scheduled for ${formatScheduledDate(scheduledDate)}`);
        onSent?.();
        onClose();
      } else {
        toast.error('Failed to schedule email');
      }
    } catch (error) {
      console.error('Error scheduling email:', error);
      toast.error('Failed to schedule email');
    } finally {
      setSending(false);
      setScheduledDate(null);
    }
  };

  const cancelSchedule = () => {
    setShowScheduleModal(false);
    setScheduledDate(null);
  };

  // Link insertion handler
  const handleInsertLink = () => {
    setLinkUrl('');
    setShowLinkModal(true);
  };

  const confirmInsertLink = () => {
    if (!linkUrl.trim()) {
      toast.error('Please enter a URL');
      return;
    }
    editor.setLink(linkUrl);
    setShowLinkModal(false);
    setLinkUrl('');
  };

  // Emoji insertion handler
  const handleInsertEmoji = async (emoji: string) => {
    const currentContent = await editor.getHTML();
    editor.focus();
    const newContent = currentContent.replace(/<\/p>$/, emoji + '</p>');
    editor.setContent(newContent);
    setShowEmojiPicker(false);
  };

  const handleAttachment = () => {
    const options = ['Photo Library', 'Take Photo', 'Choose File', 'Cancel'];
    const cancelButtonIndex = 3;

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex,
          title: 'Add Attachment',
        },
        (buttonIndex) => {
          if (buttonIndex === 0) {
            handlePickPhotos();
          } else if (buttonIndex === 1) {
            handleTakePhoto();
          } else if (buttonIndex === 2) {
            handlePickFiles();
          }
        }
      );
    } else {
      Alert.alert(
        'Add Attachment',
        undefined,
        [
          { text: 'Photo Library', onPress: handlePickPhotos },
          { text: 'Take Photo', onPress: handleTakePhoto },
          { text: 'Choose File', onPress: handlePickFiles },
          { text: 'Cancel', style: 'cancel' },
        ]
      );
    }
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
          name: asset.fileName || `image_${Date.now()}.jpg`,
          uri: asset.uri,
          type: asset.mimeType || 'image/jpeg',
        }));
        setAttachments(prev => [...prev, ...newAttachments]);
        toast.success(`${newAttachments.length} photo(s) attached`);
      }
    } catch (error) {
      console.error('Error picking photos:', error);
      toast.error('Failed to attach photos');
    }
  };

  const handleTakePhoto = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        toast.error('Camera permission is required');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        quality: 0.8,
      });
      if (!result.canceled && result.assets) {
        const asset = result.assets[0];
        setAttachments(prev => [...prev, {
          name: asset.fileName || `photo_${Date.now()}.jpg`,
          uri: asset.uri,
          type: asset.mimeType || 'image/jpeg',
        }]);
        toast.success('Photo attached');
      }
    } catch (error) {
      console.error('Error taking photo:', error);
      toast.error('Failed to take photo');
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
        toast.success(`${newAttachments.length} file(s) attached`);
      }
    } catch (error) {
      console.error('Error picking files:', error);
      toast.error('Failed to attach files');
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  if (loading || (mailLoading.accounts && accounts.length === 0)) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={colors.text} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 12, borderBottomColor: colors.divider }]}>
        <View style={styles.headerLeft}>
          <TouchableOpacity
            onPress={handleClose}
            style={[styles.headerButtonOutline, { borderColor: colors.border }]}
            disabled={sending || saving}
          >
            <Text style={[styles.headerButtonText, { color: colors.text }]}>Close</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.headerRight}>
          <TouchableOpacity
            style={[styles.scheduleButton, { borderColor: colors.border }]}
            disabled={sending || saving}
            onPress={handleSchedule}
          >
            <Text style={[styles.scheduleButtonText, { color: colors.text }]}>Schedule</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleSend}
            style={styles.sendButton}
            disabled={sending || saving}
          >
            {sending ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.sendButtonText}>Send</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardAvoid}
      >
        <ScrollView
          style={styles.scrollView}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="none"
          automaticallyAdjustContentInsets={false}
          scrollEventThrottle={16}
        >
          {/* Subject Field */}
          <View style={styles.subjectSection}>
            <TextInput
              style={[styles.subjectInput, { color: colors.text }]}
              placeholder="Subject"
              placeholderTextColor={colors.muted}
              value={subject}
              onChangeText={setSubject}
            />
          </View>

          {/* To Field */}
          <View style={styles.toRow}>
            <Text style={[styles.toLabel, { color: colors.muted }]}>To:</Text>
            <TextInput
              style={[styles.toInput, { color: colors.text }]}
              placeholder=""
              placeholderTextColor={colors.muted}
              value={to}
              onChangeText={setTo}
              keyboardType="email-address"
              autoCapitalize="none"
            />
            <TouchableOpacity onPress={() => setShowCcBcc(!showCcBcc)}>
              <Text style={[styles.ccBccToggle, { color: colors.muted }]}>Cc Bcc</Text>
            </TouchableOpacity>
          </View>

          {/* CC Field */}
          {showCcBcc && (
            <View style={styles.toRow}>
              <Text style={[styles.toLabel, { color: colors.muted }]}>Cc:</Text>
              <TextInput
                style={[styles.toInput, { color: colors.text }]}
                placeholder=""
                placeholderTextColor={colors.muted}
                value={cc}
                onChangeText={setCc}
                keyboardType="email-address"
                autoCapitalize="none"
              />
            </View>
          )}

          {/* BCC Field */}
          {showCcBcc && (
            <View style={styles.toRow}>
              <Text style={[styles.toLabel, { color: colors.muted }]}>Bcc:</Text>
              <TextInput
                style={[styles.toInput, { color: colors.text }]}
                placeholder=""
                placeholderTextColor={colors.muted}
                value={bcc}
                onChangeText={setBcc}
                keyboardType="email-address"
                autoCapitalize="none"
              />
            </View>
          )}

          {/* Formatting Toolbar */}
          <EmailEditorToolbar
            editor={editor}
            onAttachmentPress={handleAttachment}
            colors={{ text: colors.text, border: colors.border, muted: colors.muted }}
          />

          {/* Attachments List */}
          {attachments.length > 0 && (
            <View style={styles.attachmentsList}>
              {attachments.map((attachment, index) => (
                <View key={index} style={[styles.attachmentChip, { backgroundColor: colors.card, borderColor: colors.border }]}>
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

          {/* Message Body - Rich Text Editor */}
          <View style={styles.bodySection}>
            <RichText
              editor={editor}
              scrollEnabled={false}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Discard Modal */}
      <Modal
        visible={showDiscardModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowDiscardModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              Save draft?
            </Text>
            <Text style={[styles.modalMessage, { color: colors.muted }]}>
              Do you want to save this email as a draft?
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonOutline, { borderColor: colors.divider }]}
                onPress={handleDiscardAndClose}
              >
                <Text style={[styles.modalButtonText, { color: '#EF4444' }]}>Discard</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonFilled]}
                onPress={handleSaveAndClose}
              >
                {saving ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={[styles.modalButtonText, { color: '#FFFFFF' }]}>Save Draft</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Link Modal */}
      <Modal
        visible={showLinkModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowLinkModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              Insert Link
            </Text>
            <Text style={[styles.modalMessage, { color: colors.muted }]}>
              Select text first, then add the URL
            </Text>
            <TextInput
              style={[styles.linkInput, { color: colors.text, borderColor: colors.border }]}
              placeholder="https://example.com"
              placeholderTextColor={colors.muted}
              value={linkUrl}
              onChangeText={setLinkUrl}
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonOutline, { borderColor: colors.divider }]}
                onPress={() => setShowLinkModal(false)}
              >
                <Text style={[styles.modalButtonText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonFilled]}
                onPress={confirmInsertLink}
              >
                <Text style={[styles.modalButtonText, { color: '#FFFFFF' }]}>Insert</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Emoji Picker Modal */}
      <Modal
        visible={showEmojiPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowEmojiPicker(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setShowEmojiPicker(false)}>
          <View style={[styles.emojiPickerContent, { backgroundColor: colors.background }]}>
            <Text style={[styles.emojiPickerTitle, { color: colors.text }]}>
              Quick Emojis
            </Text>
            <View style={styles.emojiGrid}>
              {commonEmojis.map((emoji, index) => (
                <TouchableOpacity
                  key={index}
                  style={styles.emojiButton}
                  onPress={() => handleInsertEmoji(emoji)}
                >
                  <Text style={styles.emoji}>{emoji}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* Schedule Confirmation Modal */}
      <Modal
        visible={showScheduleModal}
        transparent
        animationType="fade"
        onRequestClose={cancelSchedule}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
            <View style={styles.scheduleIconContainer}>
              <Clock size={32} color="#3B82F6" strokeWidth={2} />
            </View>
            <Text style={[styles.modalTitle, { color: colors.text, textAlign: 'center' }]}>
              Schedule Email
            </Text>
            <Text style={[styles.scheduleDateTime, { color: colors.text }]}>
              {scheduledDate ? formatScheduledDate(scheduledDate) : ''}
            </Text>
            <Text style={[styles.modalMessage, { color: colors.muted, textAlign: 'center' }]}>
              Your email will be sent at this time
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonOutline, { borderColor: colors.divider }]}
                onPress={cancelSchedule}
              >
                <Text style={[styles.modalButtonText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonFilled, { backgroundColor: '#3B82F6' }]}
                onPress={confirmScheduleSend}
              >
                {sending ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={[styles.modalButtonText, { color: '#FFFFFF' }]}>Schedule</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Custom Date/Time Picker Modal */}
      <Modal
        visible={showCustomPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowCustomPicker(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.datePickerContent, { backgroundColor: colors.background }]}>
            <Text style={[styles.modalTitle, { color: colors.text, textAlign: 'center' }]}>
              Pick Date & Time
            </Text>

            {/* Day Selection */}
            <Text style={[styles.pickerLabel, { color: colors.muted }]}>Date</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.pickerScrollView}
              contentContainerStyle={styles.pickerScrollContent}
            >
              {getAvailableDays().map((day, index) => (
                <TouchableOpacity
                  key={index}
                  style={[
                    styles.pickerOption,
                    { borderColor: colors.border },
                    selectedDay === index && styles.pickerOptionSelected,
                  ]}
                  onPress={() => setSelectedDay(index)}
                >
                  <Text style={[
                    styles.pickerOptionText,
                    { color: selectedDay === index ? '#FFFFFF' : colors.text },
                  ]}>
                    {day.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            {/* Time Selection */}
            <Text style={[styles.pickerLabel, { color: colors.muted, marginTop: 16 }]}>Time</Text>
            <View style={styles.timePickerRow}>
              {/* Hour */}
              <View style={styles.timePickerColumn}>
                <ScrollView
                  style={styles.timeScrollView}
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={styles.timeScrollContent}
                >
                  {Array.from({ length: 24 }, (_, i) => (
                    <TouchableOpacity
                      key={i}
                      style={[
                        styles.timeOption,
                        selectedHour === i && styles.timeOptionSelected,
                      ]}
                      onPress={() => setSelectedHour(i)}
                    >
                      <Text style={[
                        styles.timeOptionText,
                        { color: selectedHour === i ? '#FFFFFF' : colors.text },
                      ]}>
                        {i.toString().padStart(2, '0')}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
              <Text style={[styles.timeSeparator, { color: colors.text }]}>:</Text>
              {/* Minute */}
              <View style={styles.timePickerColumn}>
                <ScrollView
                  style={styles.timeScrollView}
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={styles.timeScrollContent}
                >
                  {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((min) => (
                    <TouchableOpacity
                      key={min}
                      style={[
                        styles.timeOption,
                        selectedMinute === min && styles.timeOptionSelected,
                      ]}
                      onPress={() => setSelectedMinute(min)}
                    >
                      <Text style={[
                        styles.timeOptionText,
                        { color: selectedMinute === min ? '#FFFFFF' : colors.text },
                      ]}>
                        {min.toString().padStart(2, '0')}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            </View>

            <View style={[styles.modalActions, { marginTop: 20 }]}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonOutline, { borderColor: colors.divider }]}
                onPress={() => setShowCustomPicker(false)}
              >
                <Text style={[styles.modalButtonText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonFilled, { backgroundColor: '#3B82F6' }]}
                onPress={confirmCustomDateTime}
              >
                <Text style={[styles.modalButtonText, { color: '#FFFFFF' }]}>Confirm</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerButtonOutline: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  headerButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  scheduleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 8,
  },
  scheduleButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  sendButton: {
    backgroundColor: '#18181B',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  sendButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  keyboardAvoid: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  subjectSection: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 10,
  },
  subjectInput: {
    fontSize: 24,
    fontWeight: '600',
  },
  toRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  toLabel: {
    fontSize: 15,
    marginRight: 8,
  },
  toInput: {
    flex: 1,
    fontSize: 15,
  },
  ccBccToggle: {
    fontSize: 14,
  },
  bodySection: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 16,
    minHeight: Dimensions.get('window').height - 250,
  },
  bodyInput: {
    fontSize: 16,
    lineHeight: 24,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalContent: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 16,
    padding: 24,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  modalMessage: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 24,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 12,
  },
  modalButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalButtonOutline: {
    borderWidth: 1,
  },
  modalButtonFilled: {
    backgroundColor: '#18181B',
  },
  modalButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  attachmentsList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    paddingTop: 8,
    gap: 8,
  },
  attachmentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    gap: 6,
    maxWidth: '100%',
  },
  attachmentName: {
    fontSize: 13,
    maxWidth: 150,
  },
  linkInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    marginBottom: 12,
  },
  emojiPickerContent: {
    width: '80%',
    maxWidth: 300,
    borderRadius: 16,
    padding: 16,
  },
  emojiPickerTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
    textAlign: 'center',
  },
  emojiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 4,
  },
  emojiButton: {
    padding: 8,
  },
  emoji: {
    fontSize: 24,
  },
  scheduleIconContainer: {
    alignItems: 'center',
    marginBottom: 12,
  },
  scheduleDateTime: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 8,
  },
  datePickerContent: {
    width: '90%',
    maxWidth: 360,
    borderRadius: 16,
    padding: 24,
  },
  pickerLabel: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 8,
  },
  pickerScrollView: {
    maxHeight: 44,
  },
  pickerScrollContent: {
    gap: 8,
    paddingRight: 8,
  },
  pickerOption: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  pickerOptionSelected: {
    backgroundColor: '#3B82F6',
    borderColor: '#3B82F6',
  },
  pickerOptionText: {
    fontSize: 14,
    fontWeight: '500',
  },
  timePickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  timePickerColumn: {
    width: 70,
    height: 150,
    borderRadius: 8,
    overflow: 'hidden',
  },
  timeScrollView: {
    flex: 1,
  },
  timeScrollContent: {
    paddingVertical: 4,
  },
  timeOption: {
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 6,
    marginHorizontal: 4,
    marginVertical: 2,
  },
  timeOptionSelected: {
    backgroundColor: '#3B82F6',
  },
  timeOptionText: {
    fontSize: 18,
    fontWeight: '500',
  },
  timeSeparator: {
    fontSize: 24,
    fontWeight: '600',
  },
});
