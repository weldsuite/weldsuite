import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import {
  Box,
  Briefcase,
  Building2,
  Calendar,
  CheckSquare,
  ChevronDown,
  FileText,
  FolderKanban,
  Mail,
  Package,
  ShoppingCart,
  SquareActivity,
  Tag,
  Ticket,
  User,
} from 'lucide-react-native';
import { differenceInHours, differenceInMinutes, format, isToday, isYesterday } from 'date-fns';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { asText } from '@weldsuite/text';
import { useI18n } from '@/lib/i18n';
import { PanelEmptyState } from './PropertyRow';
import { fetchMemberActivity, type MemberActivityItem } from '@/lib/member/api';

import type { Translations } from '@/lib/i18n';
import type { ThemeColors } from '@/lib/theme-colors';

/*
 * The member's Activity tab: a port of the platform's timeline. Each day is a
 * list of events on a thin rail — a round icon marker, a sentence ("Daniel
 * created 4 × Project") with the time, and a card per record underneath.
 * Cards for edits show which fields changed and open to before → after.
 */

type IconType = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
type ActivityStrings = Translations['member']['activity'];

// Icon per record type, matched on a keyword. `project_task` is a task, so the
// generic `project` match comes last.
const ENTITY_ICONS: [string[], IconType][] = [
  [['task', 'checklist'], CheckSquare],
  [['label', 'tag'], Tag],
  [['member', 'user', 'person', 'contact', 'customer'], User],
  [['company', 'account', 'organization'], Building2],
  [['deal', 'opportunity', 'lead'], Briefcase],
  [['ticket', 'conversation'], Ticket],
  [['email', 'message'], Mail],
  [['meeting', 'session', 'event'], Calendar],
  [['page', 'document', 'note'], FileText],
  [['order'], ShoppingCart],
  [['product'], Package],
  [['project'], FolderKanban],
];

function entityIcon(entityType: string): IconType {
  const key = entityType.toLowerCase();
  return ENTITY_ICONS.find(([keywords]) => keywords.some((k) => key.includes(k)))?.[1] ?? Box;
}

function sentenceCase(raw: string): string {
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Task", "Company", … from `personal_task`, `company`, … */
function entityTypeLabel(entityType: string): string {
  const key = entityType.toLowerCase();
  const last = key.split(/[_-]/).pop() ?? key;
  return sentenceCase(last);
}

const ACTION_KEYS: Record<string, keyof ActivityStrings['actions']> = {
  created: 'created',
  updated: 'updated',
  deleted: 'deleted',
  archived: 'archived',
  status_changed: 'statusChanged',
  assigned: 'assigned',
  escalated: 'escalated',
  priority_changed: 'priorityChanged',
  added: 'added',
  removed: 'removed',
};

function actionLabel(action: string, a: ActivityStrings): string {
  const key = ACTION_KEYS[action];
  return key ? a.actions[key] : sentenceCase(action);
}

const QUOTED_NAME = /'([^']+)'|"([^"]+)"/;

