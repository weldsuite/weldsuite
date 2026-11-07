/** Small formatting helpers shared by the WeldMerge pages. */

/** Fills `{name}` placeholders in a translated string. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/**
 * "12 minutes ago" in the given locale; `justNow` under a minute. Dates in the
 * future (clock skew) also read as just now.
 */
export function relativeTime(iso: string, locale: string, justNow: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 60) return justNow;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return formatter.format(-Math.floor(seconds / size), unit);
  }
  return justNow;
}

/** `Nov 3 – Nov 16` for two `YYYY-MM-DD` dates. */
export function formatDateRange(startsAt: string, endsAt: string, locale: string): string {
  const format = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const start = format.format(new Date(`${startsAt}T00:00:00Z`));
  const end = format.format(new Date(`${endsAt}T00:00:00Z`));
  return `${start} – ${end}`;
}

export type CycleState = 'upcoming' | 'current' | 'past';

/** Where a cycle stands on `today` (all `YYYY-MM-DD`). */
export function cycleState(startsAt: string, endsAt: string, today: string): CycleState {
  if (today < startsAt) return 'upcoming';
  if (today > endsAt) return 'past';
  return 'current';
}

export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Up to two initials of a name. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]!.charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : '';
  return (first + last).toUpperCase();
}

/** Code (fenced blocks and inline spans), where `<…>` is text and stays. */
const CODE_PART = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/;
const HTML_TAG = /<(\/?)([a-zA-Z][\w-]*)(?:\s[^<>]*)?\/?>/g;
/** Tags that end a line where the provider renders them. */
const BLOCK_TAGS = new Set(['br', 'p', 'div', 'details', 'summary', 'table', 'tr', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

function withoutTags(text: string): string {
  return text.replace(HTML_TAG, (_tag, _slash, name: string) => (BLOCK_TAGS.has(name.toLowerCase()) ? '\n' : ''));
}

/**
 * Markdown from the provider in the form our renderers can show: HTML comments
 * (bots keep their state in them, templates their instructions) are never
 * displayed on the provider, so they go; HTML tags outside code (a bot's
 * `<details>`, `<img>`, `<sup>`) are rendered there and would show as raw text
 * here, so they go too and the text inside them stays.
 */
export function providerMarkdown(body: string): string {
  return body
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .split(CODE_PART)
    .map((part, index) => (index % 2 === 1 ? part : withAlertTitles(withoutTags(part))))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** GitHub's alert marker (`> [!TIP]`) is shown there as the alert's title; here it becomes that word in bold. */
function withAlertTitles(text: string): string {
  return text.replace(
    /^(\s*>?\s*)\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/gim,
    (_marker, lead: string, kind: string) => `${lead}**${kind.charAt(0).toUpperCase()}${kind.slice(1).toLowerCase()}**`,
  );
}

/** A provider comment as one line of plain text, for a reply quote: no Markdown markers, links as their text. */
export function providerPreviewText(body: string): string {
  return providerMarkdown(body)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A provider comment for the chat's Markdown, which knows emphasis, code and
 * bare URLs but not Markdown links or images: images and link definitions go
 * (the provider shows the picture or nothing), a link reads `text (url)` so
 * its URL is still linked.
 */
export function providerChatMarkdown(body: string): string {
  return providerMarkdown(body)
    .split(CODE_PART)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(/^ {0,3}\[[^\]]+\]:[ \t]*\S.*$/gm, '')
            .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
            .replace(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_link, text: string, url: string) => {
              if (text.trim() === '') return url;
              return text === url ? url : `${text} (${url})`;
            }),
    )
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
