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

/**
 * Public mailbox providers anyone can sign up at. A company never sends
 * account or billing mail from one of these.
 */
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.nl',
  'live.com',
  'live.nl',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'ymail.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'web.de',
  'mail.com',
  'mail.ru',
  'inbox.ru',
  'list.ru',
  'bk.ru',
  'yandex.ru',
  'yandex.com',
  'inbox.lv',
  'proton.me',
  'protonmail.com',
  'zoho.com',
  'tutanota.com',
  'tuta.io',
  'orange.fr',
  'wanadoo.fr',
  'free.fr',
  'laposte.net',
  'libero.it',
  'seznam.cz',
  'wp.pl',
  'o2.pl',
  'onet.pl',
  'interia.pl',
  'qq.com',
  '163.com',
  '126.com',
  'rediffmail.com',
]);

/**
 * Brands phishers put in the From display name. Matched as whole words, so
 * only names distinctive enough not to be someone's first name or a common
 * word are listed (no "apple", "visa", "chase", "outlook").
 */
const IMPERSONATED_BRANDS = [
  'american express',
  'amex',
  'paypal',
  'apple id',
  'apple support',
  'icloud',
  'microsoft',
  'office 365',
  'microsoft 365',
  'netflix',
  'amazon',
  'docusign',
  'dhl',
  'fedex',
  'postnl',
  'mastercard',
  'ing bank',
  'rabobank',
  'abn amro',
  'bunq',
  'belastingdienst',
  'digid',
  'coinbase',
  'binance',
  'metamask',
  'wells fargo',
  'bank of america',
  'chase bank',
  'facebook',
  'instagram',
  'whatsapp',
  'linkedin',
  'dropbox',
  'adobe',
  'norton',
  'mcafee',
  'ebay',
  'booking com',
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
  const angle = /<([^<>]+)>/.exec(raw);
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
  const embedded = /(?<![a-z0-9._%+-])([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i.exec(name);
  if (embedded) {
    const embeddedEmail = embedded[1]!.toLowerCase();
    if (embeddedEmail !== fromEmail && domainOf(embeddedEmail) !== fromDomain) {
      return true;
    }
  }

  return false;
}

/**
 * Brand impersonation: the display name names a well-known company while the
 * address is a free mailbox, e.g. "American Express" <donotreply@inbox.lv>.
 * Such mail passes SPF/DKIM/DMARC (the free provider signs it), so the auth
 * signals never see it.
 */
function isBrandOnFreeMail(from: { email: string; name?: string }): boolean {
  const fromDomain = domainOf(from.email);
  if (!fromDomain || !FREE_MAIL_DOMAINS.has(fromDomain)) return false;
  const words = (from.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!words) return false;
  const padded = ` ${words} `;
  return IMPERSONATED_BRANDS.some((brand) => padded.includes(` ${brand} `));
}

interface SpamSignal {
  points: number;
  reason: string;
}

/** SPF / DKIM / DMARC signals (in evaluation order). */
function authSignals(email: SpamScoreEmail): SpamSignal[] {
  const spf = email.spfStatus ?? null;
  const dkim = email.dkimStatus ?? null;
  const dmarc = email.dmarcStatus ?? null;
  const signals: SpamSignal[] = [];

  if (dmarc === 'fail') signals.push({ points: 3, reason: 'dmarc_fail' });
  if (isAuthFail(spf)) {
    signals.push({ points: 2, reason: spf === 'softfail' ? 'spf_softfail' : 'spf_fail' });
  }
  if (dkim === 'fail') signals.push({ points: 2, reason: 'dkim_fail' });

  if (isAuthFail(spf) && dkim === 'fail' && dmarc === 'fail') {
    signals.push({ points: 2, reason: 'auth_all_fail' });
  } else if (isAuthAbsent(spf) && isAuthAbsent(dkim) && isAuthAbsent(dmarc)) {
    signals.push({ points: 1, reason: 'auth_all_missing' });
  }
  return signals;
}

function subjectSignals(subject: string): SpamSignal[] {
  if (!subject) return [];
  const { lexicon, shouting } = subjectLooksSpammy(subject);
  const signals: SpamSignal[] = [];
  if (lexicon) signals.push({ points: 2, reason: 'subject_spam_lexicon' });
  if (shouting) signals.push({ points: 1, reason: 'subject_shouting' });
  return signals;
}

function bodySignals(email: SpamScoreEmail): SpamSignal[] {
  const bodyText = `${email.textBody ?? ''}\n${email.htmlBody ?? ''}`;
  if (!bodyText.trim()) return [];
  const { manyLinks, shortener } = bodyLinkSignals(bodyText);
  if (!manyLinks && !shortener) return [];
  return [{ points: 2, reason: manyLinks ? 'body_many_links' : 'body_url_shortener' }];
}

/** Sender identity signals: display-name spoof and Reply-To domain mismatch. */
function senderSignals(email: SpamScoreEmail, recipients: string[]): SpamSignal[] {
  const signals: SpamSignal[] = [];
  if (isDisplayNameSpoof(email.from, recipients)) {
    signals.push({ points: 3, reason: 'from_display_spoof' });
  }
  // Spam on its own: no real brand sends from a free mailbox. A reply in an
  // existing ham thread is still capped below the threshold.
  if (isBrandOnFreeMail(email.from)) {
    signals.push({ points: SPAM_SCORE_THRESHOLD, reason: 'from_brand_free_mail' });
  }

  const replyTo = parseReplyToEmail(headerValue(email.headers, 'reply-to'));
  const fromDomain = domainOf(email.from.email);
  const replyDomain = replyTo ? domainOf(replyTo) : null;
  if (replyDomain && fromDomain && replyDomain !== fromDomain) {
    signals.push({ points: 1, reason: 'reply_to_domain_mismatch' });
  }
  return signals;
}

/**
 * Score an inbound message. Does not mutate input.
 */
export function scoreInboundSpam(
  email: SpamScoreEmail,
  options: SpamScoreOptions = {},
): SpamScoreResult {
  const attachmentNames = options.attachmentNames ?? [];
  const recipients =
    options.recipientEmails ??
    (email.to ?? []).map((t) => t.email).filter(Boolean);

  const signals: SpamSignal[] = [
    ...authSignals(email),
    ...(attachmentNames.length > 0 && hasExecutableAttachment(attachmentNames)
      ? [{ points: 4, reason: 'executable_attachment' }]
      : []),
    ...subjectSignals(email.subject ?? ''),
    ...bodySignals(email),
    ...senderSignals(email, recipients),
  ];

  let score = signals.reduce((sum, signal) => sum + signal.points, 0);
  const reasons = signals.map((signal) => signal.reason);

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
