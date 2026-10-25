import { useState, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Keyboard,
  useWindowDimensions,
} from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Image } from 'expo-image';
import { Hash, Lock, Check } from 'lucide-react-native';
import { useAuth, useOrganization } from '@clerk/expo';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { isApiError } from '@weldsuite/api-client/client';
import { BRAND } from '@/lib/brand';
import { useI18n } from '@/lib/i18n';
import { SearchField } from '@/components/chat/SearchField';
import { SheetHeader } from '@/components/ui/SheetHeader';

import type { ThemeColors } from '@/lib/theme-colors';

import { appApi } from '@/services/app-api';

interface Section {
  id: string;
  name: string;
  position: number;
}

interface WorkspaceMember {
  userId: string;
  name: string | null;
  email: string | null;
  picture: string | null;
}

type Visibility = 'public' | 'private';
type Styles = ReturnType<typeof makeStyles>;

/** Slack's limit; long names get cut off in every list anyway. */
const NAME_MAX = 80;
/** Sliding from one step to the next. */
const STEP_TIMING = { duration: 300, easing: Easing.bezier(0.25, 0.1, 0.25, 1) };

/** Channel names are lowercase words joined by dashes, like the platform's. */
function toChannelName(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, NAME_MAX);
}

/**
 * Create a channel the way Slack does on mobile, one thing per step: the name,
 * then public or private (and the category on Home), then, for a private
 * channel, who is in it. A public channel already includes everyone.
 */
