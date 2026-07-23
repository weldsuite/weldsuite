import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { isNetworkError } from '@weldsuite/api-client/client';
import appApi from '@/services/app-api';
import { isSystemLabel } from '@/utils/label-utils';
import { mailCache, scopeKey } from '@/lib/offline/cache';
import { useCacheOrgId } from '@/hooks/useCacheOrgId';

export interface MailLabel {
  id: string;
  name: string;
  slug: string;
  count?: number;
  color?: string;
}

export const MAIN_LABELS: MailLabel[] = [
  { id: 'inbox', name: 'Inbox', slug: 'INBOX' },
  { id: 'starred', name: 'Starred', slug: 'STARRED' },
  { id: 'sent', name: 'Sent', slug: 'SENT' },
  { id: 'drafts', name: 'Drafts', slug: 'DRAFTS' },
];

export const SECONDARY_LABELS: MailLabel[] = [
  { id: 'scheduled', name: 'Scheduled', slug: 'SCHEDULED' },
  { id: 'snoozed', name: 'Snoozed', slug: 'SNOOZED' },
  { id: 'important', name: 'Important', slug: 'IMPORTANT' },
  { id: 'all', name: 'All Mail', slug: 'ALL' },
  { id: 'archive', name: 'Archive', slug: 'ARCHIVE' },
  { id: 'spam', name: 'Spam', slug: 'SPAM' },
  { id: 'trash', name: 'Trash', slug: 'TRASH' },
];

export const DEFAULT_LABELS: MailLabel[] = [...MAIN_LABELS, ...SECONDARY_LABELS];

interface MailAccount {
  id: string;
  emailAddress: string;
  displayName: string;
  provider?: string;
  isDefault?: boolean;
  isActive?: boolean;
}

const STORAGE_KEY_SELECTED_ACCOUNT = '@weldmail_selected_account';

