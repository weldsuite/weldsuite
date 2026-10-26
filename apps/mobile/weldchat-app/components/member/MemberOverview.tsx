import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Linking, Clipboard } from 'react-native';
import {
  Briefcase,
  Clock,
  Globe,
  Link as LinkIcon,
  Mail,
  MapPin,
  Phone,
  Shield,
  Smile,
  StickyNote,
} from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { useI18n } from '@/lib/i18n';
import { PropertyRow } from './PropertyRow';
import {
  fetchMemberNote,
  formatLocalTime,
  formatTimezoneOffset,
  getRoleLabel,
  saveMemberNote,
  updateMemberProfile,
  type MemberProfile,
  type MemberProfilePatch,
  type Weekday,
} from '@/lib/member/api';

import type { ThemeColors } from '@/lib/theme-colors';

const WEEKDAYS: Weekday[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const NOTE_MAX = 1500;

/**
 * The member's Overview tab, as on the platform: one column of property rows
 * (editable for yourself or as an admin, per `profile.canEdit`), then working
 * hours, links and your private notes about this person.
 */
export function MemberOverview({
  profile,
  onProfileChange,
}: Readonly<{ profile: MemberProfile; onProfileChange: (profile: MemberProfile) => void }>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const canEdit = profile.canEdit;

  // The local time beside the timezone, refreshed every 30s.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  const localTime = formatLocalTime(now, profile.timezone);
  const tzOffset = formatTimezoneOffset(now, profile.timezone);

  const saveField = useCallback(
    async (patch: MemberProfilePatch) => {
      if (!canEdit) return;
      try {
        onProfileChange(await updateMemberProfile(profile.userId, patch));
      } catch {
        toast.error(t.member.profileSaveFailed);
      }
    },
    [canEdit, profile.userId, onProfileChange, toast, t],
  );

  const schedule = useMemo(() => {
    const wh = profile.workingHours;
    if (!wh || !WEEKDAYS.some((d) => wh[d]?.isOpen)) return null;
    return WEEKDAYS.map((d) => ({ key: d, label: t.member.weekdays[d], hours: wh[d] }));
  }, [profile.workingHours, t]);

  const copyEmail = (email: string) => {
    Clipboard.setString(email);
    toast.success(t.member.emailCopied);
  };

  return (
    <View style={styles.container}>
      <PropertyRow
        icon={Briefcase}
        label={t.member.fields.title}
        value={profile.title}
        readOnly={!canEdit}
        onSave={(v) => saveField({ title: v })}
      />
      <PropertyRow
        icon={StickyNote}
        label={t.member.fields.bio}
        value={profile.bio}
        multiline
        readOnly={!canEdit}
        onSave={(v) => saveField({ bio: v })}
      />
      <PropertyRow
        icon={Mail}
        label={t.member.fields.email}
        value={profile.email}
        readOnly
        renderValue={(v) => (
          <Pressable
            onPress={() => void Linking.openURL(`mailto:${v}`)}
            onLongPress={() => copyEmail(v)}
            accessibilityRole="link"
          >
            <Text style={styles.value} numberOfLines={1}>{v}</Text>
          </Pressable>
        )}
      />
      <PropertyRow
        icon={Phone}
        label={t.member.fields.phone}
        value={profile.phone}
        keyboardType="phone-pad"
        readOnly={!canEdit}
        onSave={(v) => saveField({ phone: v })}
        renderValue={(v) => (
          <Pressable onPress={() => void Linking.openURL(`tel:${v}`)} accessibilityRole="link">
            <Text style={styles.link}>{v}</Text>
          </Pressable>
        )}
      />
      <PropertyRow
        icon={MapPin}
        label={t.member.fields.location}
        value={profile.location}
        readOnly={!canEdit}
        onSave={(v) => saveField({ location: v })}
      />
      <PropertyRow
        icon={Smile}
        label={t.member.fields.pronouns}
        value={profile.pronouns}
        readOnly={!canEdit}
        onSave={(v) => saveField({ pronouns: v })}
      />
      <PropertyRow
        icon={Clock}
        label={t.member.fields.hoursPerWeek}
        value={profile.hoursPerWeek}
        keyboardType="decimal-pad"
        readOnly={!canEdit}
        // A number for the API; something unparseable clears the field.
        onSave={(v) => {
          const parsed = v ? Number(v.replace(',', '.')) : Number.NaN;
          void saveField({ hoursPerWeek: Number.isFinite(parsed) ? parsed : null });
        }}
      />
      <PropertyRow
        icon={Shield}
        label={t.member.fields.role}
        value={profile.role ? getRoleLabel(profile.role) : null}
        readOnly
      />
      <PropertyRow
        icon={Globe}
        label={t.member.fields.timezone}
        value={profile.timezone}
        readOnly
        renderValue={(v) => (
          <Text style={styles.value}>
            {v}
            <Text style={styles.muted}> · </Text>
            <Text style={styles.tabular}>{localTime}</Text>
            {tzOffset ? <Text style={styles.faint}> ({tzOffset})</Text> : null}
          </Text>
        )}
      />

      {schedule && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t.member.workingHours}</Text>
          {schedule.map((d) => (
            <View key={d.key} style={styles.dayRow}>
              <Text style={styles.dayLabel}>{d.label}</Text>
              {d.hours?.isOpen ? (
                <Text style={[styles.value, styles.tabular]}>
                  {d.hours.openTime ?? '—'} – {d.hours.closeTime ?? '—'}
                  {d.hours.breaks?.length ? (
                    <Text style={styles.breaks}>
                      {'  ('}
                      {d.hours.breaks.length === 1 ? t.member.breaks.one : t.member.breaks.other}{' '}
                      {d.hours.breaks.map((b) => `${b.start}–${b.end}`).join(', ')})
                    </Text>
                  ) : null}
                </Text>
              ) : (
                <Text style={styles.faintValue}>{t.member.notWorking}</Text>
              )}
            </View>
          ))}
        </View>
      )}

      {profile.links && profile.links.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t.member.links}</Text>
          {profile.links.map((link) => (
            <Pressable
              key={link.url}
              style={styles.linkRow}
              onPress={() => void Linking.openURL(link.url)}
              accessibilityRole="link"
            >
              <LinkIcon size={14} color={colors.text} strokeWidth={2} />
              <Text style={styles.value}>{link.label}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <PrivateNote userId={profile.userId} styles={styles} colors={colors} />
    </View>
  );
}

/**
 * Your own note about this person, saved 600ms after you stop typing.
 *
 * The field only becomes editable once the GET has come back successfully —
 * a failed load (network blip, 500) leaves it disabled with a retry instead
 * of a blank, editable box, so a debounced save or the unmount flush can
 * never PUT an empty draft over an existing note it failed to fetch. The API
 * never 404s for "no note yet" (it answers `data: null`, handled as a
 * successful empty load by `fetchMemberNote`), so there is no not-found case
 * to special-case here — every failure is a genuine fetch error.
 */
function PrivateNote({
  userId,
  styles,
  colors,
}: Readonly<{ userId: string; styles: Styles; colors: ThemeColors }>) {
  const { t } = useI18n();
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef('');
  // Mirrors `loaded` for the save callbacks below, which close over it from
  // effects that don't re-run on every render (the unmount flush especially).
  const loadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadFailed(false);
    loadedRef.current = false;
    fetchMemberNote(userId)
      .then((body) => {
        if (cancelled) return;
        setDraft(body);
        draftRef.current = body;
        setLoaded(true);
        loadedRef.current = true;
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, retryCount]);

  const save = useCallback(
    (body: string) => {
      if (!loadedRef.current) return;
      saveMemberNote(userId, body).catch(() => toast.error(t.member.noteSaveFailed));
    },
    [userId, toast, t],
  );

  // Flush a pending save when the screen closes, so the last words aren't
  // lost — but only once the note actually loaded, never over a failed load.
  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        if (loadedRef.current) {
          void saveMemberNote(userId, draftRef.current).catch(() => {});
        }
      }
    },
    [userId],
  );

  const onChange = (value: string) => {
    if (!loadedRef.current) return;
    setDraft(value);
    draftRef.current = value;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      save(value);
    }, 600);
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{t.member.privateNotes}</Text>
      {loadFailed ? (
        <View style={styles.noteError}>
          <Text style={styles.noteErrorText}>{t.member.noteLoadFailed}</Text>
          <Pressable onPress={() => setRetryCount((n) => n + 1)} accessibilityRole="button" hitSlop={8}>
            <Text style={styles.noteRetryText}>{t.common.retry}</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <TextInput
            value={draft}
            onChangeText={onChange}
            editable={loaded}
            maxLength={NOTE_MAX}
            multiline
            placeholder={t.member.notePlaceholder}
            placeholderTextColor={colors.mutedForeground}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            textAlignVertical="top"
            style={[styles.note, focused && styles.noteFocused]}
          />
          {focused && <Text style={styles.noteCount}>{draft.length} / {NOTE_MAX}</Text>}
        </>
      )}
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: { padding: 16, gap: 4 },
    value: { fontSize: 14, color: c.text },
    link: { fontSize: 14, color: c.primary },
    muted: { color: c.mutedForeground },
    faint: { color: c.mutedForeground, opacity: 0.7 },
    tabular: { fontVariant: ['tabular-nums'] },
    section: { paddingTop: 24 },
    sectionTitle: {
      marginBottom: 8,
      fontSize: 12,
      fontWeight: '500',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: c.mutedForeground,
    },
    dayRow: { flexDirection: 'row', alignItems: 'center', minHeight: 32, gap: 8, marginBottom: 4 },
    dayLabel: { width: 120, fontSize: 14, color: c.mutedForeground },
    breaks: { fontSize: 12, color: c.mutedForeground },
    faintValue: { fontSize: 14, color: c.mutedForeground, opacity: 0.7 },
    linkRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 24, marginBottom: 4 },
    note: {
      minHeight: 160,
      marginHorizontal: -8,
      marginTop: -6,
      paddingHorizontal: 8,
      paddingVertical: 6,
      fontSize: 14,
      lineHeight: 20,
      color: c.text,
      borderWidth: 1,
      borderColor: 'transparent',
      borderRadius: 9,
    },
    noteFocused: { borderColor: c.border },
    noteCount: { marginTop: 4, textAlign: 'right', fontSize: 12, color: c.mutedForeground },
    noteError: {
      minHeight: 160,
      marginHorizontal: -8,
      marginTop: -6,
      paddingHorizontal: 16,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 9,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    noteErrorText: { fontSize: 13, color: c.mutedForeground, textAlign: 'center' },
    noteRetryText: { fontSize: 13, fontWeight: '600', color: c.primary },
  });
