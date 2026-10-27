/**
 * A page with nothing to show, after Shiftbase's empty state: an icon on a
 * rounded tile, a title, one short line, and the action that fills the page
 * when there is one. It centres itself in whatever room the page leaves.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  CalendarDays,
  CircleCheck,
  Clock3,
  FileText,
  ListChecks,
  MessageSquareText,
  Receipt,
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
  | 'clock';

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

  return (
    <View style={styles.container}>
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
  );
}

const styles = StyleSheet.create({
  // Grows into the room the page leaves and centres in it; where there is no
  // room to grow it still keeps clear of what is above and below.
  container: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, paddingVertical: 48 },
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
  description: { fontSize: 16, lineHeight: 22, textAlign: 'center', marginTop: 8, maxWidth: 300 },
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
