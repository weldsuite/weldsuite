/**
 * Open shifts on Schedule: shifts HR posted for anyone to take, soonest first,
 * each with how many spots are left and where I stand (sign up, waiting for
 * approval, declined with the manager's note). Tapping one opens it to sign
 * up or withdraw. Nothing is shown while there are none, or while loading, so
 * the week underneath is never held up.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import type { HrSelfOpenShift } from '@weldsuite/app-api-client/domains/weldhr';

import { swatchFor, type Palette } from '@/constants/brand';
import { usePalette } from '@/hooks/use-palette';
import { useOpenShifts } from '@/hooks/use-weldhr-queries';
import { dayOf } from '@/lib/dates';
import { formatDay } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { listableOpenShifts, standingOf, type OpenShiftStanding } from '@/lib/open-shifts';
import { timeRange } from './HrRows';
import { List, Row } from './Row';
import { Section } from './Screen';

/** Rows shown before "Show all". */
const COLLAPSED = 3;

/** Sign up in the app's colour, waiting amber, declined red, full grey. */
export function standingColor(standing: OpenShiftStanding, palette: Palette): string {
  switch (standing) {
    case 'open':
      return palette.accent;
    case 'waiting':
      return palette.warning;
    case 'declined':
      return palette.danger;
    default:
      return palette.muted;
  }
}

export function OpenShiftsSection({ enabled }: Readonly<{ enabled: boolean }>) {
  const palette = usePalette();
  const { t, format, plural, intlLocale } = useI18n();
  const router = useRouter();
  const { currentWorkspace } = useWorkspace();
  const query = useOpenShifts(enabled);
  const [expanded, setExpanded] = useState(false);

  const shifts = listableOpenShifts(query.data ?? []);
  if (shifts.length === 0) return null;
  const shown = expanded ? shifts : shifts.slice(0, COLLAPSED);

  const standingText = (shift: HrSelfOpenShift): string => {
    switch (standingOf(shift)) {
      case 'open':
        return t.openShifts.signUp;
      case 'waiting':
        return t.openShifts.waiting;
      case 'declined':
        return t.openShifts.declined;
      default:
        return t.openShifts.full;
    }
  };

  const lines = (shift: HrSelfOpenShift): string => {
    const place = [formatDay(dayOf(shift.startsAt), intlLocale), shift.workType, shift.companyName ?? currentWorkspace?.name]
      .filter(Boolean)
      .join(' · ');
    const note = standingOf(shift) === 'declined' ? shift.myRequest?.reviewNote : null;
    return note ? `${place}\n${format(t.openShifts.reviewNote, { note })}` : place;
  };

  return (
    <Section title={t.openShifts.title} meta={String(shifts.length)} first>
      <List>
        {shown.map((shift) => (
          <Row
            key={shift.id}
            bar={swatchFor(shift.workType ?? shift.companyName)}
            title={timeRange(shift.startsAt, shift.endsAt, intlLocale)}
            subtitle={lines(shift)}
            subtitleLines={2}
            value={plural(shift.spotsLeft, t.openShifts.spotsLeft)}
            detail={standingText(shift)}
            detailColor={standingColor(standingOf(shift), palette)}
            onPress={() => router.push({ pathname: '/open-shift/[id]', params: { id: shift.id } })}
            testID={`open-shift-${shift.id}`}
          />
        ))}
      </List>
      {shifts.length > COLLAPSED ? (
        <Pressable onPress={() => setExpanded((open) => !open)} accessibilityRole="button" testID="open-shifts-toggle">
          <Text style={[styles.toggle, { color: palette.accent }]}>
            {expanded ? t.openShifts.showLess : format(t.openShifts.showAll, { count: shifts.length })}
          </Text>
        </Pressable>
      ) : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  toggle: { paddingHorizontal: 16, paddingTop: 12, fontSize: 15, fontWeight: '600' },
});
