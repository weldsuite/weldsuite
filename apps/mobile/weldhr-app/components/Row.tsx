/**
 * The row Shiftbase uses everywhere: a leading tile (a date, an avatar, an
 * icon), an optional coloured bar for the shift or status, a title over a
 * muted line, and up to two lines on the right. Rows sit in a `List` (full
 * width in a sheet, hairlines between and under them) or a `Card` (a rounded
 * white box, hairlines only between).
 */

import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityRole,
  type AccessibilityState,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { ChevronRight, type LucideIcon } from 'lucide-react-native';

import { usePalette } from '@/hooks/use-palette';
import { parseIsoDate } from '@/lib/dates';

export interface RowProps {
  title: string;
  /** Lines the title may wrap to before it ends in "…"; two by default, one on Expenses. */
  titleLines?: number;
  subtitle?: string | null;
  /** Lines the subtitle may wrap to (task descriptions); one by default. */
  subtitleLines?: number;
  /** Small icon after the subtitle (a paperclip for a receipt). */
  subtitleIcon?: ReactNode;
  /** Colour of the subtitle when it carries a status ("Approved" in green). */
  subtitleColor?: string;
  leading?: ReactNode;
  /**
   * The leading tile and the right column level with the title instead of in
   * the middle (announcements, whose text runs to four lines).
   */
  top?: boolean;
  /** The coloured bar between the leading tile and the text. */
  bar?: string | null;
  /** Right column, top line: a time, a date range. */
  value?: ReactNode;
  /** The value a size down, at the subtitle's 14pt (an announcement's "11m"). */
  smallValue?: boolean;
  /** Right column, second line: hours, a status. */
  detail?: ReactNode;
  detailColor?: string;
  chevron?: boolean;
  muted?: boolean;
  /**
   * Not opened yet: the row on a light blue, with a blue dot at the end of the
   * right column (with `top`, before the value on the title's line).
   */
  unread?: boolean;
  strike?: boolean;
  /** Regular weight title, for the text of an empty card ("No open requests"). */
  regular?: boolean;
  /** A link-coloured line under the title ("Add absence"). */
  link?: string;
  onPress?: () => void;
  disabled?: boolean;
  testID?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
}

export function Row({
  title,
  titleLines = 2,
  subtitle,
  subtitleLines = 1,
  subtitleIcon,
  subtitleColor,
  leading,
  top = false,
  bar,
  value,
  smallValue = false,
  detail,
  detailColor,
  chevron = false,
  muted = false,
  unread = false,
  strike = false,
  regular = false,
  link,
  onPress,
  disabled,
  testID,
  accessibilityRole = 'button',
  accessibilityState,
}: Readonly<RowProps>) {
  const palette = usePalette();

  const detailLine =
    typeof detail === 'string' ? (
      <Text style={[styles.detail, { color: detailColor ?? palette.text }]} numberOfLines={1}>
        {detail}
      </Text>
    ) : (
      detail
    );

  const valueLine =
    typeof value === 'string' ? (
      <Text style={[styles.value, smallValue && styles.valueSmall, { color: palette.text }]} numberOfLines={1}>
        {value}
      </Text>
    ) : (
      value
    );
  const dot = unread ? <View style={[styles.unreadDot, { backgroundColor: palette.badge }]} /> : null;

  const right =
    value != null || detail != null || unread ? (
      <View style={[styles.side, top && styles.sideTop]}>
        {dot && top ? (
          <View style={styles.unreadLine}>
            {dot}
            {valueLine}
          </View>
        ) : (
          valueLine
        )}
        {dot && !top ? (
          <View style={styles.unreadLine}>
            {detailLine}
            {dot}
          </View>
        ) : (
          detailLine
        )}
      </View>
    ) : null;

  const background = unread ? palette.unread : undefined;

  const content = (
    <View style={[styles.row, !onPress && { backgroundColor: background }]}>
      {leading ? <View style={[styles.leading, top && styles.leadingTop]}>{leading}</View> : null}
      {bar ? <View style={[styles.bar, { backgroundColor: bar }]} /> : null}
      <View style={[styles.main, Boolean(leading) && !bar && styles.afterLeading]}>
        <Text
          style={[
            styles.title,
            { color: muted ? palette.muted : palette.text },
            regular && styles.titleRegular,
            strike && styles.strike,
          ]}
          numberOfLines={titleLines}
        >
          {title}
        </Text>
        {subtitle ? (
          <View style={styles.subtitleRow}>
            <Text
              style={[styles.subtitle, { color: subtitleColor ?? palette.muted }]}
              numberOfLines={subtitleLines}
            >
              {subtitle}
            </Text>
            {subtitleIcon}
          </View>
        ) : null}
        {link ? <Text style={[styles.link, { color: palette.accent }]}>{link}</Text> : null}
      </View>
      {right}
      {chevron ? <ChevronRight size={20} color={palette.text} strokeWidth={2} /> : null}
    </View>
  );

  if (!onPress) return content;

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={accessibilityRole}
      accessibilityState={accessibilityState}
      accessibilityLabel={[title, subtitle, typeof value === 'string' ? value : null].filter(Boolean).join(', ')}
      style={({ pressed }) => ({ backgroundColor: pressed ? palette.tile : background })}
    >
      {content}
    </Pressable>
  );
}

