import 'server-only';

import { RealtimePublisher } from '@weldsuite/realtime/server';

const INTERNAL_PREFIX = 'https://internal';

function resolveInputUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

const adapter = {
  fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const baseUrl = process.env.REALTIME_WORKER_URL;
    const secret = process.env.REALTIME_INTERNAL_SECRET;
    if (!baseUrl || !secret) {
      throw new Error('REALTIME_WORKER_URL and REALTIME_INTERNAL_SECRET must be set');
    }

    const inputUrl = resolveInputUrl(input);
    const target = inputUrl.replace(INTERNAL_PREFIX, baseUrl);

    const headers = new Headers(init?.headers);
    headers.set('x-internal-secret', secret);

    return fetch(target, { ...init, headers });
  },
};

export const realtime = new RealtimePublisher(adapter);
