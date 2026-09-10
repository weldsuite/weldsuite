/**
 * Heuristic inbound spam scorer for WeldMail.
 *
 * Pure functions — no DB / network. Callers (workspace + personal store paths)
 * pass auth results, body snippets, attachment names, and an optional
 * "existing ham thread" flag that caps the score so conversation continuations
 * are not auto-quarantined.
 */

/** Score at or above this value is treated as spam. */
export const SPAM_SCORE_THRESHOLD = 5;

const EXECUTABLE_EXTENSIONS = new Set([
  'exe',
  'scr',
  'bat',
  'cmd',
  'js',
  'vbs',
  'ps1',
  'msi',
]);

const URL_SHORTENER_HOSTS = new Set([
  'bit.ly',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'ow.ly',
  'is.gd',
  'buff.ly',
  'cutt.ly',
  'rebrand.ly',
]);

/** EN + common NL subject/body spam lexicon (word / short phrase). */
const SPAM_LEXICON = [
  'viagra',
  'cialis',
  'pharmacy',
  'lottery',
  'winner',
  'jackpot',
  'nigerian prince',
  'wire transfer',
  'urgent wire',
  'million dollars',
  'crypto giveaway',
  'claim your prize',
  'act now',
  'limited time offer',
  'weight loss',
  'free money',
  'casino',
  'klik hier nu',
  'gratis geld',
  'gewonnen',
  'loterij',
  'urgent overschrijving',
];

export interface SpamScoreEmail {
  from: { email: string; name?: string };
  to?: { email: string; name?: string }[];
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
  headers?: Record<string, string>;
  spfStatus?: string | null;
  dkimStatus?: string | null;
  dmarcStatus?: string | null;
}

export interface SpamScoreOptions {
  attachmentNames?: string[];
  /**
   * When the message continues an already-stored non-spam thread for this
   * account, cap the score at THRESHOLD − 1 so replies are not auto-spammed.
   */
  isExistingHamThread?: boolean;
  /** Recipient mailbox addresses (for display-name spoof checks). */
  recipientEmails?: string[];
}

export interface SpamScoreResult {
  score: number;
  reasons: string[];
  isSpam: boolean;
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase() || null;
}

function isAuthFail(status: string | null | undefined): boolean {
  return status === 'fail' || status === 'softfail';
}

