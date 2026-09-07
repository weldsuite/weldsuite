import type { Sandbox } from '@cloudflare/sandbox';

export interface Env {
  ENVIRONMENT: string;
  AGENT_COMPUTER_ENABLED?: string;
  INTERNAL_API_SECRET?: string;
  Sandbox: DurableObjectNamespace<Sandbox>;
  BROWSER?: Fetcher;
  BROWSER_SESSIONS?: KVNamespace;
}