function separated(children: ReactNode, divider: (key: string) => ReactNode, trailing: boolean): ReactNode[] {
  const items = Children.toArray(children).filter((child) => isValidElement(child) || typeof child === 'string');
  return items.map((child, index) => (
    <Fragment key={isValidElement(child) && child.key != null ? child.key : index}>
      {child}
      {trailing || index < items.length - 1 ? divider(`divider-${index}`) : null}
    </Fragment>
  ));
}

/** Rows straight in a sheet: full width, a hairline under each. */
export function List({ children }: Readonly<{ children: ReactNode }>) {
  const palette = usePalette();
  return (
    <View>
      {separated(children, (key) => <View key={key} style={[styles.divider, { backgroundColor: palette.border }]} />, true)}
    </View>
  );
}

/**
 * Rows in a rounded white box with a hairline border (the absence overview,
 * Profile), or `open`: no box, the rows run the page's width and line up with
 * the section title, dividers between them only (Home, the detail pages).
 */
export function Card({
  children,
  open = false,
  style,
}: Readonly<{ children: ReactNode; open?: boolean; style?: StyleProp<ViewStyle> }>) {
  const palette = usePalette();
  return (
    <View
      style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }, open && styles.open, style]}
    >
      {separated(children, (key) => <View key={key} style={[styles.divider, { backgroundColor: palette.border }]} />, false)}
    </View>
  );
}

/** A square tile with an icon: grey by default, or tinted with an area's or leave type's colour. */
export function IconTile({
  icon: Icon,
  background,
  color,
  size = 40,
}: Readonly<{ icon: LucideIcon; background?: string; color?: string; size?: number }>) {
  const palette = usePalette();
  return (
    <View
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.32),
          borderCurve: 'continuous',
          backgroundColor: background ?? palette.tile,
        },
      ]}
    >
      <Icon size={Math.round(size * 0.5)} color={color ?? palette.text} strokeWidth={1.9} />
    </View>
  );
}

/** A calendar leaf: the weekday over the day number ("SUN / 25"). */
export function DateTile({ date, locale }: Readonly<{ date: string; locale: string }>) {
  const palette = usePalette();
  const parsed = parseIsoDate(date.slice(0, 10));
  const weekday = parsed?.toLocaleDateString(locale, { weekday: 'short' }).replace('.', '') ?? '';
  return (
    <View style={[styles.tile, styles.dateTile, { backgroundColor: palette.tile }]}>
      <Text style={[styles.dateWeekday, { color: palette.muted }]}>{weekday.toUpperCase()}</Text>
      <Text style={[styles.dateDay, { color: palette.text }]}>{parsed?.getDate() ?? ''}</Text>
    </View>
  );
}

/**
 * Label on the left, value on the right: a profile detail, a balance figure.
 * `smallLabel` sets the label like a row's subtitle (the Expenses totals).
 */
