import 'server-only';

import { RealtimePublisher } from '@weldsuite/realtime/server';

const INTERNAL_PREFIX = 'https://internal';

const adapter = {
  fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const baseUrl = process.env.REALTIME_WORKER_URL;
    const secret = process.env.REALTIME_INTERNAL_SECRET;
    if (!baseUrl || !secret) {
      throw new Error('REALTIME_WORKER_URL and REALTIME_INTERNAL_SECRET must be set');
    }

    const inputUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const target = inputUrl.replace(INTERNAL_PREFIX, baseUrl);

    const headers = new Headers(init?.headers);
    headers.set('x-internal-secret', secret);

    return fetch(target, { ...init, headers });
  },
};

export const realtime = new RealtimePublisher(adapter);
