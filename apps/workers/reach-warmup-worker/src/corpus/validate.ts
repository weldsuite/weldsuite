/**
 * Validation of corpus threads, for the stored (R2) set and for freshly
 * generated threads. A thread that fails any check is dropped, never repaired:
 * the corpus is plain, link-free, marker-free business email, and one thread
 * that reads like marketing or like a test costs more than it adds.
 */

import { z } from 'zod';
import { PLACEHOLDER_NAMES } from './constants';
import type { CorpusThread } from './types';

const SUBJECT_MIN = 3;
const SUBJECT_MAX = 120;
const BODY_MIN = 10;
const BODY_MAX = 1500;
/** A run of this many digits (separators allowed) looks like a phone number. */
const PHONE_DIGITS = 9;

/** Words that never belong in a warmup email (matched as whole words, any case). */
export const FORBIDDEN_WORDS: readonly string[] = [
  // gives the network away
  'warmup',
  'warm-up',
  'deliverability',
  'inbox',
  'mailbox',
  'test',
  'tests',
  'tested',
  'testing',
  // spam triggers
  'spam',
  'spammy',
  'newsletter',
  'newsletters',
  'unsubscribe',
  'unsubscribing',
  'click',
  'clicks',
  'clicked',
  'clicking',
  'offer',
  'offers',
  'offered',
  'offering',
  'free',
  'promotion',
  'promotions',
  'promotional',
  'promo',
  'discount',
  'discounts',
  'sale',
  'urgent',
  'guarantee',
  'guaranteed',
  'bonus',
  'winner',
  'lottery',
  'cheap',
  'congratulations',
  'casino',
  'crypto',
  'bitcoin',
  // an attachment that is not there reads as odd to a person
  'attach',
  'attached',
  'attachment',
  'attachments',
  'enclosed',
];

/** Phrases that never belong in a warmup email (matched anywhere, any case). */
export const FORBIDDEN_PHRASES: readonly string[] = [
  'warm up',
  'limited time',
  'act now',
  'buy now',
  'click here',
  'opt out',
  'opt-out',
  'no obligation',
  'risk-free',
  'risk free',
  'make money',
  'dear friend',
  'credit card',
  '100%',
  'once in a lifetime',
];

const FORBIDDEN_WORD_SET: ReadonlySet<string> = new Set(FORBIDDEN_WORDS);
const TRAILING_PUNCTUATION = '.,;:!?)"\'';
const CURRENCY_SYMBOLS = ['$', '€', '£', '¥', '₹'];
const DOMAIN_SUFFIXES: ReadonlySet<string> = new Set([
  'com',
  'org',
  'net',
  'io',
  'co',
  'nl',
  'de',
  'uk',
  'eu',
  'app',
  'dev',
]);
/** Words that may follow "Hi" / "Hello" in a greeting without being a person's name. */
const GREETING_NON_NAMES: ReadonlySet<string> = new Set(['there', 'all', 'team', 'everyone', 'both', 'folks', 'again']);
const SIGN_OFF_LINE = /^(?:thanks|thank you|many thanks|best|best regards|kind regards|warm regards|regards|cheers|talk soon|speak soon|take care|all the best|sincerely),?$/i;
const GREETING_NAME = /^(?:hi|hello|hey|dear|good\s+morning|good\s+afternoon|good\s+evening)\s+([^\s,!.{]+)/i;
const PLACEHOLDER_SET: ReadonlySet<string> = new Set(PLACEHOLDER_NAMES);

function stripTrailingPunctuation(token: string): string {
  let end = token.length;
  while (end > 0 && TRAILING_PUNCTUATION.includes(token.charAt(end - 1))) end -= 1;
  return token.slice(0, end);
}

function hasLinkOrAddress(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes('http') || lower.includes('www.') || lower.includes('://') || lower.includes('@')) return true;
  for (const token of lower.split(/\s+/)) {
    const trimmed = stripTrailingPunctuation(token);
    const dot = trimmed.lastIndexOf('.');
    if (dot > 0 && dot < trimmed.length - 1 && DOMAIN_SUFFIXES.has(trimmed.slice(dot + 1))) return true;
  }
  return false;
}

