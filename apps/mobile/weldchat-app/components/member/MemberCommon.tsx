import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Briefcase, CheckSquare, FolderKanban, Hash, LifeBuoy, Lock, UserCircle2, Users } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { plural, useI18n } from '@/lib/i18n';
import { PanelEmptyState } from './PropertyRow';
import { fetchCommonConcepts, type CommonConcepts } from '@/lib/member/api';

import type { ThemeColors } from '@/lib/theme-colors';

type Tone = 'amber' | 'emerald' | 'rose';

// Tailwind's *-100 / *-600 (light) and *-500 at 15% / *-400 (dark), as the
// platform's category icons use.
const TONES: Record<Tone, { light: [string, string]; dark: [string, string] }> = {
  amber: { light: ['#FEF3C7', '#D97706'], dark: ['rgba(245,158,11,0.15)', '#FBBF24'] },
  emerald: { light: ['#D1FAE5', '#059669'], dark: ['rgba(16,185,129,0.15)', '#34D399'] },
  rose: { light: ['#FFE4E6', '#E11D48'], dark: ['rgba(244,63,94,0.15)', '#FB7185'] },
};

// Project colours are stored as Tailwind classes ("bg-blue-500").
const PROJECT_COLORS: Record<string, string> = {
  'bg-gray-500': '#6B7280', 'bg-red-500': '#EF4444', 'bg-orange-500': '#F97316',
  'bg-amber-500': '#F59E0B', 'bg-yellow-500': '#EAB308', 'bg-lime-500': '#84CC16',
  'bg-green-500': '#22C55E', 'bg-emerald-500': '#10B981', 'bg-teal-500': '#14B8A6',
  'bg-cyan-500': '#06B6D4', 'bg-sky-500': '#0EA5E9', 'bg-blue-500': '#3B82F6',
  'bg-indigo-500': '#6366F1', 'bg-violet-500': '#8B5CF6', 'bg-purple-500': '#A855F7',
  'bg-fuchsia-500': '#D946EF', 'bg-pink-500': '#EC4899', 'bg-rose-500': '#F43F5E',
};

/** What you and this person share, as on the platform's member "Common" tab. */
export function MemberCommon({ userId, isSelf }: Readonly<{ userId: string; isSelf: boolean }>) {
  const { colors, theme } = useTheme();
  const { t } = useI18n();
  const router = useRouter();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [data, setData] = useState<CommonConcepts | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    if (isSelf) return;
    let cancelled = false;
    setState('loading');
    fetchCommonConcepts(userId)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [userId, isSelf]);

  const iconColor = colors.mutedForeground;
  if (isSelf) {
    return (
      <PanelEmptyState
        icon={<UserCircle2 size={20} color={iconColor} />}
        title={t.member.common.thatsYouTitle}
        description={t.member.common.thatsYouDescription}
      />
    );
  }
  if (state === 'loading') {
    return <ActivityIndicator style={styles.loading} color={colors.mutedForeground} />;
  }
  if (state === 'error' || !data) {
    return (
      <PanelEmptyState
        icon={<Users size={20} color={colors.destructive} />}
        title={t.member.common.loadFailedTitle}
        description={t.member.common.loadFailedDescription}
      />
    );
  }

  // Only opportunities are surfaced from CRM, as on the platform.
  const crm = data.crm.filter((r) => r.kind === 'opportunity');
  const total = data.channels.length + data.projects.length + data.tasks.length + crm.length + data.helpdesk.length;
  if (total === 0) {
    return (
      <PanelEmptyState
        icon={<Users size={20} color={iconColor} />}
        title={t.member.common.emptyTitle}
        description={t.member.common.emptyDescription}
      />
    );
  }

  const tone = (name: Tone) => TONES[name][theme === 'dark' ? 'dark' : 'light'];
  const categoryIcon = (name: Tone, Icon: typeof CheckSquare) => {
    const [bg, fg] = tone(name);
    return (
      <View style={[styles.tile, { backgroundColor: bg }]}>
        <Icon size={12} color={fg} strokeWidth={2} />
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <Section title={t.member.common.channels} count={data.channels.length} styles={styles}>
        {data.channels.map((c) => (
          <Row
            key={c.id}
            styles={styles}
            label={c.type === 'dm' ? c.name : `# ${c.name}`}
            hint={plural(c.memberCount, t.member.common.memberCount)}
            leading={channelLeading(c.type, c.name, c.memberCount, styles, colors)}
            onPress={() =>
              router.push({
                pathname: c.type === 'dm' ? '/dm/[channelId]' : '/channel/[channelId]',
                params: { channelId: c.id, name: c.name, type: c.type },
              })
            }
          />
        ))}
      </Section>

      <Section title={t.member.common.projects} count={data.projects.length} styles={styles}>
        {data.projects.map((p) => (
          <Row
            key={p.id}
            styles={styles}
            label={p.name}
            hint={p.status ?? undefined}
            leading={
              <View
                style={[styles.project, { backgroundColor: PROJECT_COLORS[p.color ?? ''] ?? PROJECT_COLORS['bg-gray-500'] }]}
              >
                <FolderKanban size={10} color="#fff" strokeWidth={2} />
              </View>
            }
          />
        ))}
      </Section>

      <Section title={t.member.common.tasks} count={data.tasks.length} styles={styles}>
        {data.tasks.map((task) => (
          <Row
            key={task.id}
            styles={styles}
            label={task.title}
            hint={task.role === 'delegated' ? `${task.status} · ${t.member.common.delegated}` : task.status}
            leading={categoryIcon('amber', CheckSquare)}
          />
        ))}
      </Section>

      <Section title={t.member.common.crm} count={crm.length} styles={styles}>
        {crm.map((r) => (
          <Row
            key={r.id}
            styles={styles}
            label={r.name}
            hint={r.status ?? r.kind}
            leading={categoryIcon('emerald', Briefcase)}
          />
        ))}
      </Section>

      <Section title={t.member.common.helpdesk} count={data.helpdesk.length} styles={styles}>
        {data.helpdesk.map((h) => (
          <Row
            key={h.id}
            styles={styles}
            label={h.subject}
            hint={h.status}
            leading={categoryIcon('rose', LifeBuoy)}
          />
        ))}
      </Section>
    </View>
  );

  function channelLeading(
    type: 'public' | 'private' | 'dm',
    name: string,
    memberCount: number,
    s: Styles,
    c: ThemeColors,
  ): ReactNode {
    if (type !== 'dm') {
      const Icon = type === 'public' ? Hash : Lock;
      return (
        <View style={[s.tile, { backgroundColor: c.secondary }]}>
          <Icon size={12} color={c.mutedForeground} strokeWidth={2} />
        </View>
      );
    }
    const initials = name.split(/[,&]+/).map((p) => p.trim()).filter(Boolean);
    if (memberCount > 2) {
      const [a, b] = [initials[0] ?? '?', initials[1] ?? initials[0] ?? '?'];
      return (
        <View style={s.group}>
          <View style={[s.groupAvatar, s.groupFront]}>
            <Text style={s.groupText}>{a[0]?.toUpperCase()}</Text>
          </View>
          <View style={[s.groupAvatar, s.groupBack]}>
            <Text style={s.groupText}>{b[0]?.toUpperCase()}</Text>
          </View>
        </View>
      );
    }
    return (
      <View style={[s.tile, { backgroundColor: c.secondary }]}>
        <Text style={s.dmText}>{(name || '?')[0]?.toUpperCase()}</Text>
      </View>
    );
  }
}

