/**
 * Reads a message's `threats` (EU and self-hosted editions) into what the
 * threat banner shows. A message with an infected attachment or a malicious
 * link was moved to Spam by the server; one with only suspicious links stays
 * where it is.
 */

import type { MailThreat } from '@weldsuite/app-api-client/schemas/mail-messages';
import { parseHttpUrl } from './link-protection';

export type ThreatSeverity = 'danger' | 'warning';

export interface ThreatSummary {
  severity: ThreatSeverity;
  /** Blocked files, once per attachment. */
  files: { fileName: string; signature: string }[];
  /** Flagged link hosts, once per host and verdict, dangerous ones first. */
  links: { host: string; verdict: 'malicious' | 'suspicious' }[];
}

/** The host to show for a link; the raw text when it does not parse. */
export function linkHost(url: string): string {
  return parseHttpUrl(url)?.host ?? url.slice(0, 80);
}

/** The banner's content, or null when the message has no threats. */
export function summarizeThreats(threats: readonly MailThreat[] | null | undefined): ThreatSummary | null {
  if (!threats || threats.length === 0) return null;

  const files: ThreatSummary['files'] = [];
  const links: ThreatSummary['links'] = [];
  const seenFiles = new Set<string>();
  const seenLinks = new Set<string>();

  for (const threat of threats) {
    if (threat.kind === 'attachment') {
      const key = threat.attachmentId ?? `${threat.fileName}|${threat.signature}`;
      if (seenFiles.has(key)) continue;
      seenFiles.add(key);
      files.push({ fileName: threat.fileName, signature: threat.signature });
    } else {
      const host = linkHost(threat.url);
      const key = `${threat.verdict}|${host}`;
      if (seenLinks.has(key)) continue;
      seenLinks.add(key);
      links.push({ host, verdict: threat.verdict });
    }
  }
  links.sort((a, b) => Number(b.verdict === 'malicious') - Number(a.verdict === 'malicious'));

  const dangerous = files.length > 0 || links.some((link) => link.verdict === 'malicious');
  return { severity: dangerous ? 'danger' : 'warning', files, links };
}
