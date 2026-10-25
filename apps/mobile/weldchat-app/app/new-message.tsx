import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Alert,
  Keyboard,
  Linking,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { KeyboardStickyView, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useSharedValue } from 'react-native-reanimated';
import { Hash, Lock, Check } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@clerk/expo';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { BRAND } from '@/lib/brand';
import { useI18n } from '@/lib/i18n';
import { mapDm, type DmChannel } from '@/lib/chat/dm';
import { useChatCache } from '@/hooks/useChatCache';
import { useVoiceRecorder } from '@/hooks/useVoiceRecorder';
import {
  MIN_VOICE_MESSAGE_MS,
  openAttachmentPicker,
  uploadChatAttachment,
  type ChatAttachment,
  type RNFile,
} from '@/lib/chat/attachments';
import {
  CollapsedComposer,
  ComposerBarFrame,
  ExpandedComposer,
  PendingFiles,
  RecordingPill,
  useComposerBarStyle,
  useKeyboardHide,
} from '@/components/chat/ComposerBar';
import { SheetHeader } from '@/components/ui/SheetHeader';

import type { ThemeColors } from '@/lib/theme-colors';

import { appApi } from '@/services/app-api';

interface WorkspaceMember {
  userId: string;
  name: string | null;
  email: string | null;
  picture: string | null;
}

interface ChannelRow {
  id: string;
  name: string;
  type: string;
  lastMessageAt?: string | null;
}

/** Who the message goes to: a channel, an existing (group) DM, or people. */
type Recipient =
  | { kind: 'channel'; id: string; name: string; isPrivate: boolean }
  | { kind: 'dm'; id: string; name: string; dm: DmChannel }
  | { kind: 'person'; userId: string; name: string; picture: string | null };

type Styles = ReturnType<typeof makeStyles>;

const RECENT_COUNT = 10;
const RESULT_COUNT = 20;

function recipientKey(r: Recipient): string {
  return r.kind === 'person' ? `p:${r.userId}` : `${r.kind}:${r.id}`;
}

function channelRecipient(c: ChannelRow): Recipient {
  return { kind: 'channel', id: c.id, name: c.name, isPrivate: c.type === 'private' };
}

function personRecipient(m: WorkspaceMember): Recipient {
  return { kind: 'person', userId: m.userId, name: m.name || m.email || '?', picture: m.picture };
}

// A 1:1 DM is the other person; a group DM stays a conversation.
function dmRecipient(dm: DmChannel): Recipient {
  const others = dm.otherMembers ?? [];
  if (!dm.isGroup && others[0]) {
    const m = others[0];
    return { kind: 'person', userId: m.userId, name: m.name || m.email || dm.name, picture: m.picture ?? null };
  }
  return { kind: 'dm', id: dm.id, name: dm.name, dm };
}

/**
 * Slack's "New message": pick any mix of channels, conversations and people in
 * "To:", write the message and send it. Every channel and conversation gets
 * it; the people picked share one DM (an existing DM with the same
 * participants is reused). With a single destination it opens after sending.
 */