function quotedName(description: string): string | null {
  const match = QUOTED_NAME.exec(description);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length > 0 ? value.map((v) => formatValue(v)).join(', ') : '—';
  if (typeof value === 'object') {
    const pairs = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k}: ${formatValue(v)}`);
    return pairs.length > 0 ? pairs.join(', ') : '—';
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return format(date, 'MMM d, yyyy');
  }
  return asText(value);
}

function eventAction(entry: MemberActivityItem): string {
  if (entry.action !== 'created' && entry.changes && Object.keys(entry.changes).length > 0) return 'updated';
  return entry.action;
}

interface RecordCard {
  key: string;
  title: string;
  recordCount: number;
  entries: MemberActivityItem[];
}

interface TimelineEvent {
  key: string;
  action: string;
  entityType: string;
  cards: RecordCard[];
  latest: MemberActivityItem;
  recordCount: number;
}

function buildTimeline(entries: MemberActivityItem[], names: Map<string, string>): TimelineEvent[] {
  const events = new Map<string, TimelineEvent & { cardIds: Map<string, Set<string>>; ids: Set<string> }>();
  for (const entry of entries) {
    const action = eventAction(entry);
    const eventKey = `${action}:${entry.entityType}`;
    let event = events.get(eventKey);
    if (!event) {
      event = {
        key: eventKey,
        action,
        entityType: entry.entityType,
        cards: [],
        latest: entry,
        recordCount: 0,
        cardIds: new Map(),
        ids: new Set(),
      };
      events.set(eventKey, event);
    }
    const name = names.get(entry.entityId) ?? null;
    const cardKey = name ? entry.entityId : 'unnamed';
    let card = event.cards.find((c) => c.key === cardKey);
    if (!card) {
      card = { key: cardKey, title: name ?? entityTypeLabel(entry.entityType), recordCount: 0, entries: [] };
      event.cards.push(card);
      event.cardIds.set(cardKey, new Set());
    }
    card.entries.push(entry);
    const ids = event.cardIds.get(cardKey)!;
    ids.add(entry.entityId);
    card.recordCount = ids.size;
    event.ids.add(entry.entityId);
    event.recordCount = event.ids.size;
  }
  return Array.from(events.values());
}

function changedFields(entries: MemberActivityItem[]): string {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const field of Object.keys(entry.changes ?? {})) {
      const label = sentenceCase(field);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return Array.from(counts, ([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(' · ');
}

function smartTime(date: Date, a: ActivityStrings, format_: (s: string, v: Record<string, unknown>) => string): string {
  const now = new Date();
  const mins = differenceInMinutes(now, date);
  if (mins < 1) return a.justNow;
  if (mins < 60) return format_(a.minutesAgo, { count: mins });
  return format_(a.hoursAgo, { count: differenceInHours(now, date) });
}

export function MemberActivity({ userId, memberName }: Readonly<{ userId: string; memberName?: string }>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [items, setItems] = useState<MemberActivityItem[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetchMemberActivity(userId)
      .then((res) => {
        if (cancelled) return;
        setItems(res);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items) {
      const name = quotedName(item.description);
      if (name && !map.has(item.entityId)) map.set(item.entityId, name);
    }
    return map;
  }, [items]);

  const days = useMemo(() => {
    const map = new Map<string, { key: string; label: string; date: Date; entries: MemberActivityItem[] }>();
    for (const it of items) {
      const d = new Date(it.createdAt);
      const key = format(d, 'yyyy-MM-dd');
      let label = format(d, 'EEEE, MMMM d');
      if (isToday(d)) label = t.member.activity.today;
      else if (isYesterday(d)) label = t.member.activity.yesterday;
      const bucket = map.get(key) ?? { key, label, date: d, entries: [] };
      bucket.entries.push(it);
      map.set(key, bucket);
    }
    return Array.from(map.values()).sort((a, b) => b.date.getTime() - a.date.getTime());
  }, [items, t]);

  if (state === 'loading') return <ActivityIndicator style={styles.loading} color={colors.mutedForeground} />;
  if (state === 'error') {
    return (
      <PanelEmptyState
        icon={<SquareActivity size={20} color={colors.destructive} />}
        title={t.member.activity.loadFailedTitle}
        description={t.member.activity.loadFailedDescription}
      />
    );
  }
  if (items.length === 0) {
    return (
      <PanelEmptyState
        icon={<SquareActivity size={20} color={colors.mutedForeground} />}
        title={t.member.activity.emptyTitle}
        description={t.member.activity.emptyDescription}
      />
    );
  }

  return (
    <View style={styles.container}>
      {days.map((day) => {
        const events = buildTimeline(day.entries, names);
        return (
          <View key={day.key}>
            <Text style={styles.dayLabel}>{day.label}</Text>
            {events.map((event, index) => (
              <TimelineRow
                key={event.key}
                event={event}
                memberName={memberName}
                isLast={index === events.length - 1}
                styles={styles}
                colors={colors}
              />
            ))}
          </View>
        );
      })}
    </View>
  );
}

function TimelineRow({
  event,
  memberName,
  isLast,
  styles,
  colors,
}: Readonly<{ event: TimelineEvent; memberName?: string; isLast: boolean; styles: Styles; colors: ThemeColors }>) {
  const { t, format: fmt } = useI18n();
  const Icon = entityIcon(event.entityType);
  const latest = new Date(event.latest.createdAt);
  const typeLabel = entityTypeLabel(event.entityType);
  // A card for never-named records would only repeat the sentence, unless it
  // has changed fields to show.
  const cards = event.cards.filter((card) => card.key !== 'unnamed' || changedFields(card.entries) !== '');
  const entryCount = event.cards.reduce((n, card) => n + card.entries.length, 0);
  const repeats = cards.length === 0 && entryCount > event.recordCount ? entryCount : 0;

  return (
    <View style={[styles.event, !isLast && styles.eventSpaced]}>
      {!isLast && <View style={styles.rail} />}
      <View style={styles.marker}>
        <Icon size={12} color={colors.mutedForeground} strokeWidth={2} />
      </View>
      <View style={styles.eventHead}>
        <Text style={styles.sentence}>
          {memberName ? <Text style={styles.fg}>{memberName} </Text> : null}
          {actionLabel(event.action, t.member.activity).toLowerCase()}{' '}
          <Text style={styles.fgStrong}>
            {event.recordCount > 1 ? `${event.recordCount} × ${typeLabel}` : typeLabel}
          </Text>
          {repeats > 0 ? <Text style={styles.chipInline}>  ×{repeats}</Text> : null}
        </Text>
        <Text style={styles.time}>
          {isToday(latest) ? smartTime(latest, t.member.activity, fmt) : format(latest, 'HH:mm')}
        </Text>
      </View>
      {cards.length > 0 && (
        <View style={styles.cards}>
          {cards.map((card) => (
            <RecordCardRow key={card.key} card={card} entityType={event.entityType} styles={styles} colors={colors} />
          ))}
        </View>
      )}
    </View>
  );
}

function RecordCardRow({
  card,
  entityType,
  styles,
  colors,
}: Readonly<{ card: RecordCard; entityType: string; styles: Styles; colors: ThemeColors }>) {
  const [open, setOpen] = useState(false);
  const Icon = entityIcon(entityType);
  const fields = changedFields(card.entries);
  const withChanges = card.entries.filter((e) => e.changes && Object.keys(e.changes).length > 0);
  const expandable = withChanges.length > 0;
  const repeats = fields ? 0 : card.entries.length / Math.max(card.recordCount, 1);

  return (
    <View style={styles.card}>
      <Pressable
        style={styles.cardRow}
        onPress={expandable ? () => setOpen((v) => !v) : undefined}
        disabled={!expandable}
        accessibilityRole={expandable ? 'button' : undefined}
        accessibilityState={expandable ? { expanded: open } : undefined}
      >
        <Icon size={16} color={colors.mutedForeground} strokeWidth={2} />
        <Text style={styles.cardTitle} numberOfLines={1}>{card.title}</Text>
        {card.recordCount > 1 && <CountChip styles={styles}>×{card.recordCount}</CountChip>}
        {repeats > 1 && card.recordCount <= 1 && <CountChip styles={styles}>×{repeats}</CountChip>}
        {fields ? <Text style={styles.cardFields} numberOfLines={1}>{fields}</Text> : null}
        {expandable && (
          <ChevronDown
            size={14}
            color={colors.mutedForeground}
            style={open ? styles.chevronOpen : undefined}
          />
        )}
      </Pressable>
      {open && expandable && (
        <View style={styles.changes}>
          {withChanges.flatMap((entry) =>
            Object.entries(entry.changes ?? {}).map(([key, { from, to }]) => (
              <View key={`${entry.id}:${key}`}>
                <View style={styles.changeHead}>
                  <Text style={styles.changeField}>{sentenceCase(key)}</Text>
                  <Text style={styles.changeTime}>{format(new Date(entry.createdAt), 'HH:mm')}</Text>
                </View>
                <Text style={styles.changeValues}>
                  <Text style={styles.changeFrom}>{formatValue(from)}</Text>
                  {' → '}
                  <Text style={styles.changeTo}>{formatValue(to)}</Text>
                </Text>
              </View>
            )),
          )}
        </View>
      )}
    </View>
  );
}

function CountChip({ children, styles }: Readonly<{ children: React.ReactNode; styles: Styles }>) {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText}>{children}</Text>
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: { padding: 16, gap: 24 },
    loading: { paddingVertical: 48 },
    dayLabel: { marginBottom: 12, fontSize: 13, lineHeight: 20, color: c.mutedForeground },
    event: { position: 'relative', paddingLeft: 36 },
    eventSpaced: { paddingBottom: 20 },
    rail: { position: 'absolute', left: 11.5, top: 28, bottom: 0, width: StyleSheet.hairlineWidth * 2, backgroundColor: c.border },
    marker: {
      position: 'absolute',
      left: 0,
      top: 0,
      width: 24,
      height: 24,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth * 2,
      borderColor: c.border,
      backgroundColor: c.secondary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    eventHead: { minHeight: 24, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
    sentence: { flex: 1, fontSize: 13, lineHeight: 24, color: c.mutedForeground },
    fg: { color: c.text },
    fgStrong: { color: c.text, fontWeight: '500' },
    chipInline: { fontSize: 10, fontFamily: 'Menlo', color: c.mutedForeground },
    time: { fontSize: 12, lineHeight: 24, color: c.mutedForeground, fontVariant: ['tabular-nums'] },
    cards: { marginTop: 6, gap: 6 },
    card: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: c.border, backgroundColor: `${c.secondary}80` },
    cardRow: { height: 36, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12 },
    cardTitle: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: '500', color: c.text },
    cardFields: { maxWidth: '55%', fontSize: 12, color: c.mutedForeground },
    chevronOpen: { transform: [{ rotate: '180deg' }] },
    changes: {
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth * 2,
      borderTopColor: c.border,
    },
    changeHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
    changeField: { flex: 1, fontSize: 12, lineHeight: 20, color: c.text },
    changeTime: { fontSize: 12, color: c.mutedForeground, fontVariant: ['tabular-nums'] },
    changeValues: { fontSize: 12, lineHeight: 20, color: c.mutedForeground },
    changeFrom: { textDecorationLine: 'line-through' },
    changeTo: { color: c.text, opacity: 0.8 },
    chip: {
      minWidth: 17,
      height: 17,
      paddingHorizontal: 4,
      borderRadius: 5,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      backgroundColor: c.secondary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    chipText: { fontSize: 10, fontFamily: 'Menlo', color: c.mutedForeground },
  });
