/**
 * Minimal type surface for Cloudflare's Workers `send_email` binding.
 *
 * We don't import `cloudflare:email` directly here so the package stays
 * usable in non-Worker contexts (build tools, the platform SPA importing
 * shared types). Workers pass the binding in via `registerCloudflareSend`.
 *
 * Cloudflare's newer Email Service documents a structured
 * `send({to, cc, bcc, ...})` on the same binding name, taking the whole
 * recipient set in one call. That form is NOT available to this account's
 * binding — passing it a plain object throws inside the binding — so the type
 * below describes only the `EmailMessage` form we actually call. See the note
 * in `CloudflareSendProvider` before reaching for it again.
 */

/** Legacy raw-MIME message shape (`cloudflare:email`'s `EmailMessage`). */
export interface EmailMessage {
  readonly from: string;
  readonly to: string;
}

/** Constructor signature for `EmailMessage` from `cloudflare:email`. */
export type EmailMessageCtor = new (
  from: string,
  to: string,
  raw: ReadableStream | string,
) => EmailMessage;

export interface SendEmail {
  send(message: EmailMessage): Promise<void>;
}
