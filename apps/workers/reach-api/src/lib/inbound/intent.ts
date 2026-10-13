/**
 * The one reply intent decided by rule instead of by the model: the person
 * asks to be removed. It must never wait for a classification, a missing
 * wallet or an AI outage; an opt-out is honoured at once.
 */

import { trimEnd } from '@weldsuite/reach-domain/inbound/strings';
import { normalizeSubject } from '@weldsuite/reach-domain/inbound/text';

/** Words that may surround an opt-out request without changing it ("please unsubscribe me now"). */
const FILLER_WORDS = new Set([
  'please', 'pls', 'kindly', 'me', 'us', 'now', 'asap', 'mij', 'ons', 'nu', 'alsjeblieft', 'alstublieft', 'graag', 'bitte', 'jetzt',
]);

/** What is left of a line once the filler words are gone, when it is an opt-out (English, Dutch, German, French). */
const OPT_OUT_PHRASES = new Set([
  'stop',
  'stop emailing',
  'stop mailing',
  'stop sending',
  'stop contacting',
  'unsubscribe',
  'remove',
  'remove from list',
  'remove from your list',
  'remove from the list',
  'remove from this list',
  'remove from your mailing list',
  'remove from the mailing list',
  'remove from your database',
  'opt out',
  'opt-out',
  'optout',
  'afmelden',
  'uitschrijven',
  'schrijf uit',
  'verwijder',
  'verwijder van de lijst',
  'verwijder van jullie lijst',
  'abmelden',
  'austragen',
  'aus verteiler streichen',
  'aus dem verteiler entfernen',
  'désabonner',
  'desabonner',
  'désinscription',
  'desinscription',
  'désinscrire',
  'desinscrire',
]);

/** Reply bodies longer than this are conversation, not a bare opt-out sent as a subject-only email. */
const SUBJECT_ONLY_MAX_BODY = 300;

/** A line that is nothing but an opt-out request. */
function isOptOutLine(line: string): boolean {
  const words = trimEnd(line.trim().toLowerCase(), '.!').split(/\s+/);
  const core = words.filter((word) => !FILLER_WORDS.has(word)).join(' ');
  return OPT_OUT_PHRASES.has(core);
}

/**
 * `replyText` is the reply without the quoted history. True when the first
 * non-empty line is just an opt-out word, or the subject is "unsubscribe"
 * (what a mail client's List-Unsubscribe `mailto:` sends) with next to no body.
 */
export function isUnsubscribeRequest(subject: string, replyText: string): boolean {
  const firstLine = replyText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (firstLine !== undefined && isOptOutLine(firstLine)) return true;

  const bareSubject = trimEnd(normalizeSubject(subject).toLowerCase(), '.! \t');
  return bareSubject === 'unsubscribe' && replyText.trim().length <= SUBJECT_ONLY_MAX_BODY;
}
