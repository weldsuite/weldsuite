/** Web addresses in message text, so they can be shown and opened as links. */

export interface TextLink {
  /** Where the link starts and ends in the text. */
  start: number;
  end: number;
  /** As written in the message. */
  text: string;
  /** What to open: `www.` addresses get https. */
  href: string;
}

// A web address in running text; trailing punctuation stays out of the link.
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<]*[^\s<.,:;"')\]!?]/gi;

export function findLinks(text: string): TextLink[] {
  const links: TextLink[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const url = match[0];
    links.push({
      start,
      end: start + url.length,
      text: url,
      href: /^https?:\/\//i.test(url) ? url : `https://${url}`,
    });
  }
  return links;
}
