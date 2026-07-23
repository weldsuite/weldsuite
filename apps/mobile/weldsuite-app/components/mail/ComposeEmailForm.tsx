import React, { useState, useRef, useEffect } from 'react';
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
  ActionSheetIOS,
  Alert,
  Modal,
  Animated,
  Keyboard,
  Pressable,
  KeyboardEvent,
} from 'react-native';
import {
  X,
  Paperclip,
  Clock,
  ChevronDown,
  ChevronUp,
  Bell,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  List,
  Link,
  ChevronLeft,
  Send,
  ThumbsUp,
  ThumbsDown,
  Copy,
  Sparkles,
  ArrowRight,
  ArrowUp,
  CornerDownRight,
  Plus,
  FileText,
  SendHorizontal,
} from 'lucide-react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path as SvgPath } from 'react-native-svg';
import { LinearGradient as SvgLinearGradient, Stop, Defs, Text as SvgText } from 'react-native-svg';
import { useTheme } from '@/contexts/ThemeContext';
import { type EmailAccount } from '@/contexts/MailContext';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import api, { getApiErrorMessage } from '@/services/api';
import { haptics } from '@/utils/haptics';

interface ComposeEmailFormProps {
  // Header
  title?: string;
  showFromSelector?: boolean;
  accounts?: EmailAccount[];
  selectedAccount?: EmailAccount | null;
  onSelectAccount?: (account: EmailAccount) => void;
  onClose: () => void;
  onSend: () => void;
  sending?: boolean;
  saving?: boolean;

  // Fields
  to: string;
  onChangeTo: (text: string) => void;
  cc?: string;
  onChangeCc?: (text: string) => void;
  bcc?: string;
  onChangeBcc?: (text: string) => void;
  subject: string;
  onChangeSubject: (text: string) => void;
  body: string;
  onChangeBody: (text: string) => void;

  // Attachments
  attachments?: Array<{ name: string; uri: string; type: string }>;
  onAttachment?: () => void;
  onRemoveAttachment?: (index: number) => void;

  // Schedule
  onSchedule?: () => void;

  // Optional: quoted message (for reply/forward)
  quotedMessage?: React.ReactNode;

  // Close button style
  closeIcon?: 'x' | 'back';

  // Set true when used inside a modal (formSheet)
  isModal?: boolean;

  // AI context (for generating drafts)
  replyToMessageId?: string;
  emailAccountId?: string;
}

// WeldAgent logo SVG component
const WeldAgentLogo = ({ size = 18, color = '#8d65ef' }: { size?: number; color?: string }) => (
  <Svg width={size} height={size * 0.7} viewBox="0 0 889.29 618.69">
    <SvgPath d="M759.79,0v129.48H129.48v359.69c-29.88-8.21-56.62-24.07-77.92-45.32C19.72,411.96,0,367.95,0,319.32v-143.22C0,78.84,78.84,0,176.1,0h583.7Z" fill={color} />
    <SvgPath d="M129.49,618.69v-129.48h630.32V129.51c29.88,8.21,56.62,24.07,77.92,45.32,31.84,31.89,51.56,75.9,51.56,124.53v143.22c0,97.26-78.84,176.1-176.1,176.1H129.49Z" fill={color} />
    <SvgPath d="M419.29,349.82h-161.9c0-44.73,36.22-80.95,80.95-80.95s80.95,36.22,80.95,80.95Z" fill={color} />
    <SvgPath d="M631.9,349.82h-161.9c0-44.73,36.22-80.95,80.95-80.95s80.95,36.22,80.95,80.95Z" fill={color} />
  </Svg>
);

interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export default function ComposeEmailForm({
  title,
  showFromSelector = true,
  accounts = [],
  selectedAccount,
  onSelectAccount,
  onClose,
  onSend,
  sending = false,
  saving = false,
  to,
  onChangeTo,
  cc = '',
  onChangeCc,
  bcc = '',
  onChangeBcc,
  subject,
  onChangeSubject,
  body,
  onChangeBody,
  attachments = [],
  onAttachment,
  onRemoveAttachment,
  onSchedule,
  quotedMessage,
  closeIcon = 'x',
  isModal = false,
  replyToMessageId,
  emailAccountId,
}: ComposeEmailFormProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [showCcBcc, setShowCcBcc] = useState(!!(cc || bcc));
  const [bodyFocused, setBodyFocused] = useState(false);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [aiSheetHeaderHeight, setAiSheetHeaderHeight] = useState(0);

  // AI Sheet state
  const [showAiSheet, setShowAiSheet] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiMessages, setAiMessages] = useState<AiMessage[]>([]);
  const [aiDraftBody, setAiDraftBody] = useState('');
  const [aiKeyboardVisible, setAiKeyboardVisible] = useState(false);
  const [copiedVisible, setCopiedVisible] = useState(false);
  const [aiFeedback, setAiFeedback] = useState<'up' | 'down' | null>(null);
  const copiedOpacity = useRef(new Animated.Value(0)).current;
  const [aiAttachments, setAiAttachments] = useState<Array<{ name: string; uri: string; type: string }>>([]);
  const aiScrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!showAiSheet) return;
    const showSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setAiKeyboardVisible(true),
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setAiKeyboardVisible(false),
    );
    return () => { showSub.remove(); hideSub.remove(); };
  }, [showAiSheet]);

  const handleFromPress = () => {
    if (!onSelectAccount || accounts.length <= 1) return;
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...accounts.map(a => a.emailAddress), 'Cancel'],
          cancelButtonIndex: accounts.length,
        },
        (index) => {
          if (index < accounts.length) {
            onSelectAccount(accounts[index]);
          }
        }
      );
    } else {
      Alert.alert('Send from', undefined,
        [...accounts.map(a => ({ text: a.emailAddress, onPress: () => onSelectAccount(a) })),
         { text: 'Cancel', style: 'cancel' as const }]
      );
    }
  };

  const handleAiSend = async (directPrompt?: string) => {
    const prompt = (directPrompt || aiPrompt).trim();
    if (!prompt) return;

    const userMessage: AiMessage = { role: 'user', content: prompt };
    setAiMessages(prev => [...prev, userMessage]);
    setAiPrompt('');
    setAiGenerating(true);

    setTimeout(() => aiScrollRef.current?.scrollToEnd({ animated: true }), 100);

    try {
      const response = await api.generateAiDraft({
        prompt,
        replyToMessageId,
        accountId: emailAccountId,
      });

      if (response.success && response.data) {
        const { subject: aiSubject, body: aiBody } = response.data;
        const draftText = aiBody || '';
        setAiDraftBody(draftText);
        setAiMessages(prev => [...prev, { role: 'assistant', content: draftText }]);

        if (aiSubject && !subject) {
          onChangeSubject(aiSubject);
        }
      } else {
        const errorMsg = getApiErrorMessage(response.error, 'Failed to generate draft. Please try again.');
        setAiMessages(prev => [...prev, { role: 'assistant', content: `Error: ${errorMsg}` }]);
      }
    } catch (err) {
      setAiMessages(prev => [...prev, { role: 'assistant', content: 'Failed to generate draft. Please try again.' }]);
    } finally {
      setAiGenerating(false);
      setTimeout(() => aiScrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  };

  const handleInsertDraft = () => {
    if (aiDraftBody) {
      onChangeBody(aiDraftBody);
    }
    handleCloseAiSheet();
  };

  const handleCloseAiSheet = () => {
    setShowAiSheet(false);
    setAiMessages([]);
    setAiPrompt('');
    setAiDraftBody('');
    setAiGenerating(false);
    setAiFeedback(null);
    setAiAttachments([]);
  };

  const handleAiAttachment = () => {
    Keyboard.dismiss();
    const options = ['Photo Library', 'Take Photo', 'Choose File', 'Cancel'];
    const cancelButtonIndex = 3;

    setTimeout(() => {
      if (Platform.OS === 'ios') {
        ActionSheetIOS.showActionSheetWithOptions(
          { options, cancelButtonIndex, title: 'Add Attachment' },
          (buttonIndex) => {
            if (buttonIndex === 0) handleAiPickPhotos();
            else if (buttonIndex === 1) handleAiTakePhoto();
            else if (buttonIndex === 2) handleAiPickFiles();
          }
        );
      } else {
        Alert.alert('Add Attachment', undefined, [
          { text: 'Photo Library', onPress: handleAiPickPhotos },
          { text: 'Take Photo', onPress: handleAiTakePhoto },
          { text: 'Choose File', onPress: handleAiPickFiles },
          { text: 'Cancel', style: 'cancel' },
        ]);
      }
    }, 100);
  };

  const handleAiPickPhotos = async () => {
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
        setAiAttachments(prev => [...prev, ...newAttachments]);
      }
    } catch (error) {
      console.error('Error picking photos:', error);
    }
  };

  const handleAiTakePhoto = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission required', 'Camera permission is needed to take photos.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
      if (!result.canceled && result.assets) {
        const asset = result.assets[0];
        setAiAttachments(prev => [...prev, {
          name: asset.fileName || `photo_${Date.now()}.jpg`,
          uri: asset.uri,
          type: asset.mimeType || 'image/jpeg',
        }]);
      }
    } catch (error) {
      console.error('Error taking photo:', error);
    }
  };

  const handleAiPickFiles = async () => {
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
        setAiAttachments(prev => [...prev, ...newAttachments]);
      }
    } catch (error) {
      console.error('Error picking files:', error);
    }
  };

  const renderToolbarContent = () => (
    <View style={styles.floatingToolbarInner}>
      {bodyFocused ? (
        <>
          <TouchableOpacity style={styles.formatButton}>
            <Bold size={18} color="#374151" strokeWidth={2.5} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.formatButton}>
            <Italic size={18} color="#374151" strokeWidth={2} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.formatButton}>
            <Underline size={18} color="#374151" strokeWidth={2} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.formatButton}>
            <Strikethrough size={18} color="#374151" strokeWidth={2} />
          </TouchableOpacity>
          <View style={styles.formatDivider} />
          <TouchableOpacity style={styles.formatButton}>
            <List size={18} color="#374151" strokeWidth={2} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.formatButton}>
            <Link size={18} color="#374151" strokeWidth={2} />
          </TouchableOpacity>
          <View style={styles.formatDivider} />
          <TouchableOpacity
            style={styles.formatButton}
            onPress={() => Alert.alert('AI unavailable', 'AI is currently unavailable.')}
          >
            <WeldAgentLogo size={20} color="#374151" />
          </TouchableOpacity>
        </>
      ) : (
        <>
          {onAttachment && (
            <TouchableOpacity style={styles.formatButton} onPress={onAttachment}>
              <Paperclip size={18} color="#374151" strokeWidth={2} />
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.formatButton}>
            <Bell size={18} color="#374151" strokeWidth={2} />
          </TouchableOpacity>
          {onSchedule && (
            <TouchableOpacity style={styles.formatButton} onPress={onSchedule}>
              <Clock size={18} color="#374151" strokeWidth={2} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.formatButton}
            onPress={() => Alert.alert('AI unavailable', 'AI is currently unavailable.')}
          >
            <WeldAgentLogo size={20} color="#374151" />
          </TouchableOpacity>
        </>
      )}
    </View>
  );

  return (
    <>
      {/* Header */}
      <View
        style={styles.header}
        onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}
      >
        <TouchableOpacity
          onPress={onClose}
          style={styles.closeButton}
          disabled={sending || saving}
        >
          <X size={22} color={colors.text} strokeWidth={1.5} />
        </TouchableOpacity>
        {showFromSelector && selectedAccount ? (
          <TouchableOpacity
            style={styles.headerEmailButton}
            onPress={handleFromPress}
            activeOpacity={accounts.length > 1 ? 0.7 : 1}
          >
            <Text style={[styles.headerEmail, { color: colors.text }]} numberOfLines={1}>
              {selectedAccount.emailAddress || selectedAccount.displayName || 'Compose'}
            </Text>
            {accounts.length > 1 && <ChevronDown size={14} color={colors.muted} strokeWidth={2} />}
          </TouchableOpacity>
        ) : title ? (
          <Text style={[styles.headerEmail, { color: colors.text }]}>{title}</Text>
        ) : null}
        <TouchableOpacity
          onPress={onSend}
          style={[styles.sendIconButton, sending && { opacity: 0.5 }]}
          disabled={sending || saving}
        >
          {sending ? (
            <ActivityIndicator size="small" color={colors.text} />
          ) : (
            <SendHorizontal size={22} color={colors.text} strokeWidth={1.5} />
          )}
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardAvoid}
        keyboardVerticalOffset={isModal ? headerHeight : (Platform.OS === 'ios' ? (insets.top - 28) : 0)}
      >
        <ScrollView
          style={styles.scrollView}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {/* To Field */}
          <View style={[styles.toRow, { borderBottomColor: colors.border }]}>
            <Text style={[styles.toLabel, { color: colors.muted }]}>To:</Text>
            <TextInput
              style={[styles.toInput, { color: colors.text }]}
              placeholder=""
              placeholderTextColor={colors.muted}
              value={to}
              onChangeText={onChangeTo}
              keyboardType="email-address"
              autoCapitalize="none"
            />
            {onChangeCc && onChangeBcc && (
              <TouchableOpacity onPress={() => setShowCcBcc(!showCcBcc)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                {showCcBcc ? (
                  <ChevronUp size={16} color={colors.muted} strokeWidth={2} />
                ) : (
                  <Text style={[styles.ccBccToggle, { color: '#3B82F6' }]}>Cc: Bcc:</Text>
                )}
              </TouchableOpacity>
            )}
          </View>

          {/* CC Field */}
          {showCcBcc && onChangeCc && (
            <View style={[styles.toRow, { borderBottomColor: colors.border }]}>
              <Text style={[styles.toLabel, { color: colors.muted }]}>Cc:</Text>
              <TextInput
                style={[styles.toInput, { color: colors.text }]}
                placeholder=""
                placeholderTextColor={colors.muted}
                value={cc}
                onChangeText={onChangeCc}
                keyboardType="email-address"
                autoCapitalize="none"
              />
            </View>
          )}

          {/* BCC Field */}
          {showCcBcc && onChangeBcc && (
            <View style={[styles.toRow, { borderBottomColor: colors.border }]}>
              <Text style={[styles.toLabel, { color: colors.muted }]}>Bcc:</Text>
              <TextInput
                style={[styles.toInput, { color: colors.text }]}
                placeholder=""
                placeholderTextColor={colors.muted}
                value={bcc}
                onChangeText={onChangeBcc}
                keyboardType="email-address"
                autoCapitalize="none"
              />
            </View>
          )}

          {/* Subject Field */}
          <View style={[styles.subjectSection, { borderBottomColor: colors.border }]}>
            <TextInput
              style={[styles.subjectInput, { color: colors.text }]}
              placeholder="Subject"
              placeholderTextColor={colors.muted}
              value={subject}
              onChangeText={onChangeSubject}
            />
          </View>

          {/* Attachments List */}
          {attachments.length > 0 && (
            <View style={styles.attachmentsList}>
              {attachments.map((attachment, index) => (
                <View key={index} style={[styles.attachmentChip, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Paperclip size={14} color={colors.muted} strokeWidth={2} />
                  <Text style={[styles.attachmentName, { color: colors.text }]} numberOfLines={1}>
                    {attachment.name}
                  </Text>
                  {onRemoveAttachment && (
                    <TouchableOpacity onPress={() => onRemoveAttachment(index)}>
                      <X size={14} color={colors.muted} strokeWidth={2} />
                    </TouchableOpacity>
                  )}
                </View>
              ))}
            </View>
          )}

          {/* Message Body */}
          <View style={styles.bodySection}>
            <TextInput
              style={[styles.bodyInput, { color: colors.text }]}
              placeholder="Say something"
              placeholderTextColor={colors.muted}
              value={body}
              onChangeText={onChangeBody}
              multiline
              textAlignVertical="top"
              onFocus={() => setBodyFocused(true)}
              onBlur={() => setBodyFocused(false)}
            />
          </View>

          {/* Quoted Message */}
          {quotedMessage}
        </ScrollView>

        {/* Bottom Toolbar */}
        <View style={{ backgroundColor: colors.background, alignItems: 'flex-end', paddingHorizontal: 12, paddingBottom: isModal ? 6 : insets.bottom + 6 }}>
          {renderToolbarContent()}
        </View>
      </KeyboardAvoidingView>

      {/* WeldAgent AI Sheet */}
      <Modal
        visible={showAiSheet}
        animationType="slide"
        presentationStyle="formSheet"
        onRequestClose={handleCloseAiSheet}
      >
        <View style={[aiStyles.container, { backgroundColor: colors.background }]}>
          {/* Drag handle */}
          <View style={aiStyles.handleBar}>
            <View style={aiStyles.handle} />
          </View>

          {/* Sheet header */}
          <View
            style={[aiStyles.sheetHeader, { borderBottomColor: colors.border }]}
            onLayout={(e) => setAiSheetHeaderHeight(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}
          >
            <View style={aiStyles.sheetTitleRow}>
              <WeldAgentLogo size={20} color="#8d65ef" />
              <Text style={[aiStyles.sheetTitle, { color: colors.text }]}>WeldAgent</Text>
            </View>
            <TouchableOpacity onPress={handleCloseAiSheet} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <X size={20} color={colors.muted} strokeWidth={2} />
            </TouchableOpacity>
          </View>

          {/* Copied notification */}
          {copiedVisible && (
            <Animated.View style={[aiStyles.copiedBanner, { opacity: copiedOpacity }]}>
              <Text style={aiStyles.copiedBannerText}>Copied to clipboard</Text>
            </Animated.View>
          )}

          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ flex: 1 }}
            keyboardVerticalOffset={aiSheetHeaderHeight + 7}
          >
          {/* Messages */}
          <ScrollView
            ref={aiScrollRef}
            style={aiStyles.messagesContainer}
            contentContainerStyle={aiStyles.messagesContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={() => aiScrollRef.current?.scrollToEnd({ animated: true })}
          >
            {aiMessages.length === 0 && !aiGenerating && (
              <View style={aiStyles.emptyState}>
                <View style={aiStyles.greetingContainer}>
                  <Svg width="100%" height={70}>
                    <Defs>
                      <SvgLinearGradient id="greetingGrad" x1="0" y1="0" x2="1" y2="1">
                        <Stop offset="0" stopColor="#C084FC" />
                        <Stop offset="0.4" stopColor="#8B5CF6" />
                        <Stop offset="0.7" stopColor="#6366F1" />
                        <Stop offset="1" stopColor="#818CF8" />
                      </SvgLinearGradient>
                    </Defs>
                    <SvgText
                      fill="url(#greetingGrad)"
                      fontSize="28"
                      fontWeight="500"
                      x="0"
                      y="26"
                    >
                      Hello, Weld
                    </SvgText>
                    <SvgText
                      fill="url(#greetingGrad)"
                      fontSize="28"
                      fontWeight="500"
                      x="0"
                      y="62"
                    >
                      How can I help you today?
                    </SvgText>
                  </Svg>
                </View>
              </View>
            )}

            {aiMessages.map((msg, index) => (
              <View key={index}>
                {msg.role === 'user' ? (
                  <View style={aiStyles.userBubbleRow}>
                    <View style={aiStyles.userBubble}>
                      <Text style={[aiStyles.userBubbleText, { color: colors.text }]}>{msg.content}</Text>
                    </View>
                  </View>
                ) : (
                  <View style={aiStyles.assistantRow}>
                    <View style={aiStyles.assistantContent}>
                      <Text style={[aiStyles.assistantText, { color: colors.text }]}>{msg.content}</Text>

                      {/* Action buttons for the latest assistant message */}
                      {index === aiMessages.length - 1 && (
                        <>
                        <View style={{ height: 1, backgroundColor: '#E9E0FF', marginTop: 18, marginBottom: 14 }} />
                        <View style={aiStyles.assistantActions}>
                          <View style={aiStyles.feedbackButtons}>
                            <TouchableOpacity style={aiStyles.feedbackButton} onPress={() => { haptics.light(); setAiFeedback(aiFeedback === 'up' ? null : 'up'); }}>
                              <ThumbsUp size={16} color={aiFeedback === 'up' ? '#374151' : colors.muted} fill={aiFeedback === 'up' ? '#374151' : 'none'} strokeWidth={2} />
                            </TouchableOpacity>
                            <TouchableOpacity style={aiStyles.feedbackButton} onPress={() => { haptics.light(); setAiFeedback(aiFeedback === 'down' ? null : 'down'); }}>
                              <ThumbsDown size={16} color={aiFeedback === 'down' ? '#374151' : colors.muted} fill={aiFeedback === 'down' ? '#374151' : 'none'} strokeWidth={2} />
                            </TouchableOpacity>
                            <TouchableOpacity style={aiStyles.feedbackButton} onPress={async () => {
                              haptics.light();
                              try {
                                const Clip = require('expo-clipboard');
                                await Clip.setStringAsync(msg.content);
                              } catch {
                                // Fallback if expo-clipboard not available
                              }
                              setCopiedVisible(true);
                              Animated.timing(copiedOpacity, { toValue: 1, duration: 250, useNativeDriver: true }).start(() => {
                                setTimeout(() => {
                                  Animated.timing(copiedOpacity, { toValue: 0, duration: 400, useNativeDriver: true }).start(() => {
                                    setCopiedVisible(false);
                                  });
                                }, 1500);
                              });
                            }}>
                              <Copy size={16} color={colors.muted} strokeWidth={2} />
                            </TouchableOpacity>
                          </View>
                          <TouchableOpacity style={aiStyles.insertButton} onPress={handleInsertDraft}>
                            <Text style={aiStyles.insertButtonText}>Insert</Text>
                          </TouchableOpacity>
                        </View>
                        </>
                      )}
                    </View>
                  </View>
                )}
              </View>
            ))}

            {/* Loading indicator */}
            {aiGenerating && (
              <View style={aiStyles.assistantRow}>
                <View style={aiStyles.assistantContent}>
                  <View style={aiStyles.typingIndicator}>
                    <View style={[aiStyles.typingDot, { backgroundColor: '#8d65ef' }]} />
                    <View style={[aiStyles.typingDot, aiStyles.typingDotDelay1, { backgroundColor: '#8d65ef' }]} />
                    <View style={[aiStyles.typingDot, aiStyles.typingDotDelay2, { backgroundColor: '#8d65ef' }]} />
                  </View>
                </View>
              </View>
            )}
          </ScrollView>

          {/* Suggestions — shown at bottom when no messages and keyboard hidden */}
          {aiMessages.length === 0 && !aiGenerating && !aiKeyboardVisible && (
            <View style={aiStyles.suggestionsBottom}>
              <Pressable
                style={({ pressed }) => [aiStyles.suggestionRow, pressed && { backgroundColor: '#F3F4F6' }]}
                onPress={() => handleAiSend('Write a professional reply')}
              >
                <CornerDownRight size={16} color={colors.muted} strokeWidth={2} />
                <Text style={[aiStyles.suggestionRowText, { color: colors.text }]}>Write a professional reply</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [aiStyles.suggestionRow, pressed && { backgroundColor: '#F3F4F6' }]}
                onPress={() => handleAiSend('Write a friendly, casual reply')}
              >
                <CornerDownRight size={16} color={colors.muted} strokeWidth={2} />
                <Text style={[aiStyles.suggestionRowText, { color: colors.text }]}>Write a friendly, casual reply</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [aiStyles.suggestionRow, pressed && { backgroundColor: '#F3F4F6' }]}
                onPress={() => handleAiSend('Write a short confirmation reply')}
              >
                <CornerDownRight size={16} color={colors.muted} strokeWidth={2} />
                <Text style={[aiStyles.suggestionRowText, { color: colors.text }]}>Write a short confirmation reply</Text>
              </Pressable>
            </View>
          )}

          {/* Input bar — same design as helpdesk ticket detail */}
          <View style={{ backgroundColor: colors.background, paddingBottom: aiKeyboardVisible ? 4 : insets.bottom + 10 }}>
            <View style={aiStyles.commentInputContainer}>
              <View style={[aiStyles.commentInputBox, { borderColor: colors.border }]}>
                <TextInput
                  style={aiStyles.commentInput}
                  placeholder="Ask WeldAgent anything..."
                  placeholderTextColor="#9CA3AF"
                  value={aiPrompt}
                  onChangeText={setAiPrompt}
                  multiline
                  maxLength={5000}
                  editable={!aiGenerating}
                />
                {aiAttachments.length > 0 && (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                    {aiAttachments.map((att, i) => (
                      <View key={i} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#F3F4F6', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5, gap: 6 }}>
                        <Paperclip size={12} color="#9CA3AF" strokeWidth={2} />
                        <Text style={{ fontSize: 13, color: '#374151' }} numberOfLines={1}>{att.name}</Text>
                        <TouchableOpacity onPress={() => setAiAttachments(prev => prev.filter((_, idx) => idx !== i))}>
                          <X size={12} color="#9CA3AF" strokeWidth={2} />
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                )}
                <View style={aiStyles.commentInputActions}>
                  <View style={aiStyles.commentActionsLeft}>
                    <TouchableOpacity style={aiStyles.commentActionButton} onPress={handleAiAttachment}>
                      <Plus size={20} color="#9CA3AF" strokeWidth={2} />
                    </TouchableOpacity>
                  </View>
                  <View style={aiStyles.commentActionsRight}>
                    <TouchableOpacity
                      style={[
                        aiStyles.commentSendButton,
                        (aiPrompt.trim() && !aiGenerating) ? aiStyles.commentSendButtonActive : {},
                        aiGenerating && { opacity: 0.6 },
                      ]}
                      onPress={handleAiSend}
                      disabled={!aiPrompt.trim() || aiGenerating}
                    >
                      {aiGenerating ? (
                        <ActivityIndicator size="small" color={aiPrompt.trim() ? '#FFFFFF' : '#9CA3AF'} />
                      ) : (
                        <ArrowUp size={16} color={(aiPrompt.trim() && !aiGenerating) ? '#FFFFFF' : '#9CA3AF'} strokeWidth={2.5} />
                      )}
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            </View>
          </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  closeButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerEmailButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  headerEmail: {
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  sendIconButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    justifyContent: 'center',
    alignItems: 'center',
  },
  keyboardAvoid: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  toRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    height: 48,
    borderBottomWidth: 0.5,
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
    fontSize: 12,
    fontWeight: '500',
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#93C5FD',
    borderRadius: 8,
  },
  subjectSection: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    height: 48,
    borderBottomWidth: 0.5,
  },
  subjectInput: {
    flex: 1,
    fontSize: 16,
    fontWeight: '500',
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
  bodySection: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  bodyInput: {
    fontSize: 15,
    minHeight: 50,
    paddingTop: 10,
  },
  floatingToolbarInner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#D1D5DB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 4,
    paddingVertical: 6,
    paddingHorizontal: 8,
    gap: 2,
  },
  formatButton: {
    padding: 10,
    borderRadius: 6,
  },
  formatDivider: {
    width: 1,
    height: 20,
    backgroundColor: '#E5E7EB',
    marginHorizontal: 4,
  },
});

