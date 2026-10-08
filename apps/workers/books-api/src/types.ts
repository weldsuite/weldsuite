import type { BankFeedEnv } from '@weldsuite/bank-feeds';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * books-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the books module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv, BankFeedEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;

  /** R2 bucket holding invoice/bill attachments and scanned accounting
   *  documents (lib/document-attachment.ts, services/accounting-ocr.ts). */
  STORAGE?: R2Bucket;

  // --- WeldBooks Digipoort (Belastingdienst SBR filing) --------------------
  /** simulated (default) | preprod | production — gates real transmission. */
  DIGIPOORT_MODE?: string;
  /** mTLS certificate binding presenting the PKIoverheid SBR services server
   *  certificate to Digipoort (wrangler.toml `mtls_certificates`). */
  DIGIPOORT_CERT?: Fetcher;

  // --- Bank feeds (@weldsuite/bank-feeds) ------------------------------------
  // Provider secrets and routing come from BankFeedEnv (PLAID_*, STRIPE_FC_SECRET_KEY,
  // PONTO_*, ENABLE_BANKING_*, BANK_FEED_PROVIDERS, BANK_FEED_WEBHOOK_URL).
  /** Workers mTLS binding presenting Ponto's client certificate (wrangler.toml `mtls_certificates`). */
  PONTO_CERT?: Fetcher;

  // --- AI (@weldsuite/ai) — Cloudflare AI Gateway, accounting OCR ----------
  // Credits are metered through @weldsuite/core-domain/ai-billing (master DB).
  // See packages/core/ai/src/config.ts for the full list of recognised keys.
  CF_ACCOUNT_ID?: string;
  /** Optional; must be `cloudflare` (the only gateway). */
  AI_GATEWAY_PROVIDER?: string;
  /** Default canonical model id; falls back to the free Workers AI default. */
  AI_DEFAULT_MODEL?: string;
  /** Cloudflare API token (Workers AI + AI Gateway Run) → `Authorization`. */
  AI_GATEWAY_API_TOKEN?: string;
  /** Fallback AI token when AI_GATEWAY_API_TOKEN is unset (@weldsuite/ai config). */
  CLOUDFLARE_API_TOKEN?: string;
  /** AI Gateway id (`cf-aig-gateway-id`). Omit to use the account default. */
  CF_AI_GATEWAY?: string;
  /** Gateway auth token (`cf-aig-authorization`), for "Authenticated" gateways. */
  CF_AIG_TOKEN?: string;
}

export type Variables = KitVariables;