export function DetailRow({
  label,
  value,
  smallLabel = false,
}: Readonly<{ label: string; value: string; smallLabel?: boolean }>) {
  const palette = usePalette();
  return (
    <View style={[styles.row, styles.detailRow]}>
      <Text
        style={[styles.detailLabel, smallLabel && styles.detailLabelSmall, { color: palette.muted }]}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Text style={[styles.detailValue, { color: palette.text }]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

/** A count in a teal pill, for menu rows with work waiting. */
export function CountBadge({ count }: Readonly<{ count: number }>) {
  const palette = usePalette();
  if (count <= 0) return null;
  return (
    <View style={[styles.count, { backgroundColor: palette.accent }]}>
      <Text style={styles.countText}>{count}</Text>
    </View>
  );
}

/** A tile's empty-state row: an icon, a line of text and, when it can be filled, a link. */
export function EmptyRow({
  icon,
  title,
  link,
  onPress,
  testID,
}: Readonly<{ icon: LucideIcon; title: string; link?: string; onPress?: () => void; testID?: string }>) {
  return (
    <Row
      leading={<IconTile icon={icon} size={46} />}
      title={title}
      link={link}
      onPress={onPress}
      testID={testID}
      regular
    />
  );
}

/** How far the bar stops short of the title and subtitle's line boxes. */
const BAR_INSET = 3;
/** A title over a subtitle: the 16pt title's line (19⅓pt), 2pt, the subtitle's 19pt line. */
const TWO_LINES = 121 / 3;
/** A colour tile in a row (LeaveTypeTile, SickTile): 2pt taller than the bar beside two lines of text, 36⅓pt. */
export const ROW_TILE = TWO_LINES - 2 * BAR_INSET + 2;
/**
 * The avatar's size on a person row (PersonAvatar): 32pt, a touch shorter
 * than the bar beside two lines of text (40pt less the insets, 34pt).
 */
export const BAR_HEIGHT = 32;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 13,
    gap: 14,
    minHeight: 66,
  },
  leading: { flexShrink: 0 },
  // Level with the title's capitals, where a bar starts too.
  leadingTop: { alignSelf: 'flex-start', marginTop: BAR_INSET },
  // The value on the title's first line, their baselines level.
  // The value on the title's first line, their baselines level.
  sideTop: { alignSelf: 'flex-start', marginTop: 2 },
  // Runs from the title's cap height to the subtitle's baseline, not the line boxes;
  // the text sits 11pt from it, a little closer than the row's 14pt gap.
  bar: { width: 4, alignSelf: 'stretch', borderRadius: 2, marginVertical: BAR_INSET, marginLeft: -2, marginRight: -3 },
  main: { flex: 1, minWidth: 0 },
  // The text as far from a tile or avatar as from a bar: 11pt.
  afterLeading: { marginLeft: -3 },
  title: { fontSize: 16, fontWeight: '600' },
  titleRegular: { fontWeight: '400' },
  strike: { textDecorationLine: 'line-through' },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  subtitle: { flexShrink: 1, fontSize: 14, lineHeight: 19 },
  link: { fontSize: 14, fontWeight: '600', marginTop: 2 },
  side: { alignItems: 'flex-end', flexShrink: 0, gap: 3, maxWidth: '45%' },
  value: { fontSize: 15, fontVariant: ['tabular-nums'] },
  valueSmall: { fontSize: 14 },
  detail: { fontSize: 15, fontVariant: ['tabular-nums'] },
  unreadLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  unreadDot: { width: 8, height: 8, borderRadius: 4 },
  divider: { height: StyleSheet.hairlineWidth },
  detailRow: { minHeight: 52, paddingVertical: 14, justifyContent: 'space-between' },
  detailLabel: { fontSize: 15, flexShrink: 0 },
  // The same type as `subtitle`.
  detailLabelSmall: { fontSize: 14, lineHeight: 19 },
  detailValue: { flex: 1, fontSize: 15, textAlign: 'right' },
  count: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 7, alignItems: 'center', justifyContent: 'center' },
  countText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  card: {
    marginHorizontal: 16,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  open: { marginHorizontal: 0, borderWidth: 0, borderRadius: 0 },
  tile: { alignItems: 'center', justifyContent: 'center' },
  dateTile: { width: 40, height: 40, borderRadius: 11 },
  dateWeekday: { fontSize: 10, fontWeight: '500', letterSpacing: 0.3, lineHeight: 12 },
  dateDay: { fontSize: 17, fontWeight: '600', lineHeight: 20, fontVariant: ['tabular-nums'] },
});
