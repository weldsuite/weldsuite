/**
 * Where a run goes: the hosts of each target and environment, and which
 * hosts are production. Plain functions over an env object, so the k6
 * scripts (`__ENV`) and the Node runner (`run.mjs`, `.env` + process.env)
 * apply the same rules. No k6 or Node imports here.
 *
 *   global  WeldSuite Global (being retired): Hono on Cloudflare Workers, a
 *           host per module worker (crm-api-test.weldsuite.org, …) plus
 *           app-api, Clerk sign-in, the public API on api(-test).weldsuite.org.
 *   eu      The EU install: one Rust server on Kubernetes serves every module
 *           on api.<domain> (api.test.weldsuite.eu, api.weldsuite.eu), WeldID
 *           sign-in, and the public API at /v1 on that same host.
 */

export const TARGETS = ['global', 'eu'];

export function targetOf(env) {
  const target = String(env.WELD_TARGET || 'global').toLowerCase();
  if (!TARGETS.includes(target)) throw new Error(`Unknown target "${target}". Use global or eu.`);
  return target;
}

export function envOf(env) {
  return String(env.WELD_ENV || 'test').toLowerCase();
}

export function truthy(value) {
  return value === '1' || value === 'true' || value === 'yes';
}

/** A URL without its trailing slashes. */
export function trimSlash(url) {
  let text = String(url);
  while (text.endsWith('/')) text = text.slice(0, -1);
  return text;
}

/** The EU install's domain: `<env>.weldsuite.eu`, `weldsuite.eu` for production, or EU_DOMAIN. */
export function euDomain(env) {
  if (env.EU_DOMAIN) return trimSlash(String(env.EU_DOMAIN).toLowerCase().replace(/^https?:\/\//, ''));
  const weldEnv = envOf(env);
  return weldEnv === 'production' ? 'weldsuite.eu' : `${weldEnv}.weldsuite.eu`;
}

const globalSuffix = (env) => (envOf(env) === 'production' ? '' : `-${envOf(env)}`);

/**
 * Base URL of the first-party API for `module` (`crm`, `desk`, `flow`,
 * `stash`, `app`). Global: the module's own worker, the way the platform SPA
 * calls it (VITE_API_MODULES=all), or app-api's forwarder with VIA_APP_API=1.
 * EU: the one server, whatever the module. BASE_URL pins a single host (e.g.
 * local `pnpm dev:api` on http://localhost:8789, or a local Rust server).
 */
export function platformBase(env, module) {
  if (env.BASE_URL) return trimSlash(env.BASE_URL);
  if (targetOf(env) === 'eu') return `https://api.${euDomain(env)}`;
  if (truthy(env.VIA_APP_API)) return `https://app-api${globalSuffix(env)}.weldsuite.org`;
  return `https://${module}-api${globalSuffix(env)}.weldsuite.org`;
}

/** Base URL of the public API; the scenarios add `/v1/…`. On EU it is the platform's host. */
export function publicBase(env) {
  if (env.PUBLIC_API_URL) return trimSlash(env.PUBLIC_API_URL);
  if (targetOf(env) === 'eu') return platformBase(env, 'app');
  return `https://api${globalSuffix(env)}.weldsuite.org`;
}

/** Every base URL a run of this env can reach (for the production check). */
export function allBases(env) {
  const modules = ['app', 'crm', 'desk', 'flow', 'stash'];
  return [...new Set([...modules.map((module) => platformBase(env, module)), publicBase(env)])];
}

function hostOf(url) {
  const match = /^[a-z]+:\/\/([^/:?#]+)/i.exec(String(url));
  return match ? match[1].toLowerCase() : '';
}

/**
 * Whether a URL is a production host: `<name>.weldsuite.eu` (api., app.;
 * the test cluster is one level down, `api.test.weldsuite.eu`), or
 * `<name>.weldsuite.org` without `-test` (crm-api.weldsuite.org, not
 * crm-api-test.weldsuite.org).
 */
export function isProductionUrl(url) {
  const host = hostOf(url);
  const eu = /^([^.]+)\.weldsuite\.eu$/.exec(host);
  if (eu || host === 'weldsuite.eu') return true;
  const global = /^([^.]+)\.weldsuite\.org$/.exec(host);
  return Boolean(global && !global[1].endsWith('-test'));
}

/**
 * Refuse production unless both flags say so: WELD_ENV=production (`--env
 * production`) and ALLOW_PRODUCTION=yes. A BASE_URL, PUBLIC_API_URL or
 * EU_DOMAIN that points at a production host counts as production too.
 * Returns an error message, or null when the target is safe.
 */
export function productionRefusal(env) {
  const productionHosts = allBases(env).filter(isProductionUrl);
  const isProduction = envOf(env) === 'production' || productionHosts.length > 0;
  if (!isProduction) return null;
  if (envOf(env) !== 'production') {
    return `${productionHosts.join(', ')} is production. Pass --env production (and ALLOW_PRODUCTION=yes) if you really mean it.`;
  }
  if (env.ALLOW_PRODUCTION !== 'yes') {
    return 'Refusing to pressure-test production. Set ALLOW_PRODUCTION=yes if you really mean it.';
  }
  return null;
}

/** "EU test (https://api.test.weldsuite.eu)", for logs and reports. */
export function describeTarget(env) {
  const target = targetOf(env) === 'eu' ? 'EU' : 'Global';
  return `${target} ${envOf(env)} (${platformBase(env, '<module>')})`;
}