export default function NewChannelScreen() {
  const { t, format } = useI18n();
  // A category to pre-select, e.g. from a section's long-press sheet on Home.
  const params = useLocalSearchParams<{ sectionId?: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const { userId } = useAuth();
  const { organization } = useOrganization();
  const { width } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const nameInputRef = useRef<TextInput>(null);

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [sectionId, setSectionId] = useState<string | undefined>(
    typeof params.sectionId === 'string' ? params.sectionId : undefined,
  );
  const [sections, setSections] = useState<Section[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const page = useSharedValue(0);
  const pagerStyle = useAnimatedStyle(() => ({ transform: [{ translateX: -page.value * width }] }));

  useEffect(() => {
    appApi.chatSections
      .list()
      .then((res) => setSections((res.data || []) as unknown as Section[]))
      .catch((err) => console.error(err));
    appApi.chatMembers
      .list()
      .then((res) => setMembers((res.data || []) as unknown as WorkspaceMember[]))
      .catch((err) => console.error(err))
      .finally(() => setMembersLoading(false));
  }, []);

  // A dash typed last ("marketing-") is dropped on create, not while typing.
  const finalName = name.replace(/^-+|-+$/g, '');
  const isPrivate = visibility === 'private';
  const lastStep = isPrivate ? 2 : 1;

  const goTo = (next: number) => {
    Keyboard.dismiss();
    setStep(next);
    page.value = withTiming(next, STEP_TIMING);
    if (next === 0) setTimeout(() => nameInputRef.current?.focus(), STEP_TIMING.duration);
  };

  const people = useMemo(() => {
    const others = members.filter((m) => m.userId !== userId);
    const q = query.trim().toLowerCase();
    if (!q) return others;
    return others.filter((m) => m.name?.toLowerCase().includes(q) || m.email?.toLowerCase().includes(q));
  }, [members, query, userId]);

  const togglePerson = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));

  const handleCreate = async () => {
    if (!finalName || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await appApi.channels.create({
        name: finalName,
        type: visibility,
        ...(sectionId ? { sectionId } : {}),
        ...(isPrivate && selected.length > 0 ? { memberIds: selected } : {}),
      });
      if (res.data?.id) {
        router.dismiss();
        router.push(`/channel/${res.data.id}`);
      }
    } catch (err) {
      const taken = isApiError(err) && err.status === 409;
      setError(taken ? t.newChannel.nameTaken : t.newChannel.createFailed);
      setCreating(false);
      // The name is what has to change: back to it.
      if (taken) goTo(0);
    }
  };

  const titles = [t.newChannel.title, t.newChannel.visibilityLabel, t.newChannel.peopleTitle];
  const canContinue = step === 0 ? finalName.length > 0 : !creating;
  const onPrimary = () => {
    if (!canContinue) return;
    if (step < lastStep) goTo(step + 1);
    else void handleCreate();
  };
  let primaryLabel = t.newChannel.next;
  if (step === lastStep) {
    primaryLabel =
      isPrivate && selected.length > 0
        ? format(t.newChannel.createWithCount, { count: selected.length })
        : t.newChannel.create;
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <SheetHeader
          title={titles[step]}
          leading={step === 0 ? 'close' : 'back'}
          onLeadingPress={step === 0 ? () => router.back() : () => goTo(step - 1)}
          leadingLabel={step === 0 ? t.newChannel.close : t.common.back}
          action={{ label: primaryLabel, onPress: onPrimary, disabled: !canContinue, loading: creating }}
        />

        <View style={styles.viewport}>
          <Animated.View style={[styles.pager, { width: width * 3 }, pagerStyle]}>
            {/* 1. Name */}
            <ScrollView
              style={{ width }}
              contentContainerStyle={styles.page}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <Text style={styles.label}>{t.newChannel.nameLabel}</Text>
              <Pressable
                style={[styles.nameField, error && step === 0 && styles.nameFieldError]}
                onPress={() => nameInputRef.current?.focus()}
              >
                {isPrivate ? (
                  <Lock size={17} color={colors.muted} strokeWidth={2.2} />
                ) : (
                  <Hash size={18} color={colors.muted} strokeWidth={2.2} />
                )}
                <TextInput
                  ref={nameInputRef}
                  style={styles.nameInput}
                  value={name}
                  onChangeText={(text) => {
                    setName(toChannelName(text));
                    setError(null);
                  }}
                  placeholder={t.newChannel.namePlaceholder}
                  placeholderTextColor={colors.muted}
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="next"
                  onSubmitEditing={onPrimary}
                  maxLength={NAME_MAX}
                />
                <Text style={styles.counter}>{NAME_MAX - name.length}</Text>
              </Pressable>
              {error && step === 0 ? (
                <Text style={[styles.hint, styles.hintError]}>{error}</Text>
              ) : (
                <Text style={styles.hint}>{t.newChannel.nameHint}</Text>
              )}
            </ScrollView>

            {/* 2. Public or private, and where it sits on Home */}
            <ScrollView style={{ width }} contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
              <View style={styles.optionList}>
                <OptionRow
                  icon={<Hash size={18} color={colors.text} strokeWidth={2.1} />}
                  title={t.newChannel.publicTitle}
                  hint={format(t.newChannel.publicHint, {
                    workspace: organization?.name || t.home.workspaceFallback,
                  })}
                  selected={!isPrivate}
                  onPress={() => setVisibility('public')}
                  styles={styles}
                  colors={colors}
                />
                <View style={styles.optionDivider} />
                <OptionRow
                  icon={<Lock size={17} color={colors.text} strokeWidth={2.1} />}
                  title={t.newChannel.privateTitle}
                  hint={t.newChannel.privateHint}
                  selected={isPrivate}
                  onPress={() => setVisibility('private')}
                  styles={styles}
                  colors={colors}
                />
              </View>

              {sections.length > 0 && (
                <>
                  <Text style={[styles.label, styles.labelSpaced]}>{t.newChannel.categoryLabel}</Text>
                  <View style={styles.chips}>
                    <Chip
                      label={t.newChannel.noCategory}
                      selected={!sectionId}
                      onPress={() => setSectionId(undefined)}
                      styles={styles}
                    />
                    {sections.map((sec) => (
                      <Chip
                        key={sec.id}
                        label={sec.name}
                        selected={sectionId === sec.id}
                        onPress={() => setSectionId(sec.id)}
                        styles={styles}
                      />
                    ))}
                  </View>
                  <Text style={styles.hint}>{t.newChannel.categoryHint}</Text>
                </>
              )}
              {error && step === 1 && <Text style={[styles.hint, styles.hintError]}>{error}</Text>}
            </ScrollView>

            {/* 3. Who is in a private channel */}
            <View style={{ width }}>
              <SearchField
                placeholder={t.newChannel.peopleSearch}
                value={query}
                onChangeText={setQuery}
                onClear={() => setQuery('')}
                style={styles.search}
              />
              <Text style={styles.peopleHint}>
                {format(t.newChannel.peopleHint, { name: finalName || t.newChannel.namePlaceholder })}
              </Text>
              {error && step === 2 && <Text style={[styles.peopleHint, styles.hintError]}>{error}</Text>}
              {membersLoading ? (
                <ActivityIndicator style={styles.loader} color={colors.mutedForeground} />
              ) : (
                <ScrollView
                  contentContainerStyle={styles.peopleList}
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode="on-drag"
                  showsVerticalScrollIndicator={false}
                >
                  {people.map((m) => (
                    <PersonRow
                      key={m.userId}
                      member={m}
                      selected={selected.includes(m.userId)}
                      onPress={() => togglePerson(m.userId)}
                      styles={styles}
                      colors={colors}
                    />
                  ))}
                  {people.length === 0 && <Text style={styles.empty}>{t.newChannel.noPeople}</Text>}
                </ScrollView>
              )}
            </View>
          </Animated.View>
        </View>
      </View>
    </>
  );
}