function Section({
  title,
  count,
  styles,
  children,
}: Readonly<{ title: string; count: number; styles: Styles; children: ReactNode }>) {
  if (count === 0) return null;
  return (
    <View>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <View style={styles.chip}>
          <Text style={styles.chipText}>{count}</Text>
        </View>
        <View style={styles.sectionRule} />
      </View>
      <View style={styles.rows}>{children}</View>
    </View>
  );
}

function Row({
  label,
  hint,
  leading,
  onPress,
  styles,
}: Readonly<{ label: string; hint?: string; leading?: ReactNode; onPress?: () => void; styles: Styles }>) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityRole={onPress ? 'button' : undefined}
    >
      {leading}
      <View style={styles.rowText}>
        <Text style={styles.rowLabel} numberOfLines={1}>{label}</Text>
        {hint ? <Text style={styles.rowHint} numberOfLines={1}>{capitalize(hint)}</Text> : null}
      </View>
    </Pressable>
  );
}

function capitalize(value: string): string {
  return value.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: { padding: 16, gap: 24 },
    loading: { paddingVertical: 48 },
    sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
    sectionTitle: {
      fontSize: 11,
      fontWeight: '600',
      letterSpacing: 0.9,
      textTransform: 'uppercase',
      color: c.mutedForeground,
    },
    chip: {
      minWidth: 17,
      height: 17,
      paddingHorizontal: 3,
      borderRadius: 5,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      backgroundColor: c.secondary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    chipText: { fontSize: 10, fontWeight: '500', fontFamily: 'Menlo', color: c.mutedForeground },
    sectionRule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: c.border },
    rows: { marginHorizontal: -16 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8 },
    rowPressed: { backgroundColor: c.secondary },
    rowText: { flex: 1, minWidth: 0 },
    rowLabel: { fontSize: 13, fontWeight: '500', color: c.text },
    rowHint: { fontSize: 11, color: c.mutedForeground },
    tile: { width: 20, height: 20, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
    project: { width: 18, height: 18, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
    dmText: { fontSize: 9, fontWeight: '600', color: c.mutedForeground },
    group: { width: 20, height: 20 },
    groupAvatar: {
      position: 'absolute',
      width: 13,
      height: 13,
      borderRadius: 4,
      borderWidth: 1,
      borderColor: c.background,
      backgroundColor: c.secondary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    groupFront: { top: 0, left: 0, zIndex: 1 },
    groupBack: { bottom: 0, right: 0 },
    groupText: { fontSize: 7, fontWeight: '600', color: c.mutedForeground },
  });
