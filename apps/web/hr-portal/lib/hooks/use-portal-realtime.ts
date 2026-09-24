'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { WorkspaceClient } from '@weldsuite/realtime/client';
import { hrPortalTopics } from '@weldsuite/realtime/topics';
import type { WorkspaceEvent } from '@weldsuite/realtime/types';
import { portalGet } from '@/lib/client';
import { useI18n } from '@/lib/i18n';
import { invalidatePortal } from '@/lib/query-client';
import type { Me } from '@/lib/types';

interface RealtimeTicket {
  ticket: string;
  url: string;
  expiresIn: number;
}

/** What app-api puts on a portal signal: which record changed, nothing else. */
interface PortalSignalData {
  entity: string;
  id: string;
}

/** Cached reads each kind of change can affect on an employee's pages. */
const EMPLOYEE_PATHS: Record<string, string[]> = {
  hr_leave_request: ['/employee/leave', '/employee/overview'],
  hr_attendance: ['/employee/attendance', '/employee/overview'],
  hr_coaching_log: ['/employee/coaching', '/employee/overview'],
  hr_evaluation: ['/employee/evaluations', '/employee/overview'],
  hr_checklist: ['/employee/tasks', '/employee/overview'],
  hr_kpi_value: ['/employee/performance'],
  hr_milestone: ['/employee/performance', '/employee/overview'],
  hr_employee: ['/me', '/employee/overview'],
  hr_client_assignment: ['/me', '/employee/overview'],
};

/**
 * Live updates for the signed-in portal user.
 *
 * Connects to the realtime worker with a single-use ticket from app-api and
 * listens on the user's own topic plus workspace-wide signals. A signal only
 * says "record X of kind Y changed"; the matching cached queries are
 * invalidated, so mounted pages refetch through the permission-checked API.
 * After a reconnect everything is invalidated to cover what was missed.
 *
 * Portals without realtime (local runs without KV) simply keep working
 * without live updates.
 */
export function usePortalRealtime(slug: string, me: Me) {
  const { dict } = useI18n();
  const dictRef = useRef(dict);
  dictRef.current = dict;

  const principalTopic =
    me.kind === 'employee' ? hrPortalTopics.employee(me.employee.id) : hrPortalTopics.client(me.company.id);

  useEffect(() => {
    let cancelled = false;
    let client: WorkspaceClient | null = null;
    const unsubscribes: Array<() => void> = [];

    const fetchTicket = () => portalGet<RealtimeTicket>(slug, '/realtime/ticket');

    void (async () => {
      let first: RealtimeTicket;
      try {
        first = await fetchTicket();
      } catch {
        return; // No live updates available — the portal still works.
      }
      if (cancelled) return;

      // The first ticket was fetched to learn the URL; hand it to the first
      // connect, then fetch a fresh one for every reconnect (tickets are single-use).
      let pending: string | null = first.ticket;
      client = new WorkspaceClient({
        url: first.url,
        getToken: async () => {
          if (pending) {
            const ticket = pending;
            pending = null;
            return ticket;
          }
          return (await fetchTicket()).ticket;
        },
      });

      const onPrincipal = (event: WorkspaceEvent<PortalSignalData>) => {
        const entity = event.data?.entity;
        if (me.kind === 'client') {
          void invalidatePortal(slug, ['/client']);
          return;
        }
        void invalidatePortal(slug, entity ? EMPLOYEE_PATHS[entity] : undefined);
        notifyEmployee(entity, event.event);
      };

      const notifyEmployee = (entity: string | undefined, action: string) => {
        const live = dictRef.current.live;
        if (entity === 'hr_leave_request' && action === 'approved') toast.success(live.leaveApproved);
        else if (entity === 'hr_leave_request' && action === 'rejected') toast.error(live.leaveRejected);
        else if (entity === 'hr_coaching_log' && action === 'created') toast(live.newCoaching);
        else if (entity === 'hr_evaluation' && action === 'submitted') toast(live.newEvaluation);
        else if (entity === 'hr_checklist' && action === 'created') toast(live.newTasks);
      };

      let wasConnected = false;
      unsubscribes.push(
        client.on<PortalSignalData>(principalTopic, onPrincipal),
        // Branding, feature switches, leave types: refresh everything.
        client.on(hrPortalTopics.workspace, () => void invalidatePortal(slug)),
        client.onResyncRequired(() => void invalidatePortal(slug)),
        client.onConnectionChange((state) => {
          if (state === 'connected') {
            if (wasConnected) void invalidatePortal(slug);
            wasConnected = true;
          }
        }),
      );

      void client.connect();
    })();

    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      client?.disconnect();
    };
  }, [slug, me.kind, principalTopic]);
}