function OptionRow({
  icon,
  title,
  hint,
  selected,
  onPress,
  styles,
  colors,
}: Readonly<{
  icon: React.ReactNode;
  title: string;
  hint: string;
  selected: boolean;
  onPress: () => void;
  styles: Styles;
  colors: ThemeColors;
}>) {
  return (
    <Pressable
      style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
    >
      <View style={styles.optionIcon}>{icon}</View>
      <View style={styles.optionText}>
        <Text style={styles.optionTitle}>{title}</Text>
        <Text style={styles.optionHint}>{hint}</Text>
      </View>
      <View style={[styles.radio, selected && styles.radioSelected]}>
        {selected && <Check size={13} color={colors.background} strokeWidth={3} />}
      </View>
    </Pressable>
  );
}

function PersonRow({
  member,
  selected,
  onPress,
  styles,
  colors,
}: Readonly<{ member: WorkspaceMember; selected: boolean; onPress: () => void; styles: Styles; colors: ThemeColors }>) {
  const label = member.name || member.email || '?';
  return (
    <Pressable
      style={({ pressed }) => [styles.person, pressed && styles.optionPressed]}
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
    >
      {member.picture ? (
        <Image source={{ uri: member.picture }} style={styles.avatar} />
      ) : (
        <View style={[styles.avatar, styles.avatarFallback]}>
          <Text style={styles.avatarText}>{label[0]?.toUpperCase()}</Text>
        </View>
      )}
      <View style={styles.optionText}>
        <Text style={styles.personName} numberOfLines={1}>{label}</Text>
        {member.name && member.email ? (
          <Text style={styles.personEmail} numberOfLines={1}>{member.email}</Text>
        ) : null}
      </View>
      <View style={[styles.radio, selected && styles.radioSelected]}>
        {selected && <Check size={13} color={colors.background} strokeWidth={3} />}
      </View>
    </Pressable>
  );
}

function Chip({
  label,
  selected,
  onPress,
  styles,
}: Readonly<{ label: string; selected: boolean; onPress: () => void; styles: Styles }>) {
  return (
    <Pressable
      style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && !selected && styles.chipPressed]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    viewport: { flex: 1, overflow: 'hidden' },
    pager: { flex: 1, flexDirection: 'row' },
    page: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 40 },

    label: {
      fontSize: 13,
      fontWeight: '600',
      letterSpacing: 0.4,
      textTransform: 'uppercase',
      color: c.mutedForeground,
      marginBottom: 8,
    },
    labelSpaced: { marginTop: 24 },
    hint: { fontSize: 14, lineHeight: 20, color: c.mutedForeground, marginTop: 10 },
    hintError: { color: c.destructive },

    // The name: a gray field like the search bar, sized like every other input.
    nameField: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      height: 48,
      paddingHorizontal: 14,
      borderRadius: 14,
      borderCurve: 'continuous',
      borderWidth: 1,
      borderColor: 'transparent',
      backgroundColor: c.inputBackground,
    },
    nameFieldError: { borderColor: c.destructive },
    nameInput: { flex: 1, height: '100%', fontSize: 17, color: c.text, padding: 0 },
    counter: { fontSize: 14, color: c.muted, fontVariant: ['tabular-nums'] },

    optionList: {
      borderRadius: 16,
      borderCurve: 'continuous',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      overflow: 'hidden',
    },
    option: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 13 },
    optionPressed: { backgroundColor: c.secondary },
    optionDivider: { height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: 62 },
    optionIcon: {
      width: 36,
      height: 36,
      borderRadius: 11,
      borderCurve: 'continuous',
      backgroundColor: c.secondary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    optionText: { flex: 1, minWidth: 0 },
    optionTitle: { fontSize: 16, fontWeight: '600', color: c.text },
    optionHint: { fontSize: 14, lineHeight: 19, color: c.mutedForeground, marginTop: 2 },
    radio: {
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 1.5,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    radioSelected: { backgroundColor: c.text, borderColor: c.text },

    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
      height: 34,
      paddingHorizontal: 14,
      borderRadius: 18,
      backgroundColor: c.secondary,
      justifyContent: 'center',
      maxWidth: '100%',
    },
    chipPressed: { opacity: 0.6 },
    chipSelected: { backgroundColor: c.text },
    chipText: { fontSize: 15, fontWeight: '500', color: c.text },
    chipTextSelected: { color: c.background },

    search: { marginHorizontal: 16, marginTop: 16 },
    peopleHint: { fontSize: 14, lineHeight: 19, color: c.mutedForeground, marginHorizontal: 16, marginTop: 10 },
    loader: { marginTop: 24 },
    peopleList: { paddingHorizontal: 8, paddingTop: 8, paddingBottom: 40 },
    person: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 8,
      paddingVertical: 9,
      borderRadius: 12,
    },
    avatar: { width: 36, height: 36, borderRadius: 12 },
    avatarFallback: { backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center' },
    avatarText: { fontSize: 15, fontWeight: '600', color: '#fff' },
    personName: { fontSize: 16, color: c.text },
    personEmail: { fontSize: 13, color: c.mutedForeground, marginTop: 1 },
    empty: { fontSize: 15, color: c.mutedForeground, textAlign: 'center', marginTop: 24 },
  });
