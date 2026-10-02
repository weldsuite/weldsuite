/**
 * Parse a RealtimeKit post-meeting transcript into speaker segments.
 *
 * RealtimeKit offers CSV, JSON, SRT and VTT (documented under
 * developers.cloudflare.com/realtime/realtimekit/ai/transcription). The
 * `meeting.transcript` webhook URL points at the CSV; the sessions REST API can
 * return JSON. Both carry per-participant lines, which is what gives WeldMeet
 * speaker names without diarization:
 *
 *   JSON  [{ startTime(ms), endTime(ms), sentence, peerData: { id, userId, displayName, cpi } }]
 *   CSV   "startMs","peerId","userId","customParticipantId","name","text"   (no header)
 *
 * The format is detected from the content, so the caller does not need to know
 * which of the two it downloaded.
 */

export interface ParsedTranscriptSegment {
  /** 0-based speaker index in order of first appearance. */
  speakerId: number;
  speakerLabel: string;
  speakerName: string | null;
  text: string;
  /** Seconds from the start of the session. */
  start: number;
  end: number;
}

export interface ParsedTranscript {
  format: 'json' | 'csv';
  segments: ParsedTranscriptSegment[];
  speakerCount: number;
}

interface RawLine {
  startMs: number;
  endMs: number | null;
  text: string;
  speakerKey: string;
  speakerName: string | null;
}

/** Minimal RFC 4180 CSV record parser (quoted fields, escaped quotes, newlines in quotes). */
export function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function linesFromJson(parsed: unknown): RawLine[] {
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { transcript?: unknown }).transcript)
      ? ((parsed as { transcript: unknown[] }).transcript)
      : [];
  const lines: RawLine[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const text = typeof e.sentence === 'string' ? e.sentence : typeof e.text === 'string' ? e.text : '';
    if (!text.trim()) continue;
    const peer = (e.peerData && typeof e.peerData === 'object' ? e.peerData : {}) as Record<string, unknown>;
    const name = typeof peer.displayName === 'string' && peer.displayName ? peer.displayName : null;
    const key =
      (typeof peer.cpi === 'string' && peer.cpi) ||
      (typeof peer.userId === 'string' && peer.userId) ||
      (typeof peer.id === 'string' && peer.id) ||
      name ||
      'unknown';
    lines.push({
      startMs: asNumber(e.startTime) ?? 0,
      endMs: asNumber(e.endTime),
      text: text.trim(),
      speakerKey: key,
      speakerName: name,
    });
  }
  return lines;
}

function linesFromCsv(input: string): RawLine[] {
  const lines: RawLine[] = [];
  for (const cols of parseCsvRows(input)) {
    if (cols.length < 6) continue;
    const startMs = asNumber(cols[0]);
    if (startMs === null) continue; // header row or noise
    const text = cols.slice(5).join(',').trim();
    if (!text) continue;
    const name = cols[4]?.trim() || null;
    const key = cols[3]?.trim() || cols[2]?.trim() || cols[1]?.trim() || name || 'unknown';
    lines.push({ startMs, endMs: null, text, speakerKey: key, speakerName: name });
  }
  return lines;
}

/**
 * Parse a downloaded transcript (JSON array or headerless CSV) into segments
 * sorted by start time. Segment end times fall back to the next line's start
 * (CSV has none), capped so a long silence does not stretch the last line.
 */
export function parseRtkTranscript(content: string): ParsedTranscript {
  const trimmed = content.trim();
  let format: 'json' | 'csv' = 'csv';
  let lines: RawLine[];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    format = 'json';
    lines = linesFromJson(JSON.parse(trimmed) as unknown);
  } else {
    lines = linesFromCsv(trimmed);
  }

  lines.sort((a, b) => a.startMs - b.startMs);

  const speakerIds = new Map<string, number>();
  const segments: ParsedTranscriptSegment[] = lines.map((line, i) => {
    let speakerId = speakerIds.get(line.speakerKey);
    if (speakerId === undefined) {
      speakerId = speakerIds.size;
      speakerIds.set(line.speakerKey, speakerId);
    }
    const start = line.startMs / 1000;
    const nextStart = lines[i + 1] ? lines[i + 1]!.startMs / 1000 : null;
    const end =
      line.endMs !== null
        ? line.endMs / 1000
        : nextStart !== null
          ? Math.min(nextStart, start + 30)
          : start + 3;
    return {
      speakerId,
      speakerLabel: line.speakerName ?? `Speaker ${speakerId + 1}`,
      speakerName: line.speakerName,
      text: line.text,
      start,
      end: Math.max(end, start),
    };
  });

  return { format, segments, speakerCount: speakerIds.size };
}
