import type { ClientApi } from '../types';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RecordedCall {
  method: Method;
  path: string;
  body?: unknown;
}

export const RESPONSE = { data: 'from the fake api' };

/** A fake transport that records each request and answers with `RESPONSE`. */
export function recordingApi(): { api: ClientApi; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const record =
    (method: Method) =>
    <T>(path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      return Promise.resolve(RESPONSE as T);
    };
  const api: ClientApi = {
    get: record('GET'),
    getRaw: () => Promise.reject(new Error('getRaw is not used here')),
    post: record('POST'),
    put: record('PUT'),
    patch: record('PATCH'),
    delete: record('DELETE'),
    postForm: () => Promise.reject(new Error('postForm is not used here')),
  };
  return { api, calls };
}

export interface DomainCase<C> {
  name: string;
  call: (client: C) => Promise<unknown>;
  expected: RecordedCall;
}
