/**
 * Edition flags (P4 work package 4.F3): which modules and features this
 * deployment offers.
 *
 * The runtime config's `modules` list (`lib/runtime-config.ts`) names the
 * `ApiModuleId`s the backend serves. On Kubernetes that is the core platform
 * plus every module ported to Rust (`RUST_PORTED_MODULES` in
 * `@weldsuite/api-modules`); the apps and features of any other module are
 * hidden, since their API would answer 404. Its `unavailableFeatures` list
 * names what the backend lacks inside the modules it does serve (billing,
 * SSO connections, …). A module that cannot work without one of them counts
 * as not offered (`MODULE_FEATURES`: WeldDocs, WeldSheets and WeldBoard without live
 * editing). Global serves neither list and offers every module. Its one
 * exception is `GLOBAL_UNAVAILABLE_FEATURES` (`@weldsuite/api-modules`): features
 * built only in Rust since Global's retirement was decided (ADR OPS-025),
 * hidden there until the cutover.
 *
 * Both lists are read once, before the first render, and never change while
 * the app runs, so these are plain functions: components and hooks call them
 * directly.
 *
 * An app belongs to the module whose `apps` list starts with it (its own
 * app). Legacy and alternative codes (`task`, `accounting`, `wms`, …) resolve
 * through `normalizeAppCode` first, as the permission checks do. Workspace-
 * created WeldApps and custom objects are core.
 */

import { API_MODULES, GLOBAL_UNAVAILABLE_FEATURES, type ApiModuleId } from '@weldsuite/api-modules';
import { normalizeAppCode } from '@weldsuite/permissions';
import type { RuntimeAiConfig } from '@weldsuite/app-api-client/schemas/ai-settings';
import { getRuntimeConfig } from '@/lib/runtime-config';

/**
 * Features the Rust backend lacks inside the modules it serves
 * (`UNAVAILABLE_FEATURES` in `rust/bins/weldsuite/src/edition.rs`).
 */
