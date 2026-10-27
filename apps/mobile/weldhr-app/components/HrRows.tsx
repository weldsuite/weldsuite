/**
 * Rows that show up on more than one screen: a shift (Home, Schedule), a
 * leave request and a sick report (Home, Absence), and the tiles that mark a
 * leave type or a sick day.
 */

import { Plane, Thermometer } from 'lucide-react-native';
import type { HrLeaveStatus, HrSelfAbsence, HrSelfLeaveRequest } from '@weldsuite/app-api-client/domains/weldhr';

import { onColor, solid, swatchFor, type Palette } from '@/constants/brand';
import { usePalette } from '@/hooks/use-palette';
import { dayOf } from '@/lib/dates';
import { formatShortDate, formatSpan, formatTime } from '@/lib/format';
import { labelFor, useI18n } from '@/lib/i18n';
import { DateTile, IconTile, Row } from './Row';

/** Status words in their colour: approved green, pending amber, declined red. */
export function statusColor(status: HrLeaveStatus | string, palette: Palette): string {
  switch (status) {
    case 'approved':
    case 'paid':
    case 'present':
      return palette.success;
    case 'pending':
    case 'late':
      return palette.warning;
    case 'rejected':
    case 'absent':
      return palette.danger;
    default:
      return palette.muted;
  }
}

/** A leave type's tile: a plane on the colour HR picked for the type. */
export function LeaveTypeTile({ color, size = 40 }: Readonly<{ color: string | null; size?: number }>) {
  const background = solid(color);
  return <IconTile icon={Plane} background={background} color={onColor(background)} size={size} />;
}

export function SickTile({ size = 40 }: Readonly<{ size?: number }>) {
  const palette = usePalette();
  return <IconTile icon={Thermometer} background={palette.danger} color="#FFFFFF" size={size} />;
}

/** "09:00 – 16:30" for a shift or a clocked stretch; "09:00 – …" while it is still running. */
export function timeRange(start: string | null, end: string | null, locale: string): string {
  return `${formatTime(start, locale)} – ${end ? formatTime(end, locale) : '…'}`;
}

export function ShiftRow({
  startsAt,
  endsAt,
  place,
  workspace,
  onPress,
}: Readonly<{ startsAt: string; endsAt: string; place: string | null; workspace?: string; onPress?: () => void }>) {
  const { intlLocale } = useI18n();
  return (
    <Row
      leading={<DateTile date={dayOf(startsAt)} locale={intlLocale} />}
      bar={swatchFor(place ?? workspace)}
      title={timeRange(startsAt, endsAt, intlLocale)}
      subtitle={[place, workspace].filter(Boolean).join(' • ')}
      onPress={onPress}
      chevron={Boolean(onPress)}
    />
  );
}

export function LeaveRow({ request, onPress }: Readonly<{ request: HrSelfLeaveRequest; onPress?: () => void }>) {
  const palette = usePalette();
  const { t, format, plural, intlLocale } = useI18n();
  const status = labelFor(t.leaveStatus, request.status);
  return (
    <Row
      leading={<LeaveTypeTile color={request.leaveTypeColor} />}
      title={request.leaveTypeName ?? t.absence.leave}
      subtitle={
        request.reviewNote ? `${status} • ${format(t.timeOff.reviewNoteAnonymous, { note: request.reviewNote })}` : status
      }
      subtitleLines={2}
      subtitleColor={statusColor(request.status, palette)}
      value={formatSpan(request.startDate, request.endDate, intlLocale)}
      detail={plural(request.days, t.balance.days)}
      muted={request.status === 'cancelled'}
      onPress={onPress}
    />
  );
}

export function SickRow({ absence, onPress }: Readonly<{ absence: HrSelfAbsence; onPress?: () => void }>) {
  const palette = usePalette();
  const { t, plural, intlLocale } = useI18n();
  const ongoing = absence.status === 'ongoing';
  return (
    <Row
      leading={<SickTile />}
      title={t.absence.sick}
      subtitle={ongoing ? t.absence.ongoing : t.absence.recovered}
      subtitleColor={ongoing ? palette.danger : palette.muted}
      value={
        ongoing
          ? `${formatShortDate(absence.startDate, intlLocale)} – …`
          : formatSpan(absence.startDate, absence.endDate ?? absence.startDate, intlLocale)
      }
      detail={plural(absence.days, t.balance.days)}
      onPress={onPress}
    />
  );
}
