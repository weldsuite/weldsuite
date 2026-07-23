/**
 * Org-bound view of the offline mail cache.
 *
 * Binds the cache-scope org id (see `useCacheOrgId`) and returns the cache
 * accessors with it already applied, so screens read/write the cache without
 * repeating the scoping boilerplate.
 *
 * The scope id is *latched* by `useCacheOrgId`, so it doesn't flap while Clerk
 * re-hydrates the active org on iOS — the cache stays enabled and stable for the
 * whole session, and the read side here always agrees with the write side in
 * `MailContext`. The cache is only disabled on the very first launch before any
 * org id is known (persisted or live), when there is nothing cached to show
 * anyway; callers then fall through to a live fetch.
 */

import { useMemo } from 'react';
import { mailCache, scopeKey, type CachedLabels } from '@/lib/offline/cache';
import { useCacheOrgId } from '@/hooks/useCacheOrgId';

export function useMailCache() {
  // Latched org id — stable across Clerk's flaky iOS org re-hydration, so the
  // cache stays enabled for the whole session instead of thrashing on/off.
  const orgId = useCacheOrgId();

  return useMemo(() => {
    // Org not resolved yet → disabled cache: report misses, drop writes. Keeps
    // the accessor surface identical so call sites need no branching.
    if (orgId === null) {
      return {
        scopeKey,
        getMessages: (_scope: string, _label: string) => Promise.resolve<unknown[] | null>(null),
        setMessages: (_scope: string, _label: string, _messages: unknown[]) => Promise.resolve(),
        getAccounts: () => Promise.resolve<unknown[] | null>(null),
        setAccounts: (_accounts: unknown[]) => Promise.resolve(),
        getLabels: (_scope: string) => Promise.resolve<CachedLabels | null>(null),
        setLabels: (_scope: string, _labels: CachedLabels) => Promise.resolve(),
        getMessage: (_id: string) => Promise.resolve<Record<string, unknown> | null>(null),
        setMessage: (_id: string, _message: Record<string, unknown>) => Promise.resolve(),
        getThread: (_id: string) => Promise.resolve<unknown[] | null>(null),
        setThread: (_id: string, _messages: unknown[]) => Promise.resolve(),
      };
    }
    const oid = orgId;
    return {
      scopeKey,
      getMessages: (scope: string, label: string) => mailCache.getMessages(oid, scope, label),
      setMessages: (scope: string, label: string, messages: unknown[]) =>
        mailCache.setMessages(oid, scope, label, messages),
      getAccounts: () => mailCache.getAccounts(oid),
      setAccounts: (accounts: unknown[]) => mailCache.setAccounts(oid, accounts),
      getLabels: (scope: string) => mailCache.getLabels(oid, scope),
      setLabels: (scope: string, labels: CachedLabels) => mailCache.setLabels(oid, scope, labels),
      getMessage: (id: string) => mailCache.getMessage(oid, id),
      setMessage: (id: string, message: Record<string, unknown>) => mailCache.setMessage(oid, id, message),
      getThread: (id: string) => mailCache.getThread(oid, id),
      setThread: (id: string, messages: unknown[]) => mailCache.setThread(oid, id, messages),
    };
  }, [orgId]);
}