export const EDITION_FEATURES = [
  /**
   * Enterprise SSO connections (`/api/sso`): Clerk's SAML connections on
   * Global; on the Kubernetes editions only with WeldID as the identity
   * provider, as OpenID Connect connections (ADR SEC-019). Zitadel installs
   * list it, and the settings page is hidden.
   */
  'sso-connections',
  /** Plans, subscriptions, seats, payment methods and invoices (Stripe). */
  'billing',
  /**
   * WeldReach inbox billing: a per-mailbox Stripe subscription on Global; on
   * the Rust backend the inboxes ride on the plan's Mollie charge, so it is
   * offered exactly where plans are billed through Mollie (`billingProvider`
   * is `mollie`), and unbilled elsewhere.
   */
  'reach-billing',
  /**
   * Buying credits: a Stripe checkout on Global, a Mollie payment on the
   * Kubernetes editions when the deployment has a Mollie key. Without
   * `billing`, the billing page shows just the balance and the top-up.
   */
  'credit-top-up',
  /** Paid WeldApps: subscriptions and developer payouts (Stripe). */
  'paid-apps',
  /**
   * The desktop app's Clerk sign-in ticket (`/api/auth-desktop/ticket`, the
   * `/auth/desktop-handoff` page): Global's desktop sign-in. It hides nothing
   * else: on the OIDC editions the desktop app signs in through the system
   * browser and a loopback redirect, which needs no ticket
   * (`lib/auth/oidc/browser-sign-in.ts`).
   */
  'desktop-sign-in',
  /** Analytics pages (Cloudflare's analytics store). */
  'analytics',
  /** `POST /api/search/reindex`. */
  'search-reindex',
  /** Company logos fetched from each company's website (`POST /api/company-logos/resolve`). */
  'company-logos',
  /**
   * Custom mail domains (`/api/mail-domains`; ADR MAIL-010, MAIL-011). Offered
   * on Kubernetes when the deployment has an MX for them (`MAIL_MX_HOST`);
   * the domain is then added and verified under WeldMail settings › Domains.
   */
  'mail-domains',
  /**
   * Free addresses on the workspace's shared subdomain (`/api/mail-weldmail`,
   * ADR MAIL-007): `{slug}.weldmail.com` on Global, `{slug}.weldmail.eu` on the
   * EU edition when the deployment sets it (ADR MAIL-012).
   */
  'mail-free-addresses',
  /**
   * DMARC aggregate reports for custom mail domains (ADR MAIL-015): WeldSuite
   * receives them at the install's report address and summarises them per
   * domain under Settings › Apps › WeldMail › Domains. Rust only; offered when
   * the deployment sets `MAIL_DMARC_REPORTS_ADDRESS`.
   */
  'mail-dmarc-reports',
  /** WeldMail's AI drafts, replies, summaries and smart replies (`/api/mail-ai`). */
  'mail-ai',
  /**
   * WeldChat voice and video calls (`/api/chat-calls`). Served on every
   * edition (LiveKit on Kubernetes); unavailable only when the deployment has
   * no video provider configured.
   */
  'chat-calls',
  /** WeldDesk help center custom domains (a Cloudflare zone record and a Vercel-hosted help center). */
  'helpcenter-custom-domains',
  /**
   * The public WeldDesk help center itself: Global serves it at
   * `{slug}.welddesk.org`; a Kubernetes edition runs no help center yet, so
   * turning it on would claim a subdomain nothing answers.
   */
  'helpcenter-hosting',
  /** WeldConnect's "Generate with AI" (`POST /api/workflows/generate`, Workers AI). */
  'weldconnect-ai',
  /** WeldHR payroll: sending the loonaangifte over Digipoort (a PKIoverheid certificate binding on Cloudflare). */
  'payroll-digipoort',
  /** WeldBooks document OCR (`POST /api/accounting-documents/:id/process`, Workers AI). */
  'books-ocr',
  /** WeldCall: buying a phone number and porting one in (Stripe checkouts through billing-worker). */
  'phone-number-purchase',
  /**
   * Filing the BTW-aangifte and the Opgaaf ICP through Digipoort (a PKIoverheid
   * client certificate). On the Rust backend it is offered exactly where the
   * install has a Digipoort connection; the status of a filing is then read
   * back from Digipoort.
   */
  'vat-digipoort',
  /** WeldHost: buying and renewing domains (a Stripe checkout and Stripe-billed renewals). */
  'domain-purchase',
  /** WeldMeet transcripts and AI summaries (the MEETING_AI Workflow and RealtimeKit's own AI). */
  'meet-transcription',
  /** WeldMeet recordings (RealtimeKit's recorder copied into the private recordings bucket). */
  'meet-recordings',
  /**
   * WeldAgent's AI: agent runs, routine tests and teach mode (Claude Managed
   * Agents on Global, the Kubernetes editions' own agent loop). Unavailable on
   * Kubernetes without an AI provider (`AI_DEFAULT_PROVIDER`), like every AI
   * feature (ADR AI-012).
   */
  'agent-ai',
  /**
   * The assistant chat and its drawer (`/new-chat`, the global shortcut,
   * board AI). Offered on a Kubernetes install as soon as an AI provider is
   * configured; split from `agent-ai` so chat does not depend on agents.
   */
  'assistant-ai',
  /**
   * WeldAgent's sandbox, computer use and web browsing (the `computer:use` and
   * `browser:use` toggles). They run at Anthropic on Global; a Kubernetes
   * install runs them on its own gVisor sandbox pods and SearXNG
   * (`rust/crates/sandbox`), and lists this as unavailable without one
   * (`SANDBOX_ENABLED`, the chart's `sandbox.enabled`). The desktop (computer
   * use) is offered there only to a Claude or GPT-5 model the workspace enabled.
   */
  'agent-sandbox',
  /** WeldDesk's inbox translation (`/api/desk/conversations/:id/translate*`, Workers AI). */
  'desk-ai',
  /** WeldForms' AI: generate a form, suggest questions, summarise answers (`/api/forms/ai/*`, `@weldsuite/ai`). */
  'forms-ai',
  /**
   * Choosing where a new workspace's data is stored (a Neon region per
   * workspace). A Kubernetes install keeps every workspace in its one cluster.
   */
  'data-regions',
  /**
   * Live editing of WeldDocs, WeldSheets and WeldBoard (the collab-rooms service).
   * Unavailable when the deployment runs without it (`COLLAB_ROOMS_URLS` unset): the apps are hidden.
   */
  'collab-rooms',
  /**
   * WeldPanel's analytics pages: web analytics, insights, funnels, retention, flows,
   * reports, dashboards, cohorts, lexicon, users, recordings, heatmaps and frustration.
   * Global queries Basin; a Kubernetes install queries its own Iceberg tables (ADR
   * EVT-019) and lists this as unavailable while it has no panel bucket
   * (`S3_BUCKET_PANEL`, the chart's `config.panel.bucket`). Projects and the install
   * instructions stay available; the other pages are hidden and redirect to them.
   */
  'panel-analytics',
  /**
   * The third-party integrations the Kubernetes editions don't offer yet: the
   * CRM sync (Attio, HubSpot, Salesforce), Slack, Discord, GitHub and Google
   * Calendar. Their entries under Settings › Integrations are hidden. Not
   * WeldConnect's store and accounting connectors (WooCommerce, Shopify,
   * Moneybird, Picqer): the Rust backend runs their syncs, webhooks,
   * catch-up and Moneybird push, so their pages stay (`lib/edition-routes.ts`).
   */
  'integration-sync',
  /**
   * WeldStash purchasing and replenishment: purchase-order actions and
   * receipts, product suppliers, the reorder planner, its settings and the
   * sales-history import (`/api/product-suppliers`, `/api/replenishment`,
   * `/api/purchase-orders/:id/<action>`). Built only in Rust, so it is in
   * `GLOBAL_UNAVAILABLE_FEATURES`; on Global the purchase-order list keeps
   * just its create, edit and delete.
   */
  'stash-replenishment',
  /**
   * WeldStash carrier shipping (ADR STASH-011): PostNL and DHL Parcel
   * accounts, labels for a packed pick list, service points, return labels,
   * customs and tracking (`/api/carriers`, `/api/parcels`,
   * `/api/pick-lists/:id/labels`). Built only in Rust, so it is in
   * `GLOBAL_UNAVAILABLE_FEATURES`; on Global a pick list ships without a
   * carrier, as before.
   */
  'stash-shipping',
  /**
   * Services outside the EU (ADR OPS-026, `/api/outside-eu-services`): on the
   * EU edition each is off until a workspace admin switches it on under
   * Settings › Services outside the EU, and the integrations that use one
   * carry a "Leaves the EU" label. A self-hosted install lists it as
   * unavailable (its operator decides), and Global has it in
   * `GLOBAL_UNAVAILABLE_FEATURES` (nothing changes there).
   */
  'outside-eu-services',
  /**
   * WeldPass deploy-target sync: pushing a project's secrets to Cloudflare and
   * Vercel (the Sync tab, `/api/weldpass/projects/:id/credentials` and
   * `/sync-targets`). Off on the EU edition for now: the server answers 403
   * `SYNC_UNAVAILABLE` and skips auto-sync, and the platform hides the tab.
   * Self-hosted installs keep it.
   */
  'weldpass-sync',
  /**
   * The rebuilt WeldCommerce (ADR COM-009): a Rust-only module, so it is in
   * `GLOBAL_UNAVAILABLE_FEATURES` and Global hides the whole module.
   */
  'commerce',
  /**
   * Adding people and companies to WeldCRM automatically, from email,
   * WeldMeet and WeldDesk (`/api/crm-settings`, the Auto-add tab of
   * Settings → Apps → WeldCRM). Built only in Rust, so it is in
   * `GLOBAL_UNAVAILABLE_FEATURES` and Global hides the tab.
   */
  'crm-auto-add',
  /**
   * WeldMail threat protection: virus scanning of inbound attachments (ClamAV)
   * and dangerous-link protection (a threat feed plus URL heuristics, checked
   * at click time through `POST /api/mail-messages/:id/link-check`). Built only
   * in Rust, so it is in `GLOBAL_UNAVAILABLE_FEATURES`. Every Kubernetes install
   * offers the link check (it needs no scanner); attachment verdicts appear only
   * where the chart runs clamd (`mailInbound.clamav`).
   */
  'mail-threat-protection',
  /**
   * Two-way Moneybird sync (ADR INT-013): live webhook updates and sending
   * contacts, products, invoices and bills made in WeldBooks to Moneybird, per
   * object direction. Built only in Rust, so it is in
   * `GLOBAL_UNAVAILABLE_FEATURES`; on Global the Moneybird connection screen
   * keeps its one-way import.
   */
  'moneybirdTwoWay',
  /**
   * WeldBooks annual reports (jaarrekening) for Dutch entities
   * (`/api/annual-reports`, the Annual reports screen). Built only in Rust, so
   * it is in `GLOBAL_UNAVAILABLE_FEATURES` and Global hides the screen.
   */
  'annual-reports',
  /**
   * Depositing an annual report with the KvK through Digipoort
   * (`POST /api/annual-reports/:id/file`): offered where the install has a
   * Digipoort connection (a PKIoverheid client certificate). Without it the
   * report is downloaded as XBRL and marked as filed by hand. Built only in
   * Rust, so it is in `GLOBAL_UNAVAILABLE_FEATURES`.
   */
  'kvk-digipoort',
  /**
   * WeldPass's encrypted offline copy on registered phones (ADR PASS-010):
   * `/api/weldpass/devices` and `/api/weldpass/settings`, and the Settings →
   * Apps → WeldPass page that lists the devices. Built only in Rust, so it is
   * in `GLOBAL_UNAVAILABLE_FEATURES` and Global hides the page.
   */
  'weldpass-offline',
  /**
   * WeldFlow agile delivery (ADRs FLOW-022 to FLOW-024): a project's delivery
   * approach and item types, sprints with start, complete and reports, the
   * Backlog view, epics, retros, WIP limits and sprints in Gantt › Phases.
   * Built only in Rust, so it is in `GLOBAL_UNAVAILABLE_FEATURES` and Global
   * shows WeldFlow as before.
   */
  'flow-agile',
  /**
   * WeldSign advanced and qualified electronic signatures (eIDAS): a signature
   * level per signer, the signer confirming their identity with a trust service
   * provider, sealed PDFs and the evidence report (`/api/sign/capabilities`,
   * `/api/sign/envelopes/:id/signatures`). Built only in Rust, so it is in
   * `GLOBAL_UNAVAILABLE_FEATURES` and Global never shows a level.
   */
  'sign-eidas',
  /**
   * WeldBooks: matching bank transactions and documents either way round, as
   * in Moneybird. One transaction settles several invoices or bills, any open
   * document can be searched for, a gap is booked to an account (bank costs, a
   * payment discount), and an invoice or bill links a transaction or undoes
   * its match from its Payments tab (`/api/bank-transactions/:id/open-documents`,
   * `/:id/match-documents`, `/for-document`). Built only in Rust, so it is in
   * `GLOBAL_UNAVAILABLE_FEATURES` and Global keeps the suggestions only.
   */
  'books-bank-links',
  /**
   * WeldBooks "to process": one list and one set of counts for everything that
   * needs the bookkeeper's attention (bank lines to book, documents to
   * process, bills to approve or pay, overdue invoices, a VAT return to file,
   * bank connections to renew, duplicates, unapplied credit):
   * `/api/accounting-todo` and `/api/accounting-todo/summary`. Built only in
   * Rust, so it is in `GLOBAL_UNAVAILABLE_FEATURES` and Global keeps the
   * dashboard's own counts.
   */
  'books-todo',
  /**
   * WeldBooks "processing bank lines": book a line to one or several
   * categories, mark a transfer between own accounts or a private payment,
   * attach a receipt, one undo for every kind of processing, rule
   * suggestions, lines booked automatically with the reason, differences
   * (bank costs, discount, rounding) and applying a contact's unapplied
   * credit. Built only in Rust, so it is in `GLOBAL_UNAVAILABLE_FEATURES`
   * and Global keeps today's reconcile screen.
   */
  'books-bank-processing',
  /**
   * WeldBooks "inbox and receipts": an inbox address per legal entity, OCR
   * when a document arrives, booking a document as a bill, receipt or credit
   * note (paid with a bank line, cash or privately) in one call, the bank
   * lines that could have paid it, duplicate checks, a supplier's usual
   * category and VAT rate, and the missing-receipts list. Built only in Rust,
   * so it is in `GLOBAL_UNAVAILABLE_FEATURES`.
   */
  'books-receipts',
  /**
   * WeldBooks "pay bills": a SEPA credit-transfer file (pain.001) for
   * approved supplier bills, which show "payment pending" until their bank
   * lines arrive. Built only in Rust, so it is in
   * `GLOBAL_UNAVAILABLE_FEATURES`.
   */
  'books-sepa-batches',
  /**
   * WeldBooks "send by e-mail": e-mailing invoices, credit notes and quotes
   * from the entity (templates per entity, delivery history, a failed
   * delivery in To process) and the public document page the e-mail links to
   * (`/public/weldbooks/documents/{token}`, served to the pay portal). Built
   * only in Rust, so it is in `GLOBAL_UNAVAILABLE_FEATURES`.
   */
  'books-invoice-email',
  /**
   * WeldBooks quotes: the list of WeldCRM quotes, creating and editing them,
   * e-mailing them, the customer accepting on the public page and an invoice
   * (or an advance invoice for a share) made from a quote. Built only in
   * Rust, so it is in `GLOBAL_UNAVAILABLE_FEATURES`.
   */
  'books-quotes',
  /**
   * WeldBooks payment reminders: a workflow per legal entity, reminders sent
   * by hand, in bulk or by the daily sweep, paused per invoice, and (NL,
   * optional) the statutory collection costs and interest on the final
   * notice. Built only in Rust, so it is in `GLOBAL_UNAVAILABLE_FEATURES`.
   */
  'books-reminders',
  /**
   * WeldBooks online payment: each legal entity connects its own Mollie
   * account (`/api/accounting-payment-connections`), customers pay an invoice on
   * its public page, Mollie's webhook records the payment on a "Mollie" money
   * account and the settlements book the fees and the payout as a transfer.
   * Built only in Rust, so it is in `GLOBAL_UNAVAILABLE_FEATURES`.
   */
  'books-online-payments',
  /**
   * WeldBooks contact page: one page per customer or supplier with a timeline
   * of everything about them, a summary (to receive, to pay, overdue, credit,
   * quotes, unbilled hours), a statement of open items as PDF, stored defaults
   * (expense account, VAT rate, payment terms, reminders paused), the contact's
   * bank lines, paged invoice and bill lists, and the contact behind a WeldCRM
   * company or person. Built only in Rust, so it is in `GLOBAL_UNAVAILABLE_FEATURES`.
   */
  'books-contact-page',
  /**
   * WeldBooks time billing: billable WeldFlow time per customer and project
   * (`/api/accounting-time/unbilled`), invoiced once on a new or an existing
   * draft invoice (`/api/invoices/from-time`), read-only in WeldFlow from then
   * on, and a project's finance. Built only in Rust, so it is in
   * `GLOBAL_UNAVAILABLE_FEATURES`.
   */
  'books-time-billing',
  /**
   * WeldBooks working with the accountant: questions on invoices, bills, bank
   * lines, documents, VAT returns and contacts (record chats of WeldChat, with
   * an open, answered or resolved status and a place in To process), the VAT
   * return's Check step, a suggested lock date and the accountant's review
   * marks on bookings. Built only in Rust, so it is in `GLOBAL_UNAVAILABLE_FEATURES`.
   */
  'books-questions',
] as const;

