import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  TextInput,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import {
  Star,
  Reply,
  ReplyAll,
  Forward,
  Trash2,
  Paperclip,
  Archive,
  Save,
  ChevronLeft,
} from 'lucide-react-native';
import { useSafeAreaInsets, SafeAreaView } from 'react-native-safe-area-context';
import { useMail, type EmailDetail } from '@/contexts/MailContext';
import { useToast } from '@/contexts/ToastContext';

// Helper: extract sender name from `from` which can be a string or JSONB { email, name }
function getSenderName(from: any): string {
  if (!from) return '(No sender)';
  if (typeof from === 'string') return from;
  return from.name || from.email || '(No sender)';
}

function getSenderEmail(from: any): string {
  if (!from) return '';
  if (typeof from === 'string') return from;
  return from.email || '';
}

function formatRecipients(recipients: any): string {
  if (!recipients) return '';
  if (typeof recipients === 'string') return recipients;
  if (Array.isArray(recipients)) {
    return recipients.map(r => typeof r === 'string' ? r : (r.name || r.email || '')).filter(Boolean).join(', ');
  }
  return recipients.name || recipients.email || '';
}

interface EmailDetailPanelProps {
  emailId: string | null;
  onClose?: () => void;
  showBackButton?: boolean;
  isEmbedded?: boolean;
}

