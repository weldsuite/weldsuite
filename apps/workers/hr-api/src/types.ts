import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';
import type { DigipoortEnv } from './services/weldhr/payroll/digipoort';

/**
 * hr-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the hr module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv, DigipoortEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
  /** Secret the realtime-worker requires on every /publish/* request (service-binding callers included). */
  REALTIME_INTERNAL_SECRET?: string;
  /** R2 bucket holding declaration receipts (services/weldhr/declarations.ts), payslip PDFs and filings
   *  (workspaces/<id>/hr/payslips|filings/…, services/weldhr/payroll). */
  STORAGE?: R2Bucket;
  /**
   * books-api's `BooksInternal` entrypoint (service binding, no secret: only reachable over the binding).
   * Approving a pay run posts its journal through it (POST /internal/payroll/imports).
   */
  BOOKS_INTERNAL?: Fetcher;

  // --- Payroll mails (services/weldhr/payroll/notifier.ts, @weldsuite/emails) -
  /** Cloudflare Email Service binding for outbound mail (payslip ready, bank
   *  details changed). A missing/unconfigured transport is a no-op;
   *  see `workerTransport`. */
  SEND_EMAIL?: SendEmail;
  /** Migration switch: "resend" sends through Resend instead of Cloudflare.
   *  Flip to "cloudflare" (or unset) once mail.weldsuite.org is onboarded
   *  (docs/plans/system-email-cloudflare.md, Phase 0). */
  EMAIL_TRANSPORT?: string;
  /** Resend API key — the fallback transport while EMAIL_TRANSPORT="resend". */
  RESEND_API_KEY?: string;
  /** Migration-only sender override (noreply@weldsuite.org) until
   *  mail.weldsuite.org is onboarded; see `workerTransport`. */
  SYSTEM_EMAIL_FROM?: string;

  /**
   * Platform origin the payroll mails link to (no trailing slash). Defaults
   * per ENVIRONMENT (`app.weldsuite.org`, `app-test.weldsuite.org`,
   * `localhost:3000`); set it for local runs on a non-default port.
   */
  APP_URL?: string;
  /**
   * WeldSuite's ODB relatienummer as a software developer (`SWO12345`), written into every Dutch
   * loonaangifte (GS 3.1 RelNr). Without it the builder reports `missing_software_relation_number`.
   */
  NL_SOFTWARE_RELATION_NUMBER?: string;
}

export type Variables = KitVariables & {
  /**
   * Test seam for the payroll routes: replaces parts of the dependencies the routes build
   * (engines, PDF, billing meter, WeldBooks bridge…) so route tests do not depend on the
   * country engines. Never set in production.
   */
  payrollDepsOverride?: Partial<import('./services/weldhr/payroll/deps').PayrollDeps>;
};