export type EditionFeature = (typeof EDITION_FEATURES)[number];

/**
 * App codes served by a module other than their canonical app's own one, or
 * by none. WeldAgent is workspace-level (its module has no `apps` list);
 * WeldDrive and the WeldSuite home are the core platform.
 */
const APP_MODULE_OVERRIDES: Readonly<Record<string, ApiModuleId>> = {
  weldagent: 'agent',
  agent: 'agent',
  welddrive: 'core',
  weldsuite: 'core',
};

/**
 * Modules that need a feature to work at all: without it they are not
 * offered, their apps and entry points hidden like a module the backend does
 * not serve. A document or a spreadsheet only opens in its live room.
 */
const MODULE_FEATURES: Readonly<Partial<Record<ApiModuleId, EditionFeature>>> = {
  docs: 'collab-rooms',
  sheets: 'collab-rooms',
  board: 'collab-rooms',
  // Rust only; on Global there is nothing to call (ADR COM-009).
  commerce: 'commerce',
};

/** Canonical app code → the module whose own app it is. */
const APP_MODULE: ReadonlyMap<string, ApiModuleId> = (() => {
  const map = new Map<string, ApiModuleId>();
  for (const module of API_MODULES) {
    const own = module.apps?.[0];
    if (own && !map.has(own)) map.set(own, module.id);
  }
  return map;
})();

