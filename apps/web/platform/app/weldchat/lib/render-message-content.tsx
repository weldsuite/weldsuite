/**
 * Renders a WeldChat message body to React nodes: `<@…>` mention chips,
 * auto-linked URLs, `code` spans and inline emphasis.
 *
 *   **bold**  *italic*  _italic_  __underline__  ~~strike~~  `code`
 *
 * Emphasis follows the CommonMark delimiter-run rules (runs nest, e.g.
 * `***both***`, `**a *b* c**`), with two classes of marker:
 *  - `**` (any run of 2+ asterisks) and `~~` are unambiguous: they open when
 *    followed by a non-space and close when preceded by one, whatever the
 *    neighbouring characters are (`**done**🎉`, `**foo**bar`, `**Note:**text`).
 *  - single `*`, `_` and `__` use the stricter word-boundary rule, so they
 *    never trigger inside words (`2*3*4`, `snake_case_name`, `__init__`).
 *
 * Everything that is not a recognised token is emitted as a plain React string,
 * so message text can never inject markup. Links are limited to http(s).
 * Parsing is linear in the message length; very long messages skip emphasis.
 */

import { Fragment, type ReactNode } from 'react';
import { parseChatTokens } from './render-tokens';
import { EntityMentionChip } from '../components/entity-mention-chip';

/** Stands in for an already-rendered node (mention chip) inside the flat text. */
const ATOM = '';

/** Above this many characters a message is rendered without emphasis parsing. */
export const MAX_EMPHASIS_CHARS = 20_000;
/** URLs longer than this are left as text (also bounds the trimming work). */
const MAX_URL_CHARS = 2048;

type EmphasisChar = '*' | '_' | '~';
type WrapKind = 'strong' | 'em' | 'underline' | 'strike';

interface DelimTok {
  t: 'delim';
  ch: EmphasisChar;
  n: number;
  open: boolean;
  close: boolean;
}
/** An already-rendered piece (mention chip, link, code span) plus its plain-text form. */
interface Atom {
  node: ReactNode;
  text: string;
}

type Tok =
  | { t: 'text'; v: string }
  | ({ t: 'atom' } & Atom)
  | DelimTok
  | { t: 'wrap'; kind: WrapKind; children: Tok[] };

const isSpace = (c: string | undefined): boolean => c === undefined || /\s/u.test(c);
const isPunct = (c: string | undefined): boolean => c !== undefined && /[\p{P}\p{S}]/u.test(c);

/** The code point ending just before `index` (so an astral emoji is one character). */
function charBefore(s: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const last = s.charCodeAt(index - 1);
  if (last >= 0xdc00 && last <= 0xdfff && index >= 2) {
    const lead = s.charCodeAt(index - 2);
    if (lead >= 0xd800 && lead <= 0xdbff) return s.slice(index - 2, index);
  }
  return s[index - 1];
}

/** The code point starting at `index`. */
function charAfter(s: string, index: number): string | undefined {
  if (index >= s.length) return undefined;
  return String.fromCodePoint(s.codePointAt(index) as number);
}

/** Whether a delimiter run `s[index, index + n)` can open and/or close emphasis. */
function classifyRun(s: string, index: number, n: number, ch: EmphasisChar): { open: boolean; close: boolean } {
  const prev = charBefore(s, index);
  const next = charAfter(s, index + n);
  const prevSpace = isSpace(prev);
  const nextSpace = isSpace(next);

  if ((ch === '*' && n >= 2) || ch === '~') {
    return { open: !nextSpace, close: !prevSpace };
  }

  const prevPunct = isPunct(prev);
  const nextPunct = isPunct(next);
  const leftFlanking = !nextSpace && (!nextPunct || prevSpace || prevPunct);
  const rightFlanking = !prevSpace && (!prevPunct || nextSpace || nextPunct);
  // Intraword runs (flanking on both sides, no punctuation) open and close nothing.
  return {
    open: leftFlanking && (!rightFlanking || prevPunct),
    close: rightFlanking && (!leftFlanking || nextPunct),
  };
}

// Sticky: matched in place at `lastIndex`, never by slicing the message.
const URL_AT = new RegExp(`https?://[^\\s${ATOM}<>\`]{1,${MAX_URL_CHARS + 1}}`, 'iy');

function countChar(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

/** Drops trailing sentence punctuation / emphasis markers and unbalanced closers from a URL. */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.at(-1);
    if (last === undefined) return url;
    if (/[.,;:!?'"*_~]/.test(last)) {
      url = url.slice(0, -1);
    } else if (
      (last === ')' && countChar(url, '(') < countChar(url, ')')) ||
      (last === ']' && countChar(url, '[') < countChar(url, ']')) ||
      (last === '}' && countChar(url, '{') < countChar(url, '}'))
    ) {
      url = url.slice(0, -1);
    } else {
      return url;
    }
  }
}