/** Digits with only spaces, dots, dashes, parentheses or a plus between them, nine or more in a row. */
function hasPhoneLikeNumber(text: string): boolean {
  let digits = 0;
  for (const char of text) {
    if (char >= '0' && char <= '9') {
      digits += 1;
      if (digits >= PHONE_DIGITS) return true;
    } else if (!' .-()+'.includes(char)) {
      digits = 0;
    }
  }
  return false;
}

function findForbiddenTerm(text: string): string | null {
  const lower = text.toLowerCase();
  for (const word of lower.split(/[^a-z0-9'-]+/)) {
    if (FORBIDDEN_WORD_SET.has(word)) return word;
  }
  return FORBIDDEN_PHRASES.find((phrase) => lower.includes(phrase)) ?? null;
}

function hasMarkupOrEmoji(text: string): boolean {
  return (
    text.includes('**') ||
    text.includes('```') ||
    text.includes('`') ||
    text.includes('<') ||
    text.includes('>') ||
    /\p{Extended_Pictographic}/u.test(text)
  );
}

/** Every `{{name}}` is a known placeholder and no brace is left dangling. */
function findPlaceholderIssue(text: string): string | null {
  let pos = 0;
  for (;;) {
    const open = text.indexOf('{{', pos);
    if (open === -1) break;
    const close = text.indexOf('}}', open + 2);
    if (close === -1) return 'unterminated placeholder';
    const name = text.slice(open + 2, close);
    if (!PLACEHOLDER_SET.has(name)) return `unknown placeholder "${name}"`;
    pos = close + 2;
  }
  const rest = text.replaceAll(/\{\{[A-Za-z]+\}\}/g, '');
  return rest.includes('{') || rest.includes('}') ? 'stray brace' : null;
}

/** A greeting or sign-off that names a person must use the placeholders, never a real name. */
function findHardcodedName(body: string): string | null {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const greeting = GREETING_NAME.exec(lines[0] ?? '');
  if (greeting?.[1] && !GREETING_NON_NAMES.has(greeting[1].toLowerCase())) return `greeting names "${greeting[1]}"`;
  const signOff = lines.at(-2);
  const signature = lines.at(-1);
  if (signOff !== undefined && signature !== undefined && SIGN_OFF_LINE.test(signOff) && !signature.includes('{{')) {
    return `signature "${signature}" is not a placeholder`;
  }
  return null;
}

/** What is wrong with a piece of corpus text, or null when it is clean. */
export function findContentIssue(text: string): string | null {
  if (hasLinkOrAddress(text)) return 'contains a link or an address';
  if (hasPhoneLikeNumber(text)) return 'contains a phone number';
  if (CURRENCY_SYMBOLS.some((symbol) => text.includes(symbol))) return 'contains a currency symbol';
  const forbidden = findForbiddenTerm(text);
  if (forbidden !== null) return `contains "${forbidden}"`;
  if (hasMarkupOrEmoji(text)) return 'contains markup or an emoji';
  return findPlaceholderIssue(text);
}

const messageSchema = z.object({
  author: z.enum(['starter', 'responder']),
  body: z.string().trim().min(BODY_MIN).max(BODY_MAX),
});

export const corpusThreadSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/),
    subject: z.string().trim().min(SUBJECT_MIN).max(SUBJECT_MAX),
    messages: z.array(messageSchema).min(2).max(4),
  })
  .superRefine((thread, ctx) => {
    thread.messages.forEach((message, index) => {
      const expected = index % 2 === 0 ? 'starter' : 'responder';
      if (message.author !== expected) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `message ${index} must be written by the ${expected}` });
      }
      const issue = findContentIssue(message.body) ?? findHardcodedName(message.body);
      if (issue !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `message ${index} ${issue}` });
    });
    if (/^re:/i.test(thread.subject) || thread.subject.includes('\n')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'subject must be one plain line without "Re:"' });
    }
    const subjectIssue = findContentIssue(thread.subject);
    if (subjectIssue !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `subject ${subjectIssue}` });
  });

/** The thread when it passes every check, else null. */
export function parseCorpusThread(value: unknown): CorpusThread | null {
  const parsed = corpusThreadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The valid threads of a stored set, in order, with repeated ids dropped. Not an array: nothing valid. */
export function parseCorpusThreads(value: unknown): CorpusThread[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const threads: CorpusThread[] = [];
  for (const item of value as unknown[]) {
    const thread = parseCorpusThread(item);
    if (thread === null || seen.has(thread.id)) continue;
    seen.add(thread.id);
    threads.push(thread);
  }
  return threads;
}
