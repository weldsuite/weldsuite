/**
 * Where a booking takes place. Pure, shared by the emails (server) and the
 * confirmation card (client).
 */

export interface LocationFields {
  locationType: string | null;
  locationValue: string | null;
  /** The WeldMeet join link created for the booking, when there is one. */
  meetingUrl?: string | null;
}

const HTTP_URL = /^https?:\/\//i;

/** True for an http(s) link: the only kind that is ever rendered as a clickable href. */
export function isHttpUrl(value: string): boolean {
  return HTTP_URL.test(value);
}

/**
 * True when a booking page's video location needs a WeldMeet meeting of its own:
 * video, and the page has no custom link of its own. A page with a custom
 * `locationValue` keeps using that link as is.
 */
export function needsWeldMeetMeeting(locationType: string | null, locationValue: string | null): boolean {
  return locationType === 'video' && !locationValue?.trim();
}

/** The link to join a video booking: its WeldMeet link, else the page's own link. */
export function joinUrlOf(fields: LocationFields): string | null {
  if (fields.locationType !== 'video') return null;
  return fields.meetingUrl?.trim() || fields.locationValue?.trim() || null;
}

/**
 * The text for a calendar entry's "where": the join link for video, the typed
 * value for phone / in person, null when there is nothing to say.
 */
export function calendarLocationOf(fields: LocationFields): string | null {
  if (fields.locationType === 'video') return joinUrlOf(fields);
  return fields.locationValue?.trim() || null;
}
