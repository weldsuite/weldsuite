/**
 * One visual in an agent's reply (ADR AGENT-017): a chart, stat tiles, a
 * table or record cards, with Expand (full screen) and Share (the data as
 * CSV). Tapping a bar, slice, tile or row puts a follow-up in the composer.
 */

import { useState, type ReactNode } from 'react';
import { Linking, Modal, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { Maximize2, Share2, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { platformUrl } from '@weldsuite/mobile-platform/api';
import {
  formatVisualChange,
  formatVisualNumber,
  formatVisualValue,
  visualTitle,
  visualToCsv,
  type ChatVisual as ChatVisualSpec,
  type RecordsVisual,
  type StatsVisual,
  type TableCell,
  type TableVisual,
} from '@weldsuite/app-api-client/schemas/chat-visuals';
import { recordPagePath } from '@weldsuite/app-api-client/schemas/record-links';
import { KpiCard, KpiGrid } from '@/components/kpi';
import { RecordRow } from '@/components/record-row';
import { useI18n } from '@/lib/i18n';
import { VisualChart } from './VisualChart';

const INLINE_ROWS = 8;

function Stats({ visual, locale, onAsk }: Readonly<{ visual: StatsVisual; locale: string; onAsk?: (label: string, value: string) => void }>) {
  return (
    <KpiGrid>
      {visual.items.map((item, i) => {
        const value = formatVisualValue(item.value, item.format, locale);
        const change = item.change === undefined ? '' : formatVisualChange(item.change, locale);
        const sub = [change, item.changeLabel].filter(Boolean).join(' ');
        return (
          <KpiCard
            key={`${item.label}-${i}`}
            label={item.label}
            value={value}
            sub={sub || undefined}
            warn={item.change !== undefined && (item.positiveIsGood === false ? item.change > 0 : item.change < 0)}
            onPress={onAsk ? () => onAsk(item.label, value) : undefined}
          />
        );
      })}
    </KpiGrid>
  );
}

function rowLabel(row: TableCell[]): string {
  return row
    .filter((cell) => cell !== null && cell !== '')
    .slice(0, 3)
    .map(String)
    .join(' · ');
}

function Table({
  visual,
  locale,
  expanded,
  onAsk,
}: Readonly<{ visual: TableVisual; locale: string; expanded: boolean; onAsk?: (label: string) => void }>) {
  const { colors } = useTheme();
  const rows = expanded ? visual.rows : visual.rows.slice(0, INLINE_ROWS);
  const numeric = visual.columns.map((_, c) => visual.rows.every((row) => row[c] === null || typeof row[c] === 'number'));
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View>
        <View style={[styles.tableRow, { borderBottomColor: colors.border, backgroundColor: colors.secondary }]}>
          {visual.columns.map((column, c) => (
            <Text
              key={`${column.label}-${c}`}
              style={[styles.cell, styles.headCell, { color: colors.mutedForeground }, numeric[c] && styles.numeric]}
              numberOfLines={1}
            >
              {column.label}
            </Text>
          ))}
        </View>
        {rows.map((row, r) => (
          <Pressable
            key={`${r}-${row.map(String).join('|').slice(0, 60)}`}
            onPress={onAsk ? () => onAsk(rowLabel(row)) : undefined}
            style={[styles.tableRow, { borderBottomColor: colors.border }]}
          >
            {visual.columns.map((column, c) => (
              <Text
                key={`${column.label}-${c}`}
                style={[styles.cell, { color: colors.text }, numeric[c] && styles.numeric]}
                numberOfLines={2}
              >
                {formatVisualValue(row[c], column.format, locale)}
              </Text>
            ))}
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

function Records({ visual }: Readonly<{ visual: RecordsVisual }>) {
  return (
    <View>
      {visual.items.map((item) => {
        const path = recordPagePath(item.entityType, item.id);
        const meta = (item.fields ?? []).map((f) => `${f.label} ${f.value}`).join(' · ');
        return (
          <RecordRow
            key={`${item.entityType}:${item.id}`}
            title={item.label}
            subtitle={item.subtitle}
            meta={meta || undefined}
            badge={item.status ? <Text>{item.status}</Text> : undefined}
            onPress={path ? () => void Linking.openURL(`${platformUrl()}${path}`) : undefined}
          />
        );
      })}
    </View>
  );
}

function Body({
  visual,
  expanded,
  onAsk,
}: Readonly<{ visual: ChatVisualSpec; expanded: boolean; onAsk?: (label: string, value?: string) => void }>) {
  const { t, intlLocale } = useI18n();
  switch (visual.type) {
    case 'chart':
      return (
        <VisualChart
          visual={visual}
          locale={intlLocale}
          otherLabel={t.visuals.other}
          height={expanded ? 320 : 200}
          onPick={
            onAsk
              ? (pick) =>
                  onAsk(pick.label, pick.value === undefined ? undefined : formatVisualNumber(pick.value, visual.format, intlLocale))
              : undefined
          }
        />
      );
    case 'stats':
      return <Stats visual={visual} locale={intlLocale} onAsk={onAsk} />;
    case 'table':
      return <Table visual={visual} locale={intlLocale} expanded={expanded} onAsk={onAsk} />;
    case 'records':
      return <Records visual={visual} />;
    default:
      return null;
  }
}

export function ChatVisual({ visual, onAsk }: Readonly<{ visual: ChatVisualSpec; onAsk?: (prompt: string) => void }>) {
  const { colors } = useTheme();
  const { t, format } = useI18n();
  const insets = useSafeAreaInsets();
  const [expanded, setExpanded] = useState(false);
  const title = visualTitle(visual) || t.visuals.kinds[visual.type];
  const description = visual.type === 'chart' ? visual.description : undefined;
  const caption = visual.type === 'chart' ? visual.caption : undefined;

  const ask = onAsk
    ? (label: string, value?: string) => {
        setExpanded(false);
        onAsk(
          value
            ? format(t.visuals.askPromptValue, { label, value, title })
            : format(t.visuals.askPrompt, { label, title }),
        );
      }
    : undefined;

  const share = () => {
    void Share.share({ title, message: visualToCsv(visual, t.visuals.csv) });
  };

  const iconButton = (label: string, onPress: () => void, icon: ReactNode) => (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={8} style={styles.iconButton}>
      {icon}
    </Pressable>
  );

  const header = (
    <View style={styles.header}>
      <View style={styles.headerText}>
        <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
        {description ? <Text style={[styles.description, { color: colors.mutedForeground }]}>{description}</Text> : null}
      </View>
      <View style={styles.actions}>
        {iconButton(t.visuals.share, share, <Share2 size={16} color={colors.mutedForeground} />)}
        {iconButton(t.visuals.expand, () => setExpanded(true), <Maximize2 size={16} color={colors.mutedForeground} />)}
      </View>
    </View>
  );

  return (
    <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.card }]}>
      {header}
      <Body visual={visual} expanded={false} onAsk={ask} />
      {visual.type === 'table' && visual.rows.length > INLINE_ROWS ? (
        <Pressable onPress={() => setExpanded(true)} accessibilityRole="button" style={styles.more}>
          <Text style={[styles.moreText, { color: colors.mutedForeground }]}>
            {format(t.visuals.showAllRows, { count: visual.rows.length })}
          </Text>
        </Pressable>
      ) : null}
      {caption ? <Text style={[styles.caption, { color: colors.mutedForeground }]}>{caption}</Text> : null}

      <Modal visible={expanded} animationType="slide" onRequestClose={() => setExpanded(false)}>
        <View style={[styles.modal, { backgroundColor: colors.background, paddingTop: insets.top + 8 }]}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>{title}</Text>
              {description ? <Text style={[styles.description, { color: colors.mutedForeground }]}>{description}</Text> : null}
            </View>
            {iconButton(t.visuals.close, () => setExpanded(false), <X size={20} color={colors.text} />)}
          </View>
          <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
            <Body visual={visual} expanded onAsk={ask} />
            {caption ? <Text style={[styles.caption, { color: colors.mutedForeground }]}>{caption}</Text> : null}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { alignSelf: 'stretch', borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 12, gap: 8 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  headerText: { flex: 1, gap: 2 },
  title: { fontSize: 15, fontWeight: '600', lineHeight: 20 },
  modalTitle: { fontSize: 18, fontWeight: '600', lineHeight: 24 },
  description: { fontSize: 13, lineHeight: 18 },
  actions: { flexDirection: 'row', gap: 4 },
  iconButton: { padding: 4 },
  caption: { fontSize: 12, lineHeight: 16, marginTop: 4 },
  more: { paddingVertical: 4 },
  moreText: { fontSize: 13, fontWeight: '500' },
  modal: { flex: 1, paddingHorizontal: 16, gap: 12 },
  tableRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  cell: { width: 120, paddingHorizontal: 8, paddingVertical: 8, fontSize: 13 },
  headCell: { fontWeight: '600', fontSize: 12 },
  numeric: { textAlign: 'right', fontVariant: ['tabular-nums'] },
});
