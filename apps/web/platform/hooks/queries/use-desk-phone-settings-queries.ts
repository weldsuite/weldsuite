/**
 * WeldDesk phone settings: the workspace's numbers, the route of each number
 * and the AI voice agents a route can use. Routes are
 * `GET|PUT /api/desk/phone/routes` (call-api); the softphone and queue hooks
 * live in `use-desk-phone-queries.ts`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { deskVoiceAgentSchema, UpsertDeskPhoneRoute } from '@weldsuite/core-api-client/schemas/desk-phone';
import type { deskPhoneRouteSchema } from '@weldsuite/app-api-client/schemas/call-responses';
import { useAppApiClient } from '@/lib/api/use-app-api';

export type DeskPhoneRoute = z.infer<typeof deskPhoneRouteSchema>;
export type DeskPhoneVoiceAgent = z.infer<typeof deskVoiceAgentSchema>;

export interface DeskPhoneNumber {
  id: string;
  phoneNumber: string;
  displayName: string | null;
  status: string;
}

export const deskPhoneSettingsKeys = {
  numbers: () => ['phone-numbers', 'list'] as const,
  agents: () => ['desk', 'phone', 'agents'] as const,
  routes: () => ['desk', 'phone', 'routes'] as const,
};

/** The workspace's phone numbers. */
export function useDeskPhoneNumbers() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskPhoneSettingsKeys.numbers(),
    queryFn: async (): Promise<DeskPhoneNumber[]> => {
      const client = await getClient();
      const res = await client.get<{ data: DeskPhoneNumber[] }>('/call-intelligence/phone-numbers');
      return res.data ?? [];
    },
  });
}

/** Pull the numbers from the carrier. */
export function useSyncDeskPhoneNumbers() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const client = await getClient();
      return client.post<{ data: { count: number } }>('/telephony/phone-numbers/sync', {});
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: deskPhoneSettingsKeys.numbers() }),
  });
}

/** The AI voice agents (enabled or not), to pick one for a route or a keypad choice. */
export function useDeskPhoneVoiceAgents() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskPhoneSettingsKeys.agents(),
    queryFn: async (): Promise<DeskPhoneVoiceAgent[]> => {
      const client = await getClient();
      const res = await client.get<{ data: DeskPhoneVoiceAgent[] }>('/desk/phone/agents');
      return res.data ?? [];
    },
  });
}

/** One route per phone number. */
export function useDeskPhoneRoutes() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: deskPhoneSettingsKeys.routes(),
    queryFn: async (): Promise<DeskPhoneRoute[]> => {
      const client = await getClient();
      const res = await client.get<{ data: DeskPhoneRoute[] }>('/desk/phone/routes');
      return res.data ?? [];
    },
  });
}

/** Upsert the route of one number. A 400 / 404 rejects with an `ApiError` the editor maps onto its fields. */
export function useSaveDeskPhoneRoute() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpsertDeskPhoneRoute) => {
      const client = await getClient();
      const res = await client.put<{ data: DeskPhoneRoute }>('/desk/phone/routes', input);
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: deskPhoneSettingsKeys.routes() }),
  });
}