/** The modules this deployment offers, or null when it offers every module (Global). */
export function offeredModules(): ReadonlySet<string> | null {
  const modules = getRuntimeConfig()?.modules;
  return modules ? new Set(['core', ...modules]) : null;
}

/** Whether this deployment serves the module, and has what it needs to work. */
export function isModuleOffered(module: ApiModuleId): boolean {
  const offered = offeredModules();
  const needs = MODULE_FEATURES[module];
  return (offered === null || offered.has(module)) && (!needs || isFeatureAvailable(needs));
}

/**
 * The module that serves a first-party app, legacy codes included, or `core`
 * for codes no module owns (WeldDrive, workspace-made apps and objects).
 */
export function moduleForApp(appCode: string): ApiModuleId {
  const lower = appCode.trim().toLowerCase();
  const override = APP_MODULE_OVERRIDES[lower];
  if (override) return override;
  const canonical = normalizeAppCode(lower) ?? lower;
  return APP_MODULE_OVERRIDES[canonical] ?? APP_MODULE.get(canonical) ?? 'core';
}

/** Whether this deployment offers a first-party app (sidebar, app store, routes). */
export function isAppOffered(appCode: string): boolean {
  return isModuleOffered(moduleForApp(appCode));
}

/**
 * The AI this deployment runs (`ai` in `/config.json`): null on Global, which
 * has no `/api/ai-settings`, and on a Kubernetes install without a provider.
 */
export function getAiConfig(): RuntimeAiConfig | null {
  return getRuntimeConfig()?.ai ?? null;
}

/** Whether workspace AI settings exist here: a Kubernetes install with a configured provider. */
export function hasAiSettings(): boolean {
  return getAiConfig() !== null;
}

/** Who bills plans: Mollie when `/config.json` says so, Stripe otherwise (Global). */
export function billingProvider(): 'stripe' | 'mollie' {
  return getRuntimeConfig()?.billingProvider === 'mollie' ? 'mollie' : 'stripe';
}

/**
 * Whether this deployment offers a feature: `unavailableFeatures` doesn't name
 * it, or on Global (no runtime config) `GLOBAL_UNAVAILABLE_FEATURES` doesn't.
 */
export function isFeatureAvailable(feature: EditionFeature): boolean {
  const config = getRuntimeConfig();
  const unavailable = config ? (config.unavailableFeatures ?? []) : GLOBAL_UNAVAILABLE_FEATURES;
  return !unavailable.includes(feature);
}
