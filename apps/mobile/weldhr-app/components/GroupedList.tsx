/**
 * The list Schedule lays a week out in, for every page that lists things in
 * groups (Schedule's days, Absence's requests and sick reports): each group's
 * title in bold on the left and a muted figure on the right ("Ma 26 okt
 * 0:24 | € 0,00", "Beoordeeld 6"), sticking to the top while its rows scroll
 * under it; the rows straight on the sheet; a line between two groups; and
 * a bold total under the last. One place, so a change shows on every page.
 *
 * The groups must be direct children of the screen's content (Sticky.tsx).
 */

import { Fragment, type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';

import { usePalette } from '@/hooks/use-palette';
import { StickyHeader, StickySection, useStickySections, type StickySections } from './Sticky';

export interface ListGroup {
  key: string;
  /** Bold ("Ma", "Beoordeeld"), then `detail` after it in regular weight ("26 okt"). */
  title: string;
  detail?: string;
  /** On the right, muted: one figure, or several with an upright line between them. */
  figure?: string | string[];
  children: ReactNode;
}

export function GroupedList({
  groups,
  total,
}: Readonly<{ groups: ListGroup[]; total?: { label: string; value: string | string[] } }>) {
  const palette = usePalette();
  const sticky = useStickySections(groups.length, LINE + STACK_GAP);
  return (
    <>
      {groups.map((group, index) => (
        <StickySection key={group.key} sticky={sticky} index={index}>
          <GroupHeader group={group} sticky={sticky} index={index} />
          {group.children}
          <View style={[styles.divider, { backgroundColor: palette.border }]} />
        </StickySection>
      ))}
      {total ? <TotalRow label={total.label} value={total.value} /> : null}
    </>
  );
}

/** Space above a group's title, and the title's line height. */
const HEADER_TOP = 20;
const LINE = 22;
/** Between the titles of two groups stacked while one pushes the other out. */
const STACK_GAP = 6;

/** A group's title and figure; it sticks to the top while the group's rows scroll under it. */
function GroupHeader({ group, sticky, index }: Readonly<{ group: ListGroup; sticky: StickySections; index: number }>) {
  const palette = usePalette();
  return (
    <StickyHeader sticky={sticky} index={index} style={[styles.header, { backgroundColor: palette.surface }]}>
      <Text style={[styles.title, { color: palette.text }]} numberOfLines={1}>
        <Text style={styles.bold}>{group.title}</Text>
        {group.detail ? `  ${group.detail}` : null}
      </Text>
      {group.figure ? <Figures parts={group.figure} style={[styles.figure, { color: palette.muted }]} /> : null}
    </StickyHeader>
  );
}

/** The bold "Total" line under the last group. */
function TotalRow({ label, value }: Readonly<{ label: string; value: string | string[] }>) {
  const palette = usePalette();
  return (
    <View style={styles.total}>
      <Text style={[styles.title, styles.bold, { color: palette.text }]}>{label}</Text>
      <Figures parts={value} style={[styles.figure, { color: palette.muted }]} />
    </View>
  );
}

/**
 * "0:24 | € 0,00": figures side by side with an upright line between them,
 * drawn as tall as the digits; a typed "|" runs above and below them.
 */
function Figures({ parts, style }: Readonly<{ parts: string | string[]; style: StyleProp<TextStyle> }>) {
  const palette = usePalette();
  const list = (typeof parts === 'string' ? [parts] : parts).filter(Boolean);
  return (
    <View style={styles.figures}>
      {list.map((part, index) => (
        <Fragment key={part}>
          {index > 0 ? <View style={[styles.figureRule, { backgroundColor: palette.muted }]} /> : null}
          <Text style={style}>{part}</Text>
        </Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // The line between two groups sits 2pt under the last row and pulls the next group up by 6pt,
  // so its title is as far under the line as the row is above it; the first title keeps its
  // full space.
  divider: { height: StyleSheet.hairlineWidth, marginTop: 2, marginBottom: -6 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: HEADER_TOP,
    // While it sticks, rows scroll under it up to STACK_GAP below its title,
    // where the next group's title stacks; in the list it takes 4pt (the 2pt
    // more lie over the first row's padding).
    paddingBottom: STACK_GAP,
    marginBottom: 4 - STACK_GAP,
  },
  title: { flexShrink: 1, fontSize: 17, lineHeight: LINE },
  bold: { fontWeight: '700' },
  figure: { fontSize: 16, lineHeight: LINE, fontVariant: ['tabular-nums'] },
  total: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 22,
  },
  figures: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
  // The height of a 16pt digit, centred on the digits rather than the line box.
  figureRule: { width: 1, height: 11.5, marginHorizontal: 7, marginTop: 1 },
});