/** A URL needs something after `scheme://` to be worth linking. */
function isLinkable(url: string): boolean {
  return /^https?:\/\/[^\s/?#]+/i.test(url);
}

function lex(flat: string, atoms: Atom[], emphasis: boolean): Tok[] {
  const toks: Tok[] = [];
  let buf = '';
  let atomIdx = 0;
  const flush = () => {
    if (buf) {
      toks.push({ t: 'text', v: buf });
      buf = '';
    }
  };

  let i = 0;
  while (i < flat.length) {
    const ch = flat[i];

    if (ch === ATOM) {
      flush();
      toks.push({ t: 'atom', ...atoms[atomIdx++] });
      i++;
      continue;
    }

    if (emphasis && ch === '`') {
      const end = flat.indexOf('`', i + 1);
      if (end > i + 1 && !flat.slice(i + 1, end).includes('\n')) {
        flush();
        const kids: ReactNode[] = [];
        let codeText = '';
        const parts = flat.slice(i + 1, end).split(ATOM);
        parts.forEach((part, k) => {
          if (part) kids.push(part);
          codeText += part;
          if (k < parts.length - 1) {
            const atom = atoms[atomIdx++];
            kids.push(atom.node);
            codeText += atom.text;
          }
        });
        toks.push({
          t: 'atom',
          node: (
            <code className="bg-gray-100 dark:bg-gray-800 text-[13px] px-1 py-0.5 rounded font-mono">{kids}</code>
          ),
          text: codeText,
        });
        i = end + 1;
        continue;
      }
    }

    if ((ch === 'h' || ch === 'H') && (i === 0 || !/[A-Za-z0-9]/.test(flat[i - 1]))) {
      URL_AT.lastIndex = i;
      const match = URL_AT.exec(flat);
      if (match && match[0].length <= MAX_URL_CHARS) {
        const url = trimUrl(match[0]);
        if (isLinkable(url)) {
          flush();
          toks.push({
            t: 'atom',
            node: (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2 break-all"
                onClick={(e) => e.stopPropagation()}
              >
                {url}
              </a>
            ),
            text: url,
          });
          i += url.length;
          continue;
        }
      }
    }

    if (emphasis && (ch === '*' || ch === '_' || ch === '~')) {
      let n = 1;
      while (flat[i + n] === ch) n++;
      // `_`: 1 (italic) or 2 (underline); `~`: exactly 2 (strike); `*`: any run.
      const supported = ch === '*' || (ch === '_' && n <= 2) || (ch === '~' && n === 2);
      if (supported) {
        flush();
        const { open, close } = classifyRun(flat, i, n, ch);
        toks.push({ t: 'delim', ch, n, open, close });
      } else {
        buf += ch.repeat(n);
      }
      i += n;
      continue;
    }

    buf += ch;
    i++;
  }
  flush();
  return toks;
}

/** `__init__`-style identifiers read as code, not as an underlined word. */
function isDunderIdentifier(tok: Tok): boolean {
  return tok.t === 'text' && /^[A-Za-z][A-Za-z0-9_]*$/.test(tok.v);
}

/**
 * Matches closers to the nearest opener, nesting the tokens between them
 * (CommonMark style). One pass over the tokens with a stack of open delimiters
 * per marker, so the work is linear in the number of tokens.
 */
function applyEmphasis(input: Tok[]): Tok[] {
  const out: Tok[] = [];
  const openers: Record<EmphasisChar, number[]> = { '*': [], _: [], '~': [] };

  for (const tok of input) {
    out.push(tok);
    if (tok.t !== 'delim') continue;

    const stack = openers[tok.ch];
    while (tok.close && tok.n > 0) {
      // Drop openers that were used up or got wrapped into a nested span.
      while (stack.length > 0 && (out[stack[stack.length - 1]] as DelimTok).n === 0) stack.pop();
      if (stack.length === 0) break;

      const openerIdx = stack[stack.length - 1];
      const opener = out[openerIdx] as DelimTok;
      const use = opener.n >= 2 && tok.n >= 2 ? 2 : 1;
      const innerCount = out.length - 2 - openerIdx;

      if (tok.ch === '_' && use === 2 && innerCount === 1 && isDunderIdentifier(out[openerIdx + 1])) {
        tok.close = false;
        break;
      }

      let kind: WrapKind = 'em';
      if (tok.ch === '~') kind = 'strike';
      else if (use === 2) kind = tok.ch === '_' ? 'underline' : 'strong';

      opener.n -= use;
      tok.n -= use;
      // [..., opener, inner…, closer] → [..., opener, wrap, closer]
      const inner = out.splice(openerIdx + 1, innerCount);
      out.splice(openerIdx + 1, 0, { t: 'wrap', kind, children: inner });
      // Everything that sat inside the span can no longer open anything.
      while (stack.length > 0 && stack[stack.length - 1] > openerIdx) stack.pop();
    }

    if (tok.open && tok.n > 0) stack.push(out.length - 1);
  }
  return out;
}

function renderToks(toks: Tok[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = '';
    }
  };

  toks.forEach((tok, idx) => {
    const key = `${keyPrefix}${idx}`;
    if (tok.t === 'text') {
      buf += tok.v;
    } else if (tok.t === 'delim') {
      buf += tok.ch.repeat(tok.n);
    } else if (tok.t === 'atom') {
      flush();
      out.push(<Fragment key={key}>{tok.node}</Fragment>);
    } else {
      flush();
      const kids = renderToks(tok.children, `${key}.`);
      if (tok.kind === 'strong') out.push(<strong key={key}>{kids}</strong>);
      else if (tok.kind === 'em') out.push(<em key={key}>{kids}</em>);
      else if (tok.kind === 'underline') out.push(<span key={key} className="underline">{kids}</span>);
      else out.push(<span key={key} className="line-through">{kids}</span>);
    }
  });
  flush();
  return out;
}