function isAuthAbsent(status: string | null | undefined): boolean {
  return !status || status === 'none';
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Extract email address from a raw Reply-To header value. */
function parseReplyToEmail(raw: string | undefined): string | null {
  if (!raw) return null;
  const angle = /<([^>]+)>/.exec(raw);
  const candidate = (angle?.[1] ?? raw).trim().toLowerCase();
  return candidate.includes('@') ? candidate : null;
}

function subjectLooksSpammy(subject: string): { lexicon: boolean; shouting: boolean } {
  const lower = subject.toLowerCase();
  const lexicon = SPAM_LEXICON.some((term) => lower.includes(term));

  const letters = subject.replace(/[^a-zA-Z]/g, '');
  const upper = subject.replace(/[^A-Z]/g, '');
  const shouting =
    (letters.length >= 8 && upper.length / letters.length >= 0.6) ||
    (subject.match(/!/g)?.length ?? 0) >= 3;

  return { lexicon, shouting };
}

function bodyLinkSignals(text: string): { manyLinks: boolean; shortener: boolean } {
  const slice = text.slice(0, 2000);
  const urls = slice.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  const manyLinks = urls.length >= 5;
  const shortener = urls.some((u) => {
    try {
      const host = new URL(u).hostname.toLowerCase().replace(/^www\./, '');
      return URL_SHORTENER_HOSTS.has(host);
    } catch {
      return false;
    }
  });
  return { manyLinks, shortener };
}

function hasExecutableAttachment(names: string[]): boolean {
  return names.some((name) => {
    const base = name.split(/[/\\]/).pop() ?? name;
    const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
    return EXECUTABLE_EXTENSIONS.has(ext);
  });
}

/**
 * Display-name spoof: From name looks like an email / support identity for the
 * recipient's domain while the actual From address is elsewhere.
 */
function isDisplayNameSpoof(
  from: { email: string; name?: string },
  recipientEmails: string[],
): boolean {
  const name = (from.name ?? '').trim();
  if (!name) return false;

  const fromEmail = from.email.toLowerCase();
  const fromDomain = domainOf(fromEmail);
  const nameLower = name.toLowerCase();
  const nameLooksLikeEmail = /@/.test(name) || /^support\b/i.test(name) || /^noreply\b/i.test(name);

  if (!nameLooksLikeEmail && recipientEmails.length === 0) return false;

  for (const recipient of recipientEmails) {
    const recipDomain = domainOf(recipient);
    if (!recipDomain) continue;

    const spoofsRecipientDomain =
      nameLower.includes(recipDomain) ||
      nameLower.includes(`support@${recipDomain}`) ||
      nameLower.includes(`@${recipDomain}`);

    if (spoofsRecipientDomain && fromDomain !== recipDomain) {
      return true;
    }
  }

  // Name embeds an email address that differs from the actual From.
  const embedded = /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i.exec(name);
  if (embedded) {
    const embeddedEmail = embedded[1]!.toLowerCase();
    if (embeddedEmail !== fromEmail && domainOf(embeddedEmail) !== fromDomain) {
      return true;
    }
  }

  return false;
}

/**
 * Score an inbound message. Does not mutate input.
 */
export function scoreInboundSpam(
  email: SpamScoreEmail,
  options: SpamScoreOptions = {},
): SpamScoreResult {
  let score = 0;
  const reasons: string[] = [];

  const spf = email.spfStatus ?? null;
  const dkim = email.dkimStatus ?? null;
  const dmarc = email.dmarcStatus ?? null;

  if (dmarc === 'fail') {
    score += 3;
    reasons.push('dmarc_fail');
  }
  if (isAuthFail(spf)) {
    score += 2;
    reasons.push(spf === 'softfail' ? 'spf_softfail' : 'spf_fail');
  }
  if (dkim === 'fail') {
    score += 2;
    reasons.push('dkim_fail');
  }
  if (isAuthFail(spf) && dkim === 'fail' && dmarc === 'fail') {
    score += 2;
    reasons.push('auth_all_fail');
  } else if (isAuthAbsent(spf) && isAuthAbsent(dkim) && isAuthAbsent(dmarc)) {
    score += 1;
    reasons.push('auth_all_missing');
  }

  const attachmentNames = options.attachmentNames ?? [];
  if (attachmentNames.length > 0 && hasExecutableAttachment(attachmentNames)) {
    score += 4;
    reasons.push('executable_attachment');
  }

  const subject = email.subject ?? '';
  if (subject) {
    const { lexicon, shouting } = subjectLooksSpammy(subject);
    if (lexicon) {
      score += 2;
      reasons.push('subject_spam_lexicon');
    }
    if (shouting) {
      score += 1;
      reasons.push('subject_shouting');
    }
  }

  const bodyText = `${email.textBody ?? ''}\n${email.htmlBody ?? ''}`;
  if (bodyText.trim()) {
    const { manyLinks, shortener } = bodyLinkSignals(bodyText);
    if (manyLinks || shortener) {
      score += 2;
      reasons.push(manyLinks ? 'body_many_links' : 'body_url_shortener');
    }
  }

  const recipients =
    options.recipientEmails ??
    (email.to ?? []).map((t) => t.email).filter(Boolean);

  if (isDisplayNameSpoof(email.from, recipients)) {
    score += 3;
    reasons.push('from_display_spoof');
  }

  const replyTo = parseReplyToEmail(headerValue(email.headers, 'reply-to'));
  const fromDomain = domainOf(email.from.email);
  const replyDomain = replyTo ? domainOf(replyTo) : null;
  if (replyDomain && fromDomain && replyDomain !== fromDomain) {
    score += 1;
    reasons.push('reply_to_domain_mismatch');
  }

  if (options.isExistingHamThread && score >= SPAM_SCORE_THRESHOLD) {
    const capped = SPAM_SCORE_THRESHOLD - 1;
    if (score > capped) {
      reasons.push('capped_existing_ham_thread');
      score = capped;
    }
  }

  return {
    score,
    reasons,
    isSpam: score >= SPAM_SCORE_THRESHOLD,
  };
}
