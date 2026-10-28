/**
 * A page with nothing to show, after Shiftbase's empty state: an icon on a
 * rounded tile, a title, one short line, and the action that fills the page
 * when there is one. It sits in the middle of the screen, as far as the room
 * the page leaves allows.
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import {
  CalendarDays,
  CircleCheck,
  Clock3,
  FileText,
  ListChecks,
  MessageSquareText,
  Receipt,
  SearchX,
  UserRound,
  UsersRound,
  type LucideIcon,
} from 'lucide-react-native';

import { usePalette } from '@/hooks/use-palette';

export type Illustration =
  | 'calendar'
  | 'receipt'
  | 'document'
  | 'checklist'
  | 'chat'
  | 'people'
  | 'person'
  | 'check'
  | 'clock'
  | 'search';

const ICONS: Record<Illustration, LucideIcon> = {
  calendar: CalendarDays,
  receipt: Receipt,
  document: FileText,
  checklist: ListChecks,
  chat: MessageSquareText,
  people: UsersRound,
  person: UserRound,
  check: CircleCheck,
  clock: Clock3,
  search: SearchX,
};

interface EmptyStateProps {
  illustration: Illustration;
  title: string;
  description?: string;
  /** The button under the text, e.g. "New expense". */
  action?: { label: string; onPress: () => void; testID?: string };
}

export function EmptyState({ illustration, title, description, action }: Readonly<EmptyStateProps>) {
  const palette = usePalette();
  const Icon = ICONS[illustration];
  const { height: screen } = useWindowDimensions();
  const room = useRef<View>(null);
  const body = useRef<View>(null);
  const [shift, setShift] = useState(0);

  // The room the page leaves runs from what is above (the title, tabs, a search
  // field) to the tab bar and the "+" button, so its middle is not the
  // screen's: move the text there, without leaving the room's padding.
  // Measured before the first paint, so it never shows in the wrong place.
  const place = useCallback(() => {
    room.current?.measureInWindow((_x, top, _width, height) => {
      body.current?.measureInWindow((_bx, _by, _bwidth, size) => {
        const slack = Math.max(0, (height - size) / 2 - PADDING);
        const offset = screen / 2 - (top + height / 2);
        setShift(Math.min(Math.max(offset, -slack), slack));
      });
    });
  }, [screen]);
  useLayoutEffect(place, [place]);

  return (
    <View ref={room} style={styles.container} onLayout={place}>
      <View ref={body} style={[styles.body, { transform: [{ translateY: shift }] }]}>
        <View style={[styles.tile, { backgroundColor: palette.tile }]}>
          <Icon size={28} color={palette.muted} strokeWidth={1.9} />
        </View>
        <Text style={[styles.title, { color: palette.text }]}>{title}</Text>
        {description ? <Text style={[styles.description, { color: palette.muted }]}>{description}</Text> : null}
        {action ? (
          <Pressable
            onPress={action.onPress}
            accessibilityRole="button"
            testID={action.testID}
            style={({ pressed }) => [styles.button, { backgroundColor: palette.primary, opacity: pressed ? 0.85 : 1 }]}
          >
            <Text style={styles.buttonText}>{action.label}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** Kept clear above and below the empty state, also where there is no room to grow. */
const PADDING = 48;

const styles = StyleSheet.create({
  // Grows into the room the page leaves and centres in it; `shift` then moves it to the screen's middle.
  container: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 32, paddingVertical: PADDING },
  body: { alignItems: 'center' },
  tile: {
    width: 70,
    height: 70,
    borderRadius: 22,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 22,
  },
  title: { fontSize: 19, lineHeight: 24, fontWeight: '600', textAlign: 'center', letterSpacing: -0.2 },
  description: { fontSize: 16, lineHeight: 22, textAlign: 'center', marginTop: 8, maxWidth: 260 },
  button: {
    height: 44,
    paddingHorizontal: 20,
    borderRadius: 12,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 20,
  },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '500' },
});
