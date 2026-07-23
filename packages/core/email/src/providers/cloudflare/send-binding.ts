/**
 * Minimal type surface for Cloudflare's Workers `send_email` binding and the
 * `EmailMessage` constructor exposed by `cloudflare:email`.
 *
 * We don't import `cloudflare:email` directly here so the package stays
 * usable in non-Worker contexts (build tools, the platform SPA importing
 * shared types). Workers import the runtime module themselves and pass the
 * binding + EmailMessage class in via `registerCloudflareProvider`.
 *
 * The `EmailMessage` shape is intentionally minimal so the runtime class
 * (which has more readonly properties — `raw` is internal/non-enumerable)
 * structurally satisfies it.
 */

export interface EmailMessage {
  readonly from: string;
  readonly to: string;
}

export interface SendEmail {
  send(message: EmailMessage): Promise<void>;
}

/** Constructor signature for `EmailMessage` from `cloudflare:email`. */
export type EmailMessageCtor = new (
  from: string,
  to: string,
  raw: ReadableStream | string,
) => EmailMessage;
