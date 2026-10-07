/**
 * Google-specific helpers for the generic `/api/workflow-integrations`
 * surface — Sheets, Gmail and Calendar share one Google Cloud OAuth client
 * (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`) but connect as three separate
 * `workflow_integrations` rows (one per product), each requesting only the
 * scopes its own action needs. See "Provider pattern" in
 * docs/plans/weldconnect.md.
 *
 * No Drive scope is requested anywhere here: it would add Drive's own
 * (restricted-tier) scopes to the OAuth consent screen for a feature — a
 * spreadsheet file browser — that a pasted id/URL does just as well without
 * it. The "spreadsheet picker" is therefore a paste-the-id-or-URL field,
 * resolved and validated by `getGoogleSpreadsheet` (works with the
 * `spreadsheets` scope alone); the sheet-tab picker reads the same response.
 */

export interface GoogleAuthTestResult {
  ok: boolean;
  message: string;
}

/**
 * Cheap reachability check shared by every Google product (google_sheets,
 * gmail, google_calendar) — same ping the generic `/:id/test` route used to
 * run inline, now a named provider service file like Slack's `testSlackAuth`.
 */
export async function testGoogleAuth(accessToken: string): Promise<GoogleAuthTestResult> {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return { ok: false, message: `userinfo returned ${res.status}` };
  const json = (await res.json()) as { email?: string };
  return { ok: true, message: json.email ? `Connected as ${json.email}` : 'Google token valid' };
}

/** A bare spreadsheet id, or a full Sheets URL (`.../spreadsheets/d/<id>/edit#gid=0`) → the id. */
export function parseSpreadsheetId(raw: string): string {
  const trimmed = raw.trim();
  const match = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(trimmed);
  return match ? match[1] : trimmed;
}

export interface GoogleSheetTab {
  sheetId: number;
  title: string;
}

export interface GoogleSpreadsheetInfo {
  spreadsheetId: string;
  title: string;
  url: string;
  sheets: GoogleSheetTab[];
}

/**
 * Resolve a spreadsheet's title and sheet tabs. Doubles as both "pickers"
 * (validating the pasted spreadsheet id/URL, and listing its tabs for the
 * sheet-name dropdown) in one Sheets API call.
 */
export async function getGoogleSpreadsheet(
  accessToken: string,
  spreadsheetIdOrUrl: string,
): Promise<GoogleSpreadsheetInfo> {
  const spreadsheetId = parseSpreadsheetId(spreadsheetIdOrUrl);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title,spreadsheetUrl,sheets.properties`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`Sheets API error ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    properties?: { title?: string };
    spreadsheetUrl?: string;
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  };
  return {
    spreadsheetId,
    title: json.properties?.title || spreadsheetId,
    url: json.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
    sheets: (json.sheets ?? [])
      .map((s) => ({ sheetId: s.properties?.sheetId ?? 0, title: s.properties?.title ?? '' }))
      .filter((s) => s.title),
  };
}

export interface GoogleCalendarOption {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
}

const MAX_CALENDARS = 100;

/**
 * Calendars the connected account can write to (`calendarList.list`,
 * `minAccessRole=writer`) — the `google_calendar.create_event` step form's
 * calendar picker.
 */
export async function listGoogleCalendars(accessToken: string): Promise<GoogleCalendarOption[]> {
  const calendars: GoogleCalendarOption[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ maxResults: '100', minAccessRole: 'writer' });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`https://www.googleapis.com/calendar/v3/users/me/calendarList?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Calendar API error ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      items?: Array<{ id: string; summary?: string; primary?: boolean; accessRole?: string }>;
      nextPageToken?: string;
    };
    for (const item of json.items ?? []) {
      calendars.push({
        id: item.id,
        summary: item.summary || item.id,
        primary: !!item.primary,
        accessRole: item.accessRole || '',
      });
    }
    pageToken = json.nextPageToken;
  } while (pageToken && calendars.length < MAX_CALENDARS);
  return calendars.slice(0, MAX_CALENDARS);
}
