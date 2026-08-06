/**
 * Minimal type surface for Cloudflare's Workers `send_email` binding.
 *
 * We don't import `cloudflare:email` directly here so the package stays
 * usable in non-Worker contexts (build tools, the platform SPA importing
 * shared types). Workers pass the binding in via `registerCloudflareSend`.
 *
 * The binding accepts two call shapes:
 *
 *  - `send(EmailMessage)` — the legacy one-envelope-recipient form, built
 *    around a raw RFC-5322 payload.
 *  - `send(EmailSendRequest)` — the structured form, which takes the whole
 *    recipient set (to + cc + bcc, 50 addresses max) in a single call and
 *    builds the MIME itself.
 *
 * We use the structured form: it is the only one that produces ONE message
 * addressed to the whole group. See `CloudflareSendProvider`.
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

export interface EmailBindingAddress {
  email: string;
  name?: string;
}

export type EmailBindingRecipients =
  | string
  | EmailBindingAddress
  | (string | EmailBindingAddress)[];

export interface EmailBindingAttachment {
  content: string | ArrayBuffer | ArrayBufferView;
  filename: string;
  /** MIME type. */
  type: string;
  disposition: 'attachment' | 'inline';
  /** Set for inline attachments referenced by `cid:` in the HTML body. */
  contentId?: string;
}

/**
 * Structured send request. `Message-ID`, `To`, `Cc`, `Bcc` and `Reply-To` are
 * owned by the platform or by the first-class fields here — passing them in
 * `headers` is rejected. Threading headers (`In-Reply-To`, `References`),
 * `List-*` and any `X-*` header are allowed.
 */
export interface EmailSendRequest {
  from: string | EmailBindingAddress;
  to: EmailBindingRecipients;
  cc?: EmailBindingRecipients;
  bcc?: EmailBindingRecipients;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string | EmailBindingAddress;
  headers?: Record<string, string>;
  attachments?: EmailBindingAttachment[];
}

export interface EmailSendResult {
  /** Platform-generated RFC-5322 Message-ID for the sent message. */
  messageId: string;
}

export interface SendEmail {
  send(message: EmailSendRequest): Promise<EmailSendResult>;
  send(message: EmailMessage): Promise<void>;
}
