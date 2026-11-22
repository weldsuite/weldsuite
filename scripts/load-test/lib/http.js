/**
 * Thin HTTP client for the pressure tests. Every request is tagged
 * (`api`, `kind` read/write, `endpoint`) and recorded in a per-endpoint
 * latency trend + error rate, which the summary turns into a table.
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

/** 429s are counted on their own: on the public API they are the rate limiter doing its job. */
export const rateLimited = new Counter('rate_limited');
/**
 * The 429s WeldSuite didn't send (no JSON error body): the proxy in front
 * limiting this machine's address. On EU that is Traefik, 100 requests/s
 * (bursts of 400) and 400 open requests per client address, per Traefik pod
 * (rust/deploy/flux/infrastructure/controllers/values/traefik.yaml). They
 * say the test hit its own ceiling, not the server's.
 */
export const rateLimitedByProxy = new Counter('rate_limited_proxy');

function sentByProxy(res) {
  return !String(res.headers['Content-Type'] || '').includes('json');
}

/** Custom metrics must be declared in k6's init context, so endpoints are declared up front. */
export function endpointMetrics(keys) {
  const metrics = {};
  for (const key of keys) {
    metrics[key] = {
      latency: new Trend(`ep_${key}`, true),
      errors: new Rate(`ep_${key}_errors`),
    };
  }
  return metrics;
}

const MAX_LOGGED_FAILURES_PER_VU = 5;
let loggedFailures = 0;

/**
 * @param {object} cfg
 * @param {string} cfg.api            tag value, e.g. 'platform' or 'public'
 * @param {object} cfg.metrics        result of endpointMetrics()
 * @param {(module: string) => string} cfg.hostFor
 * @param {() => Record<string, string>} cfg.headers  auth (and workspace) headers, called per request
 */
export function createClient({ api, metrics, hostFor, headers }) {
  function request(method, key, module, path, body, opts = {}) {
    const kind = opts.kind || (method === 'GET' ? 'read' : 'write');
    const expect = opts.expect || [200];
    const params = {
      headers: { Accept: 'application/json', ...headers(), ...opts.headers },
      tags: { api, kind, endpoint: key, name: `${method} ${key}` },
    };
    let payload = null;
    if (body !== undefined) {
      params.headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const res = http.request(method, `${hostFor(module)}${path}`, payload, params);

    const limited = res.status === 429;
    const ok = expect.includes(res.status);
    if (limited) {
      rateLimited.add(1, { api, endpoint: key });
      if (sentByProxy(res)) rateLimitedByProxy.add(1, { api, endpoint: key });
    }
    const metric = metrics[key];
    if (metric) {
      if (!limited) metric.latency.add(res.timings.duration);
      metric.errors.add(!ok && !limited);
    }
    check(res, { [`${key} ${expect.join('/')}`]: () => ok || limited });

    if (!ok && !limited && loggedFailures < MAX_LOGGED_FAILURES_PER_VU) {
      loggedFailures++;
      const snippet = String(res.body || res.error || '').slice(0, 300);
      console.warn(`[${api}] ${method} ${path} → ${res.status} ${snippet}`);
    }
    return res;
  }

  return {
    get: (key, module, path, opts) => request('GET', key, module, path, undefined, opts),
    post: (key, module, path, body, opts) => request('POST', key, module, path, body, { expect: [200, 201], ...opts }),
    patch: (key, module, path, body, opts) => request('PATCH', key, module, path, body, opts),
    del: (key, module, path, opts) => request('DELETE', key, module, path, undefined, { expect: [200, 204], ...opts }),
  };
}

/** `res.json(path)` without throwing on an empty or non-JSON body. */
export function jsonField(res, path) {
  try {
    return res.json(path);
  } catch {
    return undefined;
  }
}