function plainToks(toks: Tok[]): string {
  let out = '';
  for (const tok of toks) {
    if (tok.t === 'text') out += tok.v;
    else if (tok.t === 'delim') out += tok.ch.repeat(tok.n);
    else if (tok.t === 'atom') out += tok.text;
    else out += plainToks(tok.children);
  }
  return out;
}

/**
 * Tokenises a message body. Mentions are stored inline in `text`:
 *   <@userId>             → user
 *   <@userId:DisplayName> → user with name override
 *   <@type:id|Label>      → entity reference — clickable chip
 * The `members` map resolves userId → display name for the user variants.
 * Returns null for an empty body.
 */
function tokenize(text: string, members?: Map<string, string>): Tok[] | null {
  const segments = parseChatTokens(text);
  if (segments.length === 0) return null;

  const atoms: Atom[] = [];
  let flat = '';
  const keyCounts = new Map<string, number>();
  const nextKey = (base: string) => {
    const n = keyCounts.get(base) ?? 0;
    keyCounts.set(base, n + 1);
    return `${base}-${n}`;
  };

  for (const seg of segments) {
    if (seg.kind === 'text') {
      flat += seg.text.replaceAll(ATOM, '�');
    } else if (seg.kind === 'user') {
      const isEveryone = seg.userId === 'everyone';
      const name = isEveryone ? 'everyone' : (seg.displayName ?? members?.get(seg.userId) ?? seg.userId);
      flat += ATOM;
      atoms.push({
        node: (
          <span
            key={nextKey(`u-${seg.userId}`)}
            className="inline-block bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 rounded px-1.5 py-0.5 text-[12px] font-medium align-middle"
          >
            @{name}
          </span>
        ),
        text: `@${name}`,
      });
    } else {
      flat += ATOM;
      atoms.push({
        node: (
          <EntityMentionChip
            key={nextKey(`e-${seg.entityType}-${seg.entityId}`)}
            type={seg.entityType}
            id={seg.entityId}
            fallbackLabel={seg.label}
          />
        ),
        text: `@${seg.label ?? `${seg.entityType}:${seg.entityId}`}`,
      });
    }
  }

  const emphasis = flat.length <= MAX_EMPHASIS_CHARS;
  const lexed = lex(flat, atoms, emphasis);
  return emphasis ? applyEmphasis(lexed) : lexed;
}

/** Render message content with @mention badges, entity chips, links and inline formatting. */
export function renderMessageContent(text: string, members?: Map<string, string>): ReactNode {
  const toks = tokenize(text, members);
  if (!toks) return text;
  const nodes = renderToks(toks, 'm');
  if (nodes.length === 0) return text;
  if (nodes.length === 1 && typeof nodes[0] === 'string') return nodes[0];
  return nodes;
}

/**
 * One-line plain text of a message, for previews that cannot hold the rendered
 * form (reply quotes, the pinned bar, search results, drafts): mentions read
 * `@Name`, record chips `@Label`, formatting markers are dropped by the same
 * rules the message body uses, and line breaks collapse to single spaces.
 */
export function messagePreviewText(text: string, members?: Map<string, string>): string {
  const toks = tokenize(text, members);
  return (toks ? plainToks(toks) : text).replace(/\s+/g, ' ').trim();
}
