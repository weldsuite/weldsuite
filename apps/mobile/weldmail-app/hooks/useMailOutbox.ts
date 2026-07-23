/**
 * Component-facing API for offline-durable mailbox mutations.
 *
 * Each method (a) enqueues the op so it survives offline + restarts, (b) patches
 * the cached message detail so re-opening reflects the change without a network
 * round-trip, and (c) kicks an immediate flush — which runs the op now when
 * online, or leaves it queued for the reconnect flush when offline. Callers keep
 * their existing optimistic UI update; because these methods never throw on a
 * connectivity failure, there's nothing to roll back when offline.
 *
 * `overlay()` folds the pending queue onto a fetched/cached list so the inbox
 * shows queued changes (stars, deletes, archives) until they sync.
 */

import { useCallback, useMemo } from 'react';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useMailCache } from '@/hooks/useMailCache';
import type { SendMailMessageInput } from '@weldsuite/app-api-client';
import { enqueueOp, loadOutbox, applyOps, type MessagePatch, type OutboxOp } from '@/lib/offline/outbox';
import { flushMailOutbox } from '@/lib/offline/flush';

function newId(): string {
  return `op_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function useMailOutbox() {
  const { organizationId } = useClerkAuth();
  const orgId = organizationId ?? 'no-org';
  const cache = useMailCache();

  const flush = useCallback(() => {
    flushMailOutbox(orgId);
  }, [orgId]);

  return useMemo(() => {
    const enqueueAndFlush = async (op: OutboxOp) => {
      await enqueueOp(orgId, op);
      flush();
    };

    return {
      flush,

      /** Overlay pending ops onto a fetched/cached message list for `label`. */
      overlay: async <T extends { id: string }>(messages: T[], label?: string): Promise<T[]> => {
        const ops = await loadOutbox(orgId);
        return applyOps(messages, ops, label);
      },

      update: async (messageId: string, patch: MessagePatch) => {
        // Patch the detail cache so re-opening this message reflects the change.
        const cached = await cache.getMessage(messageId);
        if (cached) cache.setMessage(messageId, { ...cached, ...patch });
        await enqueueAndFlush({ id: newId(), kind: 'update', messageId, patch, attempts: 0, createdAt: Date.now() });
      },

      remove: async (messageId: string) => {
        await enqueueAndFlush({ id: newId(), kind: 'delete', messageId, attempts: 0, createdAt: Date.now() });
      },

      archive: async (messageId: string) => {
        await enqueueAndFlush({ id: newId(), kind: 'archive', messageId, attempts: 0, createdAt: Date.now() });
      },

      snooze: async (messageId: string, accountId: string, until: string) => {
        await enqueueAndFlush({ id: newId(), kind: 'snooze', messageId, accountId, until, attempts: 0, createdAt: Date.now() });
      },

      unsnooze: async (messageId: string, accountId: string) => {
        await enqueueAndFlush({ id: newId(), kind: 'unsnooze', messageId, accountId, attempts: 0, createdAt: Date.now() });
      },

      /**
       * Queue a composed message for send. Use when an immediate send fails with
       * a connectivity error; the payload's idempotencyKey makes the reconnect
       * replay safe even if the original request actually reached the server.
       */
      enqueueSend: async (accountId: string, payload: SendMailMessageInput) => {
        await enqueueAndFlush({ id: newId(), kind: 'send', accountId, payload, attempts: 0, createdAt: Date.now() });
      },
    };
  }, [orgId, cache, flush]);
}
