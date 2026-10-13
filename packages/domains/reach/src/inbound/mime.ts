/**
 * The text of a stored message, with postal-mime doing the MIME work. The
 * inbox shows it when it opens a thread; reach-api's inbound pipeline parses
 * the same way (`parseInbound`) and shares `bodyText`.
 */

import PostalMime, { type Email } from 'postal-mime';
import { htmlToText } from './text';

/** The message's text: its text part, or the HTML part converted to text. */
export function bodyText(email: Email): string {
  if (email.text && email.text.trim() !== '') return email.text;
  if (email.html && email.html.trim() !== '') return htmlToText(email.html);
  return '';
}

/** The text of one stored message (used when the inbox shows a thread): its text part or converted HTML. */
export async function extractMessageText(raw: Uint8Array): Promise<string> {
  const email = await PostalMime.parse(raw);
  return bodyText(email);
}