export default function EmailDetailPanel({
  emailId,
  onClose,
  showBackButton = false,
  isEmbedded = false,
}: EmailDetailPanelProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();

  const {
    currentMessage,
    loading: mailLoading,
    isConnected,
    loadMessage,
    markAsRead,
    toggleStar,
    deleteMessage,
    archiveMessage,
    sendEmail,
    saveDraft: saveDraftToContext,
  } = useMail();

  const [email, setEmail] = useState<EmailDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [composeModalVisible, setComposeModalVisible] = useState(false);
  const [composeMode, setComposeMode] = useState<'reply' | 'replyAll' | 'forward'>('reply');

  // Reply/Forward form state
  const [replyTo, setReplyTo] = useState('');
  const [replyCc, setReplyCc] = useState('');
  const [replyBcc, setReplyBcc] = useState('');
  const [replySubject, setReplySubject] = useState('');
  const [replyBody, setReplyBody] = useState('');
  const [sending, setSending] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);

  useEffect(() => {
    if (emailId) {
      loadEmailData();
    } else {
      setEmail(null);
      setLoading(false);
    }
  }, [emailId]);

  const loadEmailData = async () => {
    if (!emailId) return;

    try {
      setLoading(true);
      const emailData = await loadMessage(emailId);

      if (emailData) {
        setEmail(emailData);

        if (!emailData.isRead) {
          markAsRead(emailId, true);
          setEmail(prev => prev ? { ...prev, isRead: true } : null);
        }
      } else {
        toast.error('Failed to load email');
        onClose?.();
      }
    } catch (error) {
      console.error('Error loading email:', error);
      toast.error('Failed to load email');
      onClose?.();
    } finally {
      setLoading(false);
    }
  };

  const handleStarToggle = async () => {
    if (!email) return;

    const wasStarred = email.isStarred;
    setEmail({ ...email, isStarred: !wasStarred });

    const success = await toggleStar(email.id);
    if (!success && isConnected) {
      setEmail(prev => prev ? { ...prev, isStarred: wasStarred } : null);
      toast.error('Failed to update star status');
    } else if (!isConnected) {
      toast.warning('Queued for when you\'re back online');
    }
  };

  const handleDelete = async () => {
    if (!email) return;

    const success = await deleteMessage(email.id);
    if (success) {
      toast.success('Email deleted successfully');
      onClose?.();
    } else if (!isConnected) {
      toast.warning('Queued for when you\'re back online');
      onClose?.();
    } else {
      toast.error('Failed to delete email');
    }
  };

  const handleArchive = async () => {
    if (!email) return;

    const success = await archiveMessage(email.id);
    if (success) {
      toast.success('Email archived successfully');
      onClose?.();
    } else if (!isConnected) {
      toast.warning('Queued for when you\'re back online');
      onClose?.();
    } else {
      toast.error('Failed to archive email');
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const openComposeModal = (mode: 'reply' | 'replyAll' | 'forward') => {
    if (!email) return;

    setComposeMode(mode);

    if (mode === 'reply') {
      setReplyTo(email.fromEmail || getSenderEmail(email.from));
      setReplyCc('');
      setReplyBcc('');
      setReplySubject(email.subject?.startsWith('Re:') ? email.subject : `Re: ${email.subject}`);
      setReplyBody('');
    } else if (mode === 'replyAll') {
      const allRecipients = [email.fromEmail || getSenderEmail(email.from)];
      if (email.to) {
        const toStr = formatRecipients(email.to);
        if (toStr) allRecipients.push(...toStr.split(',').map(e => e.trim()));
      }
      setReplyTo(allRecipients.filter(e => e).join(', '));
      setReplyCc(typeof email.cc === 'string' ? email.cc : formatRecipients(email.cc));
      setReplyBcc('');
      setReplySubject(email.subject?.startsWith('Re:') ? email.subject : `Re: ${email.subject}`);
      setReplyBody('');
    } else if (mode === 'forward') {
      setReplyTo('');
      setReplyCc('');
      setReplyBcc('');
      setReplySubject(email.subject?.startsWith('Fwd:') ? email.subject : `Fwd: ${email.subject}`);
      setReplyBody('');
    }

    setComposeModalVisible(true);
  };

  const handleSend = async () => {
    if (!email) return;

    if (!replyTo.trim()) {
      toast.error('Please enter a recipient');
      return;
    }

    if (!replySubject.trim()) {
      toast.warning('Sending message without a subject');
    }

    sendReply();
  };

  const sendReply = async () => {
    if (!email) return;

    try {
      setSending(true);

      const quotedMessage = `\n\n---------- ${composeMode === 'forward' ? 'Forwarded message' : 'Original message'} ---------\nFrom: ${getSenderName(email.from)} (${email.fromEmail || getSenderEmail(email.from)})\nDate: ${email.date} at ${email.time}\nSubject: ${email.subject}\n\n${email.body}`;

      const success = await sendEmail({
        emailAccountId: email.emailAccountId,
        to: replyTo.trim(),
        cc: replyCc.trim() || undefined,
        bcc: replyBcc.trim() || undefined,
        subject: replySubject.trim(),
        body: replyBody + quotedMessage,
        inReplyTo: composeMode !== 'forward' ? email.inReplyTo : undefined,
        threadId: email.threadId,
      });

      if (success) {
        toast.success('Email sent successfully');
        setComposeModalVisible(false);
        clearComposeForm();
      } else if (!isConnected) {
        toast.warning('Email queued for when you\'re back online');
        setComposeModalVisible(false);
        clearComposeForm();
      } else {
        toast.error('Failed to send email');
      }
    } catch (error) {
      console.error('Error sending reply:', error);
      toast.error('Failed to send email');
    } finally {
      setSending(false);
    }
  };

  const saveReplyDraft = async () => {
    if (!email) return;

    try {
      setSavingDraft(true);

      const quotedMessage = `\n\n---------- ${composeMode === 'forward' ? 'Forwarded message' : 'Original message'} ---------\nFrom: ${getSenderName(email.from)} (${email.fromEmail || getSenderEmail(email.from)})\nDate: ${email.date} at ${email.time}\nSubject: ${email.subject}\n\n${email.body}`;

      const success = await saveDraftToContext({
        emailAccountId: email.emailAccountId,
        to: replyTo.trim() || undefined,
        cc: replyCc.trim() || undefined,
        bcc: replyBcc.trim() || undefined,
        subject: replySubject.trim() || '(No subject)',
        body: (replyBody || '') + quotedMessage,
        inReplyTo: composeMode !== 'forward' ? email.inReplyTo : undefined,
        threadId: email.threadId,
      });

      if (success) {
        toast.success('Draft saved successfully');
        setComposeModalVisible(false);
        clearComposeForm();
      } else if (!isConnected) {
        toast.warning('Draft queued for when you\'re back online');
        setComposeModalVisible(false);
        clearComposeForm();
      } else {
        toast.error('Failed to save draft');
      }
    } catch (error) {
      console.error('Error saving draft:', error);
      toast.error('Failed to save draft');
    } finally {
      setSavingDraft(false);
    }
  };

  const clearComposeForm = () => {
    setReplyTo('');
    setReplyCc('');
    setReplyBcc('');
    setReplySubject('');
    setReplyBody('');
  };

  if (!emailId) {
    return (
      <View style={[styles.emptyContainer, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <Text style={[styles.emptyText, { color: colors.muted }]}>
          Select an email to view
        </Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.text} />
      </View>
    );
  }

  if (!email) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <Text style={[styles.errorText, { color: colors.text }]}>Email not found</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        {/* Email Header */}
        <View style={[styles.emailHeader, { paddingTop: insets.top + 8 }]}>
          <View style={styles.subjectRow}>
            {showBackButton && (
              <TouchableOpacity onPress={onClose} style={styles.backButton}>
                <ChevronLeft size={24} color={colors.text} strokeWidth={2} />
              </TouchableOpacity>
            )}
            <Text style={[styles.subject, { color: colors.text }]}>
              {email.subject}
            </Text>
            <View style={styles.subjectActions}>
              <TouchableOpacity onPress={handleStarToggle} style={styles.actionButton}>
                <Star
                  size={20}
                  color={email.isStarred ? '#F59E0B' : colors.muted}
                  fill={email.isStarred ? '#F59E0B' : 'transparent'}
                  strokeWidth={2}
                />
              </TouchableOpacity>
              <TouchableOpacity onPress={handleArchive} style={styles.actionButton}>
                <Archive size={20} color={colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <TouchableOpacity onPress={handleDelete} style={styles.actionButton}>
                <Trash2 size={20} color={colors.text} strokeWidth={2} />
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.senderSection}>
            <View style={[styles.avatar, { backgroundColor: '#3B82F620' }]}>
              <Text style={[styles.avatarText, { color: '#3B82F6' }]}>
                {getSenderName(email.from).charAt(0).toUpperCase()}
              </Text>
            </View>
            <View style={styles.senderInfo}>
              <Text style={[styles.senderName, { color: colors.text }]}>
                {getSenderName(email.from)}
              </Text>
              <Text style={[styles.recipientLabel, { color: '#3B82F6' }]}>
                To: {formatRecipients(email.to)}
              </Text>
            </View>
            <View style={styles.dateTime}>
              <Text style={[styles.date, { color: colors.muted }]}>
                {email.date}
              </Text>
              <Text style={[styles.time, { color: colors.muted }]}>
                {email.time}
              </Text>
            </View>
          </View>
        </View>

        {/* Attachments */}
        {email.hasAttachment && email.attachments && email.attachments.length > 0 && (
          <View style={styles.attachmentsSection}>
            <Text style={[styles.attachmentsTitle, { color: colors.text }]}>
              Attachments ({email.attachments.length})
            </Text>
            {email.attachments.map((attachment) => (
              <TouchableOpacity
                key={attachment.id}
                style={[styles.attachmentItem, { backgroundColor: '#F3F4F6' }]}
              >
                <Paperclip size={16} color={colors.text} strokeWidth={2} />
                <Text style={[styles.attachmentName, { color: colors.text }]}>
                  {attachment.filename}
                </Text>
                <Text style={[styles.attachmentSize, { color: colors.muted }]}>
                  {formatFileSize(attachment.size)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Email Body */}
        <View style={styles.bodySection}>
          <Text style={[styles.body, { color: colors.text }]}>
            {email.body || email.bodyHtml}
          </Text>
        </View>
      </ScrollView>

      {/* Action Bar */}
      <View style={[styles.actionBar, {
        backgroundColor: colors.background,
        paddingBottom: insets.bottom + 10
      }]}>
        <TouchableOpacity
          style={[styles.replyButton, { borderColor: '#E5E7EB' }]}
          activeOpacity={0.7}
          onPress={() => openComposeModal('reply')}
        >
          <Reply size={18} color={colors.text} strokeWidth={2} />
          <Text style={[styles.replyText, { color: colors.text }]}>Reply</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.replyButton, { borderColor: '#E5E7EB' }]}
          activeOpacity={0.7}
          onPress={() => openComposeModal('replyAll')}
        >
          <ReplyAll size={18} color={colors.text} strokeWidth={2} />
          <Text style={[styles.replyText, { color: colors.text }]}>Reply All</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.replyButton, { borderColor: '#E5E7EB' }]}
          activeOpacity={0.7}
          onPress={() => openComposeModal('forward')}
        >
          <Forward size={18} color={colors.text} strokeWidth={2} />
          <Text style={[styles.replyText, { color: colors.text }]}>Forward</Text>
        </TouchableOpacity>
      </View>

      {/* Compose Modal */}
      <Modal
        visible={composeModalVisible}
        animationType="slide"
        presentationStyle="formSheet"
        onRequestClose={() => setComposeModalVisible(false)}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
          <View style={[styles.modalHeader, { backgroundColor: colors.background, borderBottomWidth: 1, borderBottomColor: colors.divider }]}>
            <Text style={[styles.modalTitle, { color: colors.text, marginLeft: 16 }]}>
              {composeMode === 'reply' ? 'Reply' : composeMode === 'replyAll' ? 'Reply All' : 'Forward'}
            </Text>
            <TouchableOpacity
              onPress={() => setComposeModalVisible(false)}
              style={styles.modalCloseButton}
            >
              <ChevronLeft size={20} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.composeContent}>
            {/* To Field */}
            <View style={[styles.composeField, { borderBottomColor: colors.divider }]}>
              <Text style={[styles.fieldLabel, { color: colors.muted }]}>To:</Text>
              <TextInput
                style={[styles.fieldInput, { color: colors.text }]}
                placeholder="recipient@example.com"
                placeholderTextColor={colors.muted}
                value={replyTo}
                onChangeText={setReplyTo}
                autoCapitalize="none"
                keyboardType="email-address"
              />
            </View>

            {/* Cc Field */}
            <View style={[styles.composeField, { borderBottomColor: colors.divider }]}>
              <Text style={[styles.fieldLabel, { color: colors.muted }]}>Cc:</Text>
              <TextInput
                style={[styles.fieldInput, { color: colors.text }]}
                placeholder="optional"
                placeholderTextColor={colors.muted}
                value={replyCc}
                onChangeText={setReplyCc}
                autoCapitalize="none"
                keyboardType="email-address"
              />
            </View>

            {/* Bcc Field */}
            <View style={[styles.composeField, { borderBottomColor: colors.divider }]}>
              <Text style={[styles.fieldLabel, { color: colors.muted }]}>Bcc:</Text>
              <TextInput
                style={[styles.fieldInput, { color: colors.text }]}
                placeholder="optional"
                placeholderTextColor={colors.muted}
                value={replyBcc}
                onChangeText={setReplyBcc}
                autoCapitalize="none"
                keyboardType="email-address"
              />
            </View>

            {/* Subject Field */}
            <View style={[styles.composeField, { borderBottomColor: colors.divider }]}>
              <Text style={[styles.fieldLabel, { color: colors.muted }]}>Subject:</Text>
              <TextInput
                style={[styles.fieldInput, { color: colors.text }]}
                placeholder="Email subject"
                placeholderTextColor={colors.muted}
                value={replySubject}
                onChangeText={setReplySubject}
              />
            </View>

            {/* Message Body */}
            <View style={styles.messageField}>
              <TextInput
                style={[styles.messageInput, { color: colors.text }]}
                placeholder="Write your message..."
                placeholderTextColor={colors.muted}
                value={replyBody}
                onChangeText={setReplyBody}
                multiline
                textAlignVertical="top"
              />
            </View>

            {/* Original Message */}
            <View style={[styles.originalMessage, { borderTopColor: colors.divider }]}>
              <Text style={[styles.originalMessageLabel, { color: colors.muted }]}>
                {composeMode === 'forward' ? '---------- Forwarded message ---------' : '---------- Original message ---------'}
              </Text>
              <Text style={[styles.originalMessageText, { color: colors.muted }]}>
                From: {getSenderName(email?.from)} ({email?.fromEmail || getSenderEmail(email?.from)}){'\n'}
                Date: {email?.date} at {email?.time}{'\n'}
                Subject: {email?.subject}{'\n\n'}
                {email?.body}
              </Text>
            </View>
          </ScrollView>

          {/* Send Button */}
          <View style={[styles.composeSendBar, { backgroundColor: colors.background, borderTopColor: colors.divider, paddingBottom: insets.bottom + 10 }]}>
            <View style={styles.sendActions}>
              <TouchableOpacity
                style={[styles.draftButton, { borderColor: colors.divider }]}
                onPress={saveReplyDraft}
                disabled={sending || savingDraft}
              >
                {savingDraft ? (
                  <ActivityIndicator size="small" color={colors.text} />
                ) : (
                  <>
                    <Save size={18} color={colors.text} strokeWidth={2} />
                    <Text style={[styles.draftButtonText, { color: colors.text }]}>Draft</Text>
                  </>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.sendButton}
                onPress={handleSend}
                disabled={sending || savingDraft}
              >
                {sending ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.sendButtonText}>Send</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 16,
  },
  errorText: {
    fontSize: 16,
  },
  backButton: {
    padding: 4,
    marginRight: 8,
  },
  actionButton: {
    padding: 4,
  },
  scrollView: {
    flex: 1,
  },
  emailHeader: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
    borderBottomColor: '#E5E7EB',
  },
  subjectRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 16,
    gap: 12,
  },
  subject: {
    fontSize: 20,
    fontWeight: '600',
    lineHeight: 26,
    flex: 1,
  },
  subjectActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  senderSection: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  avatarText: {
    fontSize: 15,
    fontWeight: '600',
  },
  senderInfo: {
    flex: 1,
  },
  senderName: {
    fontSize: 15,
    fontWeight: '600',
  },
  dateTime: {
    alignItems: 'flex-end',
  },
  date: {
    fontSize: 13,
  },
  time: {
    fontSize: 12,
    marginTop: 2,
  },
  recipientLabel: {
    fontSize: 13,
    marginTop: 2,
  },
  attachmentsSection: {
    padding: 16,
    borderBottomWidth: 0.5,
    borderBottomColor: '#E5E7EB',
  },
  attachmentsTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
  },
  attachmentItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
  },
  attachmentName: {
    flex: 1,
    fontSize: 14,
    marginLeft: 8,
  },
  attachmentSize: {
    fontSize: 12,
  },
  bodySection: {
    padding: 16,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
  },
  actionBar: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingTop: 16,
    paddingHorizontal: 16,
    gap: 12,
    borderTopWidth: 0.5,
    borderTopColor: '#E5E7EB',
  },
  replyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderRadius: 8,
    flex: 1,
  },
  replyText: {
    fontSize: 13,
    fontWeight: '500',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingTop: 16,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  modalCloseButton: {
    padding: 4,
    marginRight: 16,
  },
  composeContent: {
    flex: 1,
  },
  composeField: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
  },
  fieldLabel: {
    fontSize: 15,
    fontWeight: '500',
    width: 70,
  },
  fieldInput: {
    flex: 1,
    fontSize: 15,
  },
  messageField: {
    padding: 16,
    minHeight: 200,
  },
  messageInput: {
    fontSize: 15,
    lineHeight: 22,
    minHeight: 180,
  },
  originalMessage: {
    padding: 16,
    borderTopWidth: 0.5,
    marginTop: 20,
  },
  originalMessageLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 12,
  },
  originalMessageText: {
    fontSize: 14,
    lineHeight: 20,
  },
  composeSendBar: {
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: 0.5,
  },
  sendActions: {
    flexDirection: 'row',
    gap: 12,
  },
  draftButton: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 14,
    borderRadius: 8,
    borderWidth: 1,
  },
  draftButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  sendButton: {
    flex: 1,
    backgroundColor: '#3B82F6',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  sendButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
