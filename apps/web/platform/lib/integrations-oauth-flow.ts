/**
 * Which OAuth flow `/settings/integrations/callback` is finishing.
 *
 * Store and accounting connectors (Moneybird, Stripe) and the connections
 * workflow steps use (Google, Slack) return to the same URL. Each flow records
 * itself here right before the browser leaves for the provider, and the
 * callback reads it back. A workflow flow also keeps its provider under the
 * key it always used (`wf_oauth_provider`), so a flow that started before
 * this page existed still finishes.
 */

const FLOW_KEY = 'integrations_oauth_flow';
const WORKFLOW_PROVIDER_KEY = 'wf_oauth_provider';

export type OAuthFlow =
  | { kind: 'connector'; returnTo?: string }
  | { kind: 'workflow'; provider: string; returnTo?: string };

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    // Blocked storage (private mode, site data off).
    return null;
  }
}

/** Record the flow the browser is about to leave for. */
export function markOAuthFlow(flow: OAuthFlow): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(FLOW_KEY, JSON.stringify(flow));
    if (flow.kind === 'workflow') store.setItem(WORKFLOW_PROVIDER_KEY, flow.provider);
    else store.removeItem(WORKFLOW_PROVIDER_KEY);
  } catch {
    // Quota or blocked storage: the callback falls back to the provider's state.
  }
}

function parseFlow(raw: string | null): OAuthFlow | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<OAuthFlow> | null;
    if (value?.kind === 'connector') return { kind: 'connector', returnTo: value.returnTo };
    if (value?.kind === 'workflow' && typeof value.provider === 'string' && value.provider) {
      return { kind: 'workflow', provider: value.provider, returnTo: value.returnTo };
    }
  } catch {
    // Not ours: ignore it.
  }
  return null;
}

/** The flow recorded before the redirect, or null when nothing was recorded. */
export function readOAuthFlow(): OAuthFlow | null {
  const store = storage();
  if (!store) return null;
  try {
    const flow = parseFlow(store.getItem(FLOW_KEY));
    if (flow) return flow;
    const provider = store.getItem(WORKFLOW_PROVIDER_KEY);
    return provider ? { kind: 'workflow', provider } : null;
  } catch {
    return null;
  }
}

/** Forget the flow once the callback has finished it. */
export function clearOAuthFlow(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(FLOW_KEY);
    store.removeItem(WORKFLOW_PROVIDER_KEY);
  } catch {
    // Nothing to clear.
  }
}