const aiStyles = StyleSheet.create({
  container: {
    flex: 1,
  },
  handleBar: {
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 4,
  },
  handle: {
    width: 36,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#D1D5DB',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  messagesContainer: {
    flex: 1,
  },
  messagesContent: {
    paddingHorizontal: 12,
    paddingTop: 20,
    paddingBottom: 12,
  },
  emptyState: {
    flex: 1,
    paddingTop: 4,
    paddingHorizontal: 0,
  },
  greetingContainer: {
    gap: 2,
  },
  suggestionsBottom: {
    paddingHorizontal: 18,
    paddingBottom: 5,
    gap: 4,
  },
  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  suggestionRowText: {
    fontSize: 15,
  },
  userBubbleRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: 16,
  },
  userBubble: {
    maxWidth: '85%',
    borderRadius: 18,
    borderBottomRightRadius: 4,
    backgroundColor: '#F3F4F6',
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  userBubbleText: {
    fontSize: 15,
    lineHeight: 20,
  },
  assistantRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 16,
  },
  assistantContent: {
    flex: 1,
    backgroundColor: '#F3F0FF',
    borderRadius: 18,
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: '#E9E0FF',
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  assistantText: {
    fontSize: 15,
    lineHeight: 22,
  },
  assistantActions: {
    marginTop: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  insertButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#18181B',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  insertButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  feedbackButtons: {
    flexDirection: 'row',
    gap: 4,
  },
  feedbackButton: {
    padding: 8,
    borderRadius: 8,
  },
  typingIndicator: {
    flexDirection: 'row',
    gap: 4,
    paddingVertical: 8,
  },
  typingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    opacity: 0.4,
  },
  typingDotDelay1: {
    opacity: 0.6,
  },
  typingDotDelay2: {
    opacity: 0.8,
  },
  commentInputContainer: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  commentInputBox: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 8,
    paddingTop: 10,
    paddingBottom: 8,
    minHeight: 100,
  },
  commentInput: {
    fontSize: 15,
    color: '#000000',
    maxHeight: 150,
    paddingVertical: 0,
    marginLeft: 3,
    marginTop: 2,
    minHeight: 40,
  },
  commentInputActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  commentActionsLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  commentActionButton: {
    padding: 2,
  },
  commentActionsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  commentSendButton: {
    width: 30,
    height: 30,
    borderRadius: 10,
    backgroundColor: '#E5E7EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  commentSendButtonActive: {
    backgroundColor: '#000000',
  },
  copiedBanner: {
    backgroundColor: '#18181B',
    paddingVertical: 10,
    paddingHorizontal: 16,
    marginHorizontal: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  copiedBannerText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '500',
  },
});
