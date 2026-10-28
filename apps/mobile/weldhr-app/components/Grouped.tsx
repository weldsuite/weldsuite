/**
 * Settings the way Attio's app lays them out (the profile): white cards with a
 * hairline border on a light grey page, 16pt in from the sides and 24pt
 * apart, without titles. A row is a grey outline icon (or a small tile), the
 * name in 15pt medium, and on the right a value, a count, a switch, a check or
 * a chevron; a hairline between rows starts under the names. Under the last
 * card, the version, in two greys.
 */

import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Check, ChevronRight, type LucideIcon } from 'lucide-react-native';

import { usePalette } from '@/hooks/use-palette';

/** The slot for the icon on the left, and how far the names start in from the card. */
export const GROUPED_ICON = 20;
const ROW_LEFT = 13;
const ICON_GAP = 10;

/**
 * A card of rows, a hairline between them under the names; `plain` for rows
 * without icons (label and value), where it starts at their text.
 */
export function Group({
  children,
  plain = false,
  style,
}: Readonly<{ children: ReactNode; plain?: boolean; style?: StyleProp<ViewStyle> }>) {
  const palette = usePalette();
  const rows = Children.toArray(children).filter(isValidElement);
  if (rows.length === 0) return null;
  return (
    <View style={[styles.group, { backgroundColor: palette.surface, borderColor: palette.groupedBorder }, style]}>
      {rows.map((row, index) => (
        <Fragment key={row.key ?? index}>
          {index > 0 ? (
            <View style={[styles.divider, plain && styles.dividerPlain, { backgroundColor: palette.groupedBorder }]} />
          ) : null}
          {row}
        </Fragment>
      ))}
    </View>
  );
}

export interface GroupRowProps {
  /** A grey outline icon, or `leading` for something of its own (a tile, a ring, an avatar). */
  icon?: LucideIcon;
  leading?: ReactNode;
  title: string;
  subtitle?: string | null;
  /** On the right: a value in grey (text), or a control (a count, a switch, a check). */
  value?: ReactNode;
  chevron?: boolean;
  /** Under the row, inside it (a segmented control). */
  below?: ReactNode;
  onPress?: () => void;
  testID?: string;
  accessibilityRole?: 'button' | 'radio' | 'switch';
  selected?: boolean;
  /** Title and icon in red, for an action that cannot be undone (deleting the account). */
  destructive?: boolean;
}

export function GroupRow({
  icon: Icon,
  leading,
  title,
  subtitle,
  value,
  chevron = false,
  below,
  onPress,
  testID,
  accessibilityRole = 'button',
  selected,
  destructive = false,
}: Readonly<GroupRowProps>) {
  const palette = usePalette();
  const content = (
    <>
      <View style={styles.row}>
        {Icon ? (
          <Icon size={GROUPED_ICON} color={destructive ? palette.danger : palette.groupedIcon} strokeWidth={1.75} />
        ) : (
          leading
        )}
        <View style={styles.main}>
          <Text style={[styles.title, { color: destructive ? palette.danger : palette.text }]} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={[styles.subtitle, { color: palette.muted }]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {typeof value === 'string' ? (
          <Text style={[styles.value, { color: palette.muted }]} numberOfLines={1}>
            {value}
          </Text>
        ) : (
          value
        )}
        {chevron ? <ChevronRight size={18} color={palette.groupedIcon} strokeWidth={1.75} /> : null}
      </View>
      {below ? <View style={styles.below}>{below}</View> : null}
    </>
  );
  if (!onPress) return <View testID={testID}>{content}</View>;
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole={accessibilityRole}
      accessibilityState={selected == null ? undefined : { selected }}
      style={({ pressed }) => (pressed ? { backgroundColor: palette.tile } : undefined)}
    >
      {content}
    </Pressable>
  );
}

/** A letter on a small coloured tile, in the icon's place (a workspace). */
export function LetterTile({ letter, color }: Readonly<{ letter: string; color: string }>) {
  return (
    <View style={[styles.tile, { backgroundColor: color }]}>
      <Text style={styles.tileLetter}>{letter.toUpperCase()}</Text>
    </View>
  );
}

/** The blue round check on the chosen row (the current workspace). */
export function SelectedCheck() {
  const palette = usePalette();
  return (
    <View style={[styles.check, { backgroundColor: palette.selected }]}>
      <Check size={11} color="#FFFFFF" strokeWidth={3.2} />
    </View>
  );
}

/** Under the last card: what it is on the left, lighter, and its value on the right. */
export function GroupFooter({ label, value }: Readonly<{ label: string; value: string }>) {
  const palette = usePalette();
  return (
    <View style={styles.footer}>
      <Text style={[styles.footerText, { color: palette.groupedIcon, opacity: 0.7 }]}>{label}</Text>
      <Text style={[styles.footerText, { color: palette.groupedIcon }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    marginHorizontal: 16,
    marginTop: 24,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: ROW_LEFT + GROUPED_ICON + ICON_GAP },
  dividerPlain: { marginLeft: ROW_LEFT },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ICON_GAP,
    minHeight: 47,
    paddingLeft: ROW_LEFT,
    paddingRight: 14,
    paddingVertical: 12,
  },
  main: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: '500', letterSpacing: 0 },
  subtitle: { fontSize: 13, lineHeight: 17, marginTop: 1 },
  value: { flexShrink: 0, maxWidth: '55%', fontSize: 15, letterSpacing: 0, fontVariant: ['tabular-nums'] },
  below: { paddingLeft: ROW_LEFT + GROUPED_ICON + ICON_GAP, paddingRight: 14, paddingBottom: 13, marginTop: -4 },
  tile: { width: GROUPED_ICON, height: GROUPED_ICON, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  tileLetter: { color: '#FFFFFF', fontSize: 11, fontWeight: '600', letterSpacing: 0 },
  check: { width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  footer: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, marginTop: 24.5 },
  footerText: { fontSize: 15, letterSpacing: 0, fontVariant: ['tabular-nums'] },
});
