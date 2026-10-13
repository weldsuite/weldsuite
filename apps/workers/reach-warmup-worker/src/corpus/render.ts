/** Turns a corpus message into the subject and text one mailbox sends. */

import type { CorpusPerson, CorpusThread, RenderedCorpusMessage } from './types';

type PlaceholderValues = Readonly<Record<string, string>>;

// Cleanup patterns for text where a placeholder rendered empty.
const COLLAPSE_SPACES = / {2,}/g;
const SPACE_BEFORE_PUNCTUATION = / ([,.;:!?])/g;
const BLANK_LINE_RUNS = /\n{3,}/g;

function cleanName(value: string): string {
  return value.replaceAll(/[{}]/g, '').trim();
}

/** Spaces left behind by a placeholder that rendered empty: "Hi ," becomes "Hi,". */
function tidyAfterBlank(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(COLLAPSE_SPACES, ' ').replace(SPACE_BEFORE_PUNCTUATION, '$1').trimEnd())
    .join('\n')
    .replace(BLANK_LINE_RUNS, '\n\n')
    .trim();
}

/**
 * Replace `{{name}}` placeholders. One left-to-right scan with `indexOf`, so the
 * cost is linear in the template whatever it contains. An unknown placeholder or
 * a blank value renders as nothing (with the spacing around it tidied), and no
 * `{{` survives in the output.
 */
export function fillPlaceholders(template: string, values: PlaceholderValues): string {
  let out = '';
  let pos = 0;
  let blanked = false;
  for (;;) {
    const open = template.indexOf('{{', pos);
    if (open === -1) {
      out += template.slice(pos);
      break;
    }
    out += template.slice(pos, open);
    const close = template.indexOf('}}', open + 2);
    if (close === -1) {
      // No "}}" anywhere after this opener, so none of the later "{{" can close either:
      // drop the openers and keep the text (one pass, not a rescan per opener).
      out += template.slice(open + 2).replaceAll('{{', '');
      blanked = true;
      break;
    }
    const name = template.slice(open + 2, close).trim();
    const value = Object.hasOwn(values, name) ? cleanName(values[name] ?? '') : '';
    if (value === '') blanked = true;
    out += value;
    pos = close + 2;
  }
  return blanked ? tidyAfterBlank(out) : out;
}

function stripReplyPrefix(subject: string): string {
  let rest = subject.trim();
  while (rest.length >= 3 && rest.slice(0, 3).toLowerCase() === 're:') rest = rest.slice(3).trim();
  return rest;
}

/**
 * Subject and text of message `step` (0-based) of `thread`. `sender` is the
 * person writing this message and `recipient` the person it goes to, so
 * `{{sender*}}` and `{{recipient*}}` in the body follow the step, not the
 * thread's original starter. Step 0 keeps the subject, replies get "Re: ".
 */
export function renderCorpusMessage(
  thread: CorpusThread,
  step: number,
  sender: CorpusPerson,
  recipient: CorpusPerson,
): RenderedCorpusMessage {
  const message = Number.isInteger(step) && step >= 0 ? thread.messages[step] : undefined;
  if (!message) {
    throw new Error(
      `renderCorpusMessage: step ${step} is out of range for thread "${thread.id}" (${thread.messages.length} messages)`,
    );
  }
  const values: PlaceholderValues = {
    senderFirstName: sender.firstName,
    senderLastName: sender.lastName,
    recipientFirstName: recipient.firstName,
    recipientLastName: recipient.lastName,
  };
  const subject = stripReplyPrefix(fillPlaceholders(thread.subject, values).replaceAll(/\s+/g, ' '));
  return {
    subject: step === 0 ? subject : `Re: ${subject}`,
    text: fillPlaceholders(message.body, values),
  };
}