export function getAvatarColor(name: string): string {
  const avatarColors = [
    '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444',
    '#06B6D4', '#EC4899', '#F97316', '#14B8A6', '#6366F1',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return avatarColors[Math.abs(hash) % avatarColors.length];
}

interface MailContextValue {
  labels: MailLabel[];
  mainLabels: MailLabel[];
  secondaryLabels: MailLabel[];
  customLabels: MailLabel[];
  selectedLabel: string;
  setSelectedLabel: (slug: string) => void;
  accounts: MailAccount[];
  selectedAccount: MailAccount | null;
  isUnifiedInbox: boolean;
  selectAccount: (account: MailAccount) => void;
  selectUnifiedInbox: () => void;
  isLoading: boolean;
  refreshLabels: () => Promise<void>;
  refreshAccounts: () => Promise<void>;
  updateLabelCount: (slug: string, count: number) => void;
  // Bumped whenever a message mutation happens on another screen (e.g. the
  // detail page archiving/starring), so the inbox can re-sync deterministically
  // without relying on navigation focus events.
  mailVersion: number;
  refreshMail: () => void;
}

const MailContext = createContext<MailContextValue | undefined>(undefined);

export function MailProvider({ children }: { children: React.ReactNode }) {
  // Gate data fetching on auth readiness. The app-api client throws when no
  // Clerk token is available yet; MailProvider mounts above the AuthGuard, so
  // without this gate the initial fetch fires before the token is wired and
  // silently leaves the account list empty (it never retries).
  const { user, organizationId } = useClerkAuth();
  // Latched cache-scope id — stable across Clerk's flaky iOS org re-hydration,
  // so the accounts/labels we persist here land under the SAME bucket the
  // message cache (`useMailCache`) reads from. Null only on the very first
  // launch before any org id is known.
  const cacheOrgId = useCacheOrgId();
  const [mainLabelCounts, setMainLabelCounts] = useState<Record<string, number>>({});
  const [secondaryLabelCounts, setSecondaryLabelCounts] = useState<Record<string, number>>({});
  const [customLabels, setCustomLabels] = useState<MailLabel[]>([]);
  const [selectedLabel, setSelectedLabel] = useState('INBOX');
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<MailAccount | null>(null);
  const [isUnifiedInbox, setIsUnifiedInbox] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [mailVersion, setMailVersion] = useState(0);
  const initializedRef = useRef(false);
  // Active org id, so a workspace switch can clear the previous org's mailbox
  // instead of showing its accounts/labels until the next fetch.
  const prevOrgIdRef = useRef<string | null>(null);
  // Mirror of the latched cache-scope id in a ref so the cache read/write inside
  // the dependency-stable fetchAccounts/fetchLabels callbacks always sees the
  // current org without forcing those callbacks to re-create on every switch.
  // Null → skip the cache entirely (first launch, nothing to persist yet).
  const orgIdRef = useRef<string | null>(null);
  orgIdRef.current = cacheOrgId;
  // Bumped after a failed initial fetch to re-trigger the init effect. The
  // first account fetch can briefly race ahead of Clerk's org-scoped token
  // (app-api returns 403 ORG_REQUIRED until the JWT carries the active org);
  // retrying a few times lets it self-heal instead of leaving an empty mailbox
  // for the whole session. Bounded so a genuine failure doesn't loop forever.
  const [retryTick, setRetryTick] = useState(0);
  const retryCountRef = useRef(0);
  const MAX_INIT_RETRIES = 5;

  const refreshMail = useCallback(() => setMailVersion(v => v + 1), []);

  const mainLabels = useMemo(() =>
    MAIN_LABELS.map(l => ({ ...l, count: mainLabelCounts[l.slug] ?? l.count })),
    [mainLabelCounts]
  );

  const secondaryLabels = useMemo(() =>
    SECONDARY_LABELS.map(l => ({ ...l, count: secondaryLabelCounts[l.slug] ?? l.count })),
    [secondaryLabelCounts]
  );

  const labels = useMemo(() => [...mainLabels, ...secondaryLabels, ...customLabels], [mainLabels, secondaryLabels, customLabels]);

  // Apply the user's saved mailbox choice (a specific account, or the unified
  // inbox) to a freshly-loaded account list. Extracted so it runs on both the
  // live-fetch and the offline cache-fallback paths.
  const applySavedSelection = useCallback(async (list: MailAccount[]) => {
    if (list.length === 0) return;
    const savedId = await AsyncStorage.getItem(STORAGE_KEY_SELECTED_ACCOUNT);
    if (savedId === 'unified') {
      setIsUnifiedInbox(true);
      setSelectedAccount(null);
    } else if (savedId) {
      const saved = list.find((a) => a.id === savedId);
      if (saved) {
        setIsUnifiedInbox(false);
        setSelectedAccount(saved);
      }
    }
  }, []);

  const fetchAccounts = useCallback(async () => {
    const orgId = orgIdRef.current;
    try {
      const { data: items } = await appApi.mailAccounts.list();
      // Mark a successful fetch so the init effect won't refetch, and clear the
      // retry budget for any future session.
      initializedRef.current = true;
      retryCountRef.current = 0;
      const normalized: MailAccount[] = items.map((a) => ({
        id: a.id,
        emailAddress: a.email,
        displayName: a.displayName ?? a.name ?? a.email,
        provider: a.provider,
        isDefault: a.isDefault,
        isActive: a.status === 'active',
      }));
      setAccounts(normalized);
      // Persist so the next launch (and offline opens) have an account list.
      // Skip while the org id is unknown so we never write to a shared bucket.
      if (orgId) mailCache.setAccounts(orgId, normalized);
      await applySavedSelection(normalized);
    } catch (error) {
      // The first fetch can lose the race against Clerk org activation (the
      // app-api returns 403 ORG_REQUIRED until the session token carries an
      // active org), or the device may simply be offline. Hydrate the cached
      // account list so the mailbox shell still works, reset the guard, and
      // schedule a bounded retry so it self-heals once the network/token is
      // available instead of leaving the mailbox empty for the whole session.
      const cached = orgId ? ((await mailCache.getAccounts(orgId)) as MailAccount[] | null) : null;
      if (cached && cached.length) {
        setAccounts(cached);
        await applySavedSelection(cached);
      }
      initializedRef.current = false;
      if (!isNetworkError(error)) console.error('Failed to fetch accounts:', error);
      if (retryCountRef.current < MAX_INIT_RETRIES) {
        retryCountRef.current += 1;
        setTimeout(() => setRetryTick((t) => t + 1), 600);
      }
    }
  }, [applySavedSelection]);

  const selectAccount = useCallback((account: MailAccount) => {
    setIsUnifiedInbox(false);
    setSelectedAccount(account);
    setCustomLabels([]);
    setMainLabelCounts({});
    setSecondaryLabelCounts({});
    setSelectedLabel('INBOX');
    AsyncStorage.setItem(STORAGE_KEY_SELECTED_ACCOUNT, account.id);
  }, []);

  const selectUnifiedInbox = useCallback(() => {
    setIsUnifiedInbox(true);
    setSelectedAccount(null);
    setCustomLabels([]);
    setMainLabelCounts({});
    setSecondaryLabelCounts({});
    setSelectedLabel('INBOX');
    AsyncStorage.setItem(STORAGE_KEY_SELECTED_ACCOUNT, 'unified');
  }, []);

  const processLabelsResponse = useCallback((items: any[]) => {
    const mainCounts: Record<string, number> = {};
    const secondaryCounts: Record<string, number> = {};
    const custom: MailLabel[] = [];

    for (const item of items) {
      const slug = item.slug || item.name;
      if (item.isSystem || isSystemLabel(slug)) {
        const upperSlug = slug.toUpperCase();
        if (MAIN_LABELS.some(l => l.slug === upperSlug)) {
          mainCounts[upperSlug] = (mainCounts[upperSlug] || 0) + (item.count || item.messageCount || 0);
        } else if (SECONDARY_LABELS.some(l => l.slug === upperSlug)) {
          secondaryCounts[upperSlug] = (secondaryCounts[upperSlug] || 0) + (item.count || item.messageCount || 0);
        }
      } else {
        const existing = custom.find(c => c.name.toLowerCase() === (item.name || slug).toLowerCase());
        if (existing) {
          existing.count = (existing.count || 0) + (item.count || item.messageCount || 0);
        } else {
          custom.push({
            id: item.id || slug,
            name: item.name || slug,
            slug: item.slug || item.name || slug,
            count: item.count || item.messageCount || 0,
            color: item.color,
          });
        }
      }
    }

    return { mainCounts, secondaryCounts, custom };
  }, []);

  // Push computed label state into the UI and persist it for offline reuse.
  const applyLabels = useCallback(
    (scope: string, mainCounts: Record<string, number>, secondaryCounts: Record<string, number>, custom: MailLabel[]) => {
      setMainLabelCounts(mainCounts);
      setSecondaryLabelCounts(secondaryCounts);
      setCustomLabels(custom);
      if (orgIdRef.current) {
        mailCache.setLabels(orgIdRef.current, scope, { mainCounts, secondaryCounts, custom });
      }
    },
    [],
  );

  const fetchLabels = useCallback(async () => {
    const scope = scopeKey(isUnifiedInbox, selectedAccount?.id);
    try {
      if (isUnifiedInbox) {
        if (accounts.length === 0) return;
        const allItems: any[] = [];
        const results = await Promise.allSettled(
          accounts.map(acc => appApi.mailLabels.list({ accountId: acc.id }))
        );
        for (const result of results) {
          if (result.status === 'fulfilled') {
            allItems.push(...result.value.data);
          }
        }
        if (allItems.length > 0) {
          const { mainCounts, secondaryCounts, custom } = processLabelsResponse(allItems);
          applyLabels(scope, mainCounts, secondaryCounts, custom);
        }
      } else if (selectedAccount) {
        const { data: items } = await appApi.mailLabels.list({ accountId: selectedAccount.id });
        if (items.length > 0) {
          const { mainCounts, secondaryCounts, custom } = processLabelsResponse(items);
          applyLabels(scope, mainCounts, secondaryCounts, custom);
        }
      }
    } catch (error) {
      // Offline: fall back to the last cached label counts/custom labels for
      // this scope so the sidebar isn't bare. Only log real (server) errors.
      const cached = orgIdRef.current ? await mailCache.getLabels(orgIdRef.current, scope) : null;
      if (cached) {
        setMainLabelCounts(cached.mainCounts);
        setSecondaryLabelCounts(cached.secondaryCounts);
        setCustomLabels(cached.custom as MailLabel[]);
      }
      if (!isNetworkError(error)) console.error('Failed to fetch labels:', error);
    }
  }, [selectedAccount?.id, isUnifiedInbox, accounts, processLabelsResponse, applyLabels]);

  const refreshLabels = useCallback(async () => {
    await fetchLabels();
  }, [fetchLabels]);

  const refreshAccounts = useCallback(async () => {
    await fetchAccounts();
  }, [fetchAccounts]);

  const updateLabelCount = useCallback((slug: string, count: number) => {
    const upperSlug = slug.toUpperCase();
    if (MAIN_LABELS.some(l => l.slug === upperSlug)) {
      setMainLabelCounts(prev => ({ ...prev, [upperSlug]: count }));
    } else if (SECONDARY_LABELS.some(l => l.slug === upperSlug)) {
      setSecondaryLabelCounts(prev => ({ ...prev, [upperSlug]: count }));
    } else {
      setCustomLabels(prev => prev.map(label =>
        label.slug === slug ? { ...label, count } : label
      ));
    }
  }, []);

  useEffect(() => {
    // Gate the first fetch on `user` only. We intentionally do NOT gate on the
    // `useOrganization()` org id: that hook hydrates unreliably on iOS even
    // when the Clerk session token is already org-scoped, so gating on it can
    // deadlock the fetch on iOS. The app-api still requires the org claim, but
    // the token usually already carries it by the time `user` is set; if it
    // doesn't, the fetch 403s and the catch handler schedules a bounded retry
    // (re-triggered via `retryTick`) so it self-heals. Reset on sign-out so a
    // re-login refetches.
    if (!user) {
      initializedRef.current = false;
      retryCountRef.current = 0;
      return;
    }
    if (!initializedRef.current) {
      initializedRef.current = true;
      fetchAccounts().finally(() => setIsLoading(false));
    }
  }, [user, retryTick, fetchAccounts]);

  // On a workspace/organization switch, clear the previous org's mailbox and
  // refetch for the new one. Sign-in/sign-out (null transitions) are handled by
  // the `user` gate above; this only fires on a real org→org change, so it can't
  // churn on iOS's late org hydration (null→value) — which is why the existing
  // init effect deliberately doesn't gate on the org id.
  useEffect(() => {
    const next = organizationId ?? null;
    const prev = prevOrgIdRef.current;
    prevOrgIdRef.current = next;
    if (prev && next && prev !== next) {
      initializedRef.current = false;
      retryCountRef.current = 0;
      setAccounts([]);
      setSelectedAccount(null);
      setIsUnifiedInbox(true);
      setCustomLabels([]);
      setMainLabelCounts({});
      setSecondaryLabelCounts({});
      setSelectedLabel('INBOX');
      setIsLoading(true);
      AsyncStorage.removeItem(STORAGE_KEY_SELECTED_ACCOUNT);
      setRetryTick((t) => t + 1); // re-trigger the init effect to refetch
    }
  }, [organizationId]);

  useEffect(() => {
    if (isUnifiedInbox && accounts.length > 0) {
      fetchLabels();
    } else if (selectedAccount && !isUnifiedInbox) {
      fetchLabels();
    }
  }, [selectedAccount?.id, isUnifiedInbox, accounts.length, fetchLabels]);

  return (
    <MailContext.Provider
      value={{
        labels,
        mainLabels,
        secondaryLabels,
        customLabels,
        selectedLabel,
        setSelectedLabel,
        accounts,
        selectedAccount,
        isUnifiedInbox,
        selectAccount,
        selectUnifiedInbox,
        isLoading,
        refreshLabels,
        refreshAccounts,
        updateLabelCount,
        mailVersion,
        refreshMail,
      }}
    >
      {children}
    </MailContext.Provider>
  );
}

export function useMail() {
  const context = useContext(MailContext);
  if (!context) {
    throw new Error('useMail must be used within a MailProvider');
  }
  return context;
}
