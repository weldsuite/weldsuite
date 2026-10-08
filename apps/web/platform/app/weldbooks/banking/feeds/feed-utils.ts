/**
 * Pure helpers of the bank feed screens: statuses, dates, account types, and
 * the URLs a link comes back to.
 */
import type {
  BankFeedAccount,
  BankFeedBankAccountType,
  BankFeedConnection,
  BankFeedConnectionStatus,
} from '@/lib/api/domains/weldbooks-bank-feeds';
import type { BankAccount } from '@/lib/api/domains/weldbooks';

export const FEEDS_PATH = '/weldbooks/banking/feeds';
export const FEEDS_CALLBACK_PATH = '/weldbooks/banking/feeds/callback';

/** The URL banks send the browser back to: Plaid OAuth, Ponto and Enable Banking redirects. */
export function bankFeedRedirectUrl(origin: string): string {
  return `${origin}${FEEDS_CALLBACK_PATH}`;
}

export type StatusBadgeVariant = 'success' | 'warning' | 'destructive' | 'secondary';

export const STATUS_BADGE_VARIANT: Record<BankFeedConnectionStatus, StatusBadgeVariant> = {
  active: 'success',
  reauth_required: 'warning',
  expiring: 'warning',
  revoked: 'destructive',
  disconnected: 'secondary',
  error: 'destructive',
};

/** Statuses the bank sign-in repairs: the connection stays, the user signs in again. */
export function needsReauth(status: BankFeedConnectionStatus): boolean {
  return status === 'reauth_required' || status === 'expiring';
}

/** The connection is gone at the bank (or by choice): linking again creates a new one. */
export function isEnded(status: BankFeedConnectionStatus): boolean {
  return status === 'revoked' || status === 'disconnected';
}

export function mappedAccounts(connection: BankFeedConnection): BankFeedAccount[] {
  return connection.accounts.filter((a) => a.bankAccountId);
}

export function unmappedAccounts(connection: BankFeedConnection): BankFeedAccount[] {
  return connection.accounts.filter((a) => !a.bankAccountId);
}

/** A sync reads mapped accounts of a connection the bank still lets us in to. */
export function canSyncNow(connection: BankFeedConnection): boolean {
  if (connection.status !== 'active' && connection.status !== 'expiring' && connection.status !== 'error') return false;
  return mappedAccounts(connection).length > 0;
}

/** Whole days from `now` until `iso`, rounded up; negative once past. */
export function daysUntil(iso: string, now: Date = new Date()): number {
  return Math.ceil((new Date(iso).getTime() - now.getTime()) / 86_400_000);
}

const RELATIVE_STEPS: Array<{ unit: Intl.RelativeTimeFormatUnit; seconds: number }> = [
  { unit: 'year', seconds: 365 * 86_400 },
  { unit: 'month', seconds: 30 * 86_400 },
  { unit: 'day', seconds: 86_400 },
  { unit: 'hour', seconds: 3_600 },
  { unit: 'minute', seconds: 60 },
];

/** "5 minutes ago", "yesterday", "in 3 days", in the UI language. */
export function formatRelativeTime(iso: string, locale: string, now: Date = new Date()): string {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return '';
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const diffSeconds = Math.round((target - now.getTime()) / 1000);
  const abs = Math.abs(diffSeconds);
  for (const { unit, seconds } of RELATIVE_STEPS) {
    if (abs >= seconds) return rtf.format(Math.round(diffSeconds / seconds), unit);
  }
  return rtf.format(0, 'second');
}

/** The WeldBooks bank account type a feed account becomes, as books-api would pick it. */
export function defaultBankAccountType(account: Pick<BankFeedAccount, 'type' | 'subtype'>): BankFeedBankAccountType {
  switch (account.subtype) {
    case 'savings':
      return 'savings';
    case 'money_market':
      return 'money_market';
    case 'credit_card':
      return 'credit_card';
    case 'line_of_credit':
      return 'line_of_credit';
    default:
      break;
  }
  if (account.type === 'credit') return 'credit_card';
  if (account.type === 'loan') return 'line_of_credit';
  return 'checking';
}

/** How many days of history the first sync reaches: the smaller of what the provider allows and what was asked for. */
export function historyDaysOf(connection: Pick<BankFeedConnection, 'capabilities' | 'historyDays'>): number | null {
  const max = connection.capabilities?.maxHistoryDays ?? null;
  const asked = connection.historyDays ?? null;
  if (max !== null && asked !== null) return Math.min(max, asked);
  return max ?? asked;
}

/** A WeldBooks bank account as the feed screens read it: the list endpoint returns the feed columns too. */
export type FeedBankAccount = BankAccount & {
  feedConnectionId?: string | null;
  feedStatus?: string | null;
  accountType?: string | null;
};

/**
 * Bank accounts a feed account of this connection may be linked to: active
 * ones that no other live bank connection feeds. (books-api answers 409 for
 * the rest; leaving them out saves the round trip.)
 */
export function linkableBankAccounts(accounts: FeedBankAccount[], connectionId: string): FeedBankAccount[] {
  return accounts.filter((account) => {
    if (account.isActive === false) return false;
    if (!account.feedConnectionId || account.feedConnectionId === connectionId) return true;
    return account.feedStatus === 'disconnected' || account.feedStatus === 'revoked';
  });
}