export default function NewMessageScreen() {
  const { t, format } = useI18n();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { userId } = useAuth();
  const cache = useChatCache();
  const toast = useToast();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const toInputRef = useRef<TextInput>(null);
  const messageInputRef = useRef<TextInput>(null);

  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [dms, setDms] = useState<DmChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [message, setMessage] = useState('');
  const [messageFocused, setMessageFocused] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<RNFile[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Cache first so the recent list is there at once.
    void Promise.all([cache.getChannels(), cache.getDms()]).then(([cachedChannels, cachedDms]) => {
      if (cancelled) return;
      if (cachedChannels) setChannels(cachedChannels as ChannelRow[]);
      if (cachedDms) setDms(cachedDms as DmChannel[]);
    });
    void Promise.all([
      appApi.chatMembers.list(),
      appApi.channels.list({ limit: 100 }),
      appApi.chatDm.list(),
    ])
      .then(([memberRes, channelRes, dmRes]) => {
        if (cancelled) return;
        setMembers((memberRes.data || []) as unknown as WorkspaceMember[]);
        setChannels(
          ((channelRes.data || []) as unknown as ChannelRow[]).filter(
            (c) => c.type !== 'dm' && c.type !== 'entity',
          ),
        );
        setDms(((dmRes.data ?? []) as unknown[]).map((d) => mapDm(d, userId ?? undefined)));
      })
      .catch((err) => console.error('[WeldChat] New message: load failed', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cache, userId]);

  const recent = useMemo<Recipient[]>(() => {
    const items: { at: string; r: Recipient }[] = [
      ...dms.map((dm) => ({ at: dm.lastMessageAt ?? '', r: dmRecipient(dm) })),
      ...channels.map((c) => ({ at: c.lastMessageAt ?? '', r: channelRecipient(c) })),
    ];
    return items
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, RECENT_COUNT)
      .map((i) => i.r);
  }, [dms, channels]);

  const term = query.trim().replace(/^[#@]/, '').toLowerCase();
  // Searching: what matches. Otherwise everyone and every channel, after
  // (and without repeating) the recent ones.
  const peopleList = useMemo<Recipient[]>(() => {
    const others = members.filter((m) => m.userId !== userId);
    if (term) {
      return others
        .filter((m) => m.name?.toLowerCase().includes(term) || m.email?.toLowerCase().includes(term))
        .slice(0, RESULT_COUNT)
        .map(personRecipient);
    }
    const inRecent = new Set(recent.map(recipientKey));
    return others
      .map(personRecipient)
      .filter((r) => !inRecent.has(recipientKey(r)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [members, term, userId, recent]);
  const channelList = useMemo<Recipient[]>(() => {
    if (term) {
      if (query.trim().startsWith('@')) return [];
      return channels
        .filter((c) => c.name.toLowerCase().includes(term))
        .slice(0, RESULT_COUNT)
        .map(channelRecipient);
    }
    const inRecent = new Set(recent.map(recipientKey));
    return channels
      .map(channelRecipient)
      .filter((r) => !inRecent.has(recipientKey(r)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [channels, term, query, recent]);

  const selectedKeys = new Set(recipients.map(recipientKey));

  // Any mix of channels, conversations and people; tapping again removes one.
  const toggleRecipient = (r: Recipient) => {
    const key = recipientKey(r);
    setError(null);
    setQuery('');
    setRecipients((prev) =>
      prev.some((p) => recipientKey(p) === key) ? prev.filter((p) => recipientKey(p) !== key) : [...prev, r],
    );
  };

  const removeLast = () => {
    if (query.length === 0 && recipients.length > 0) setRecipients((prev) => prev.slice(0, -1));
  };

  const canSend =
    recipients.length > 0 && (message.trim().length > 0 || pendingFiles.length > 0) && !sending;

  const { isRecording, durationMs, meteringDb, startRecording, stopRecording, cancelRecording } =
    useVoiceRecorder();
  // A recorded voice message is uploading: the recording bar stays up, frozen
  // at the final length, with a spinner in the send button.
  const [sendingVoiceMs, setSendingVoiceMs] = useState<number | null>(null);
  const showRecordingBar = isRecording || sendingVoiceMs !== null;

  // The chat's composer: it widens with the keyboard, so while picking people
  // in "To:" it is a full-width pill, and it opens into the card only once the
  // message field has focus (or holds text or files).
  const composerExpanded = messageFocused || message.length > 0 || pendingFiles.length > 0;
  const { progress } = useReanimatedKeyboardAnimation();
  const composerHeldOpenSV = useSharedValue(0);
  useEffect(() => {
    composerHeldOpenSV.value = composerExpanded && !messageFocused && !showRecordingBar ? 1 : 0;
  }, [messageFocused, composerExpanded, showRecordingBar, composerHeldOpenSV]);
  const composerBarStyle = useComposerBarStyle(progress, composerHeldOpenSV, insets.bottom);
  // Collapse as the keyboard goes down, not a beat after it (see useKeyboardHide).
  const handleKeyboardHide = useCallback(() => setMessageFocused(false), []);
  useKeyboardHide(handleKeyboardHide);

  // Every picked channel and conversation gets the message; the people picked
  // share one DM. Files are uploaded once per destination, as an upload
  // belongs to its channel. On a failure whoever already has it drops out of
  // "To:", so sending again doesn't post it twice.
  const deliver = async (body: string, files: RNFile[]) => {
    const conversations = recipients.flatMap((r) => (r.kind === 'person' ? [] : [r]));
    const people = recipients.flatMap((r) => (r.kind === 'person' ? [r] : []));
    const delivered: string[] = [];
    const destinations: { id: string; isDm: boolean }[] = [];
    const sendTo = async (channelId: string) => {
      let attachments: ChatAttachment[] | undefined;
      if (files.length > 0) {
        const uploaded = await Promise.all(files.map((f) => uploadChatAttachment(channelId, f)));
        attachments = uploaded.filter((a): a is ChatAttachment => a !== null);
        if (attachments.length === 0) throw new Error('Attachment upload failed');
      }
      await appApi.chatMessages.create({ channelId, body, attachments });
    };
    try {
      for (const r of conversations) {
        await sendTo(r.id);
        delivered.push(recipientKey(r));
        destinations.push({ id: r.id, isDm: r.kind === 'dm' });
      }
      if (people.length > 0) {
        const res = await appApi.chatDm.create({ userIds: people.map((p) => p.userId) });
        if (!res.data?.id) throw new Error('No DM id');
        await sendTo(res.data.id);
        delivered.push(...people.map(recipientKey));
        destinations.push({ id: res.data.id, isDm: true });
      }
    } catch (err) {
      setRecipients((prev) => prev.filter((r) => !delivered.includes(recipientKey(r))));
      throw err;
    }
    router.dismiss();
    // One destination: open it. Several: back to where the user was.
    const only = destinations.length === 1 ? destinations[0] : undefined;
    if (only) router.push((only.isDm ? `/dm/${only.id}` : `/channel/${only.id}`) as any);
  };

  const handleSend = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await deliver(message.trim(), pendingFiles);
    } catch (err) {
      console.error('[WeldChat] New message: send failed', err);
      setError(t.newMessage.sendFailed);
      setSending(false);
    }
  };

  const handleAttach = () => {
    openAttachmentPicker((files) => setPendingFiles((prev) => [...prev, ...files]));
  };

  const handleStartRecording = async () => {
    Keyboard.dismiss();
    const result = await startRecording();
    if (result === 'started') {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } else if (result === 'denied') {
      Alert.alert(t.composer.micPermissionTitle, t.composer.micPermissionBody, [
        { text: t.common.cancel, style: 'cancel' },
        { text: t.composer.openSettings, onPress: () => void Linking.openSettings() },
      ]);
    } else {
      toast.error(t.composer.recordFailed);
    }
  };

  // Throws the recording away; nothing is uploaded.
  const handleCancelRecording = async () => {
    await cancelRecording();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleSendRecording = async () => {
    // A tap-and-send by accident gives a near-silent clip: drop it instead.
    if (durationMs < MIN_VOICE_MESSAGE_MS) {
      await cancelRecording();
      toast.error(t.composer.voiceTooShort);
      return;
    }
    setSendingVoiceMs(durationMs);
    const recording = await stopRecording();
    try {
      if (!recording) throw new Error('No recording to send');
      await deliver('', [recording]);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      console.error('[WeldChat] New message: voice message failed', err);
      toast.error(t.composer.voiceSendFailed);
      setSendingVoiceMs(null);
    }
  };

  let composer: React.ReactNode;
  if (showRecordingBar) {
    composer = (
      <RecordingPill
        meteringDb={meteringDb}
        durationMs={sendingVoiceMs ?? durationMs}
        sending={sendingVoiceMs !== null}
        onCancel={handleCancelRecording}
        onSend={handleSendRecording}
      />
    );
  } else if (composerExpanded) {
    composer = (
      <ExpandedComposer
        input={message}
        placeholder={t.newMessage.messagePlaceholder}
        uploading={sending}
        canSend={canSend}
        inputRef={messageInputRef}
        onChangeText={setMessage}
        onFocus={() => setMessageFocused(true)}
        onBlur={() => setMessageFocused(false)}
        onAttach={handleAttach}
        onSend={handleSend}
      />
    );
  } else {
    composer = (
      <CollapsedComposer
        placeholder={t.newMessage.messagePlaceholder}
        onAttach={handleAttach}
        onExpand={() => setMessageFocused(true)}
        onStartRecording={handleStartRecording}
      />
    );
  }

  const noResults = !!term && peopleList.length === 0 && channelList.length === 0;

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <SheetHeader
          title={t.newMessage.title}
          onLeadingPress={() => router.back()}
          leadingLabel={t.newMessage.close}
        />

        {/* To: chips + search */}
        <Pressable style={styles.toRow} onPress={() => toInputRef.current?.focus()}>
          <Text style={styles.toLabel}>{t.newMessage.to}</Text>
          <View style={styles.toChips}>
            {recipients.map((r) => (
              <TouchableOpacity
                key={recipientKey(r)}
                style={styles.chip}
                onPress={() => toggleRecipient(r)}
                activeOpacity={0.6}
                accessibilityRole="button"
                accessibilityLabel={format(t.newMessage.removeRecipient, { name: r.name })}
              >
                <Text style={styles.chipText} numberOfLines={1}>
                  {r.kind === 'channel' ? `#${r.name}` : r.name}
                </Text>
              </TouchableOpacity>
            ))}
            <TextInput
              ref={toInputRef}
              style={[styles.toInput, query.length === 0 && recipients.length > 0 && styles.toInputIdle]}
              value={query}
              onChangeText={(text) => {
                setQuery(text);
                setError(null);
              }}
              onKeyPress={(e) => {
                if (e.nativeEvent.key === 'Backspace') removeLast();
              }}
              placeholder={recipients.length === 0 ? t.newMessage.toPlaceholder : ''}
              placeholderTextColor={colors.muted}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </Pressable>

        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        >
          {!term && loading && recent.length === 0 && (
            <ActivityIndicator style={styles.loader} color={colors.mutedForeground} />
          )}

          {!term && recent.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>{t.newMessage.recent}</Text>
              {recent.map((r) => (
                <RecipientRow
                  key={recipientKey(r)}
                  recipient={r}
                  selected={selectedKeys.has(recipientKey(r))}
                  onPress={() => toggleRecipient(r)}
                  styles={styles}
                  colors={colors}
                />
              ))}
            </>
          )}

          {peopleList.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>{t.newMessage.people}</Text>
              {peopleList.map((r) => (
                <RecipientRow
                  key={recipientKey(r)}
                  recipient={r}
                  selected={selectedKeys.has(recipientKey(r))}
                  onPress={() => toggleRecipient(r)}
                  styles={styles}
                  colors={colors}
                />
              ))}
            </>
          )}

          {channelList.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>{t.newMessage.channels}</Text>
              {channelList.map((r) => (
                <RecipientRow
                  key={recipientKey(r)}
                  recipient={r}
                  selected={selectedKeys.has(recipientKey(r))}
                  onPress={() => toggleRecipient(r)}
                  styles={styles}
                  colors={colors}
                />
              ))}
            </>
          )}

          {noResults && <Text style={styles.empty}>{format(t.newMessage.noResults, { query: query.trim() })}</Text>}
        </ScrollView>

        {/* The message, once there is someone to send it to. */}
        {recipients.length > 0 && (
          <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
            {error && <Text style={styles.error}>{error}</Text>}
            <PendingFiles
              files={pendingFiles}
              onRemove={(i) => setPendingFiles((prev) => prev.filter((_, j) => j !== i))}
            />
            <ComposerBarFrame
              idle={!showRecordingBar && !composerExpanded}
              animatedStyle={composerBarStyle}
              bottomInset={insets.bottom}
            >
              {composer}
            </ComposerBarFrame>
          </KeyboardStickyView>
        )}
      </View>
    </>
  );
}

function ListRow({
  leading,
  title,
  trailing,
  selected,
  onPress,
  styles,
}: Readonly<{
  leading: React.ReactNode;
  title: string;
  trailing?: React.ReactNode;
  selected: boolean;
  onPress: () => void;
  styles: Styles;
}>) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
    >
      {leading}
      <Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
      {trailing}
    </Pressable>
  );
}

function RecipientRow({
  recipient,
  selected,
  onPress,
  styles,
  colors,
}: Readonly<{ recipient: Recipient; selected: boolean; onPress: () => void; styles: Styles; colors: ThemeColors }>) {
  let leading: React.ReactNode;
  if (recipient.kind === 'channel') {
    // A bare # (or lock), like the channel rows on Home.
    const Icon = recipient.isPrivate ? Lock : Hash;
    leading = (
      <View style={styles.rowIcon}>
        <Icon size={20} color={colors.mutedForeground} strokeWidth={2} />
      </View>
    );
  } else {
    const picture = recipient.kind === 'person' ? recipient.picture : recipient.dm.picture;
    leading = picture ? (
      <Image source={{ uri: picture }} style={styles.rowTile} />
    ) : (
      <View style={[styles.rowTile, styles.rowTileAvatar]}>
        <Text style={styles.rowTileText}>{recipient.name[0]?.toUpperCase()}</Text>
      </View>
    );
  }
  return (
    <ListRow
      leading={leading}
      title={recipient.name}
      trailing={
        <View style={[styles.check, selected && styles.checkSelected]}>
          {selected && <Check size={13} color={colors.background} strokeWidth={3} />}
        </View>
      }
      selected={selected}
      onPress={onPress}
      styles={styles}
    />
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    toRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    toLabel: { fontSize: 16, color: c.mutedForeground, lineHeight: 30 },
    toChips: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
    // Tapping a chip (or backspace in the empty field) removes it.
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      height: 30,
      maxWidth: 220,
      paddingHorizontal: 10,
      borderRadius: 9,
      backgroundColor: c.secondary,
    },
    chipText: { fontSize: 15, fontWeight: '500', color: c.text, flexShrink: 1 },
    toInput: { flexGrow: 1, minWidth: 120, height: 30, fontSize: 16, color: c.text, padding: 0 },
    // Empty after the chips: stay on their line; it wraps once typing needs room.
    toInputIdle: { minWidth: 8 },

    list: { flex: 1 },
    listContent: { paddingHorizontal: 8, paddingTop: 6, paddingBottom: 24 },
    sectionLabel: {
      fontSize: 12,
      fontWeight: '600',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: c.mutedForeground,
      paddingHorizontal: 8,
      paddingTop: 16,
      paddingBottom: 6,
    },
    loader: { marginTop: 16 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      // Same rhythm as the channel rows on Home.
      minHeight: 46,
      paddingHorizontal: 8,
      paddingVertical: 7,
      borderRadius: 12,
    },
    rowPressed: { backgroundColor: c.secondary },
    // Avatars; a channel's icon gets the same width so the names line up.
    rowTile: {
      width: 26,
      height: 26,
      borderRadius: 9,
      backgroundColor: c.secondary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowIcon: { width: 26, alignItems: 'center', justifyContent: 'center' },
    rowTileAvatar: { backgroundColor: BRAND },
    rowTileText: { fontSize: 12, fontWeight: '600', color: '#fff' },
    rowTitle: { flex: 1, minWidth: 0, fontSize: 16, color: c.text },
    // Always there, so it is clear every row can be picked.
    check: {
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 1.5,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkSelected: { backgroundColor: c.text, borderColor: c.text },
    empty: { fontSize: 15, color: c.mutedForeground, textAlign: 'center', marginTop: 32, paddingHorizontal: 24 },

    error: { fontSize: 13, color: c.destructive, marginHorizontal: 20, marginBottom: 6 },
  });
