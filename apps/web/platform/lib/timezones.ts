export interface TimezoneOption {
  id: string;
  label: string;
}

export function getUtcOffset(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    const off = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT';
    return off === 'GMT' ? 'GMT+00:00' : off.replace(/^GMT/, 'GMT');
  } catch {
    return 'GMT';
  }
}

export const TIMEZONES: TimezoneOption[] = (() => {
  const ids =
    typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : ['UTC', 'Europe/Amsterdam', 'America/New_York'];

  const list = ['UTC', ...ids.filter((tz) => tz !== 'UTC').sort()];
  return list.map((id) => ({
    id,
    label: `${id.replace(/_/g, ' ')} (${getUtcOffset(id)})`,
  }));
})();
