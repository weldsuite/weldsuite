import { senderNameOf, type EmailBrand } from './brand';
import type { EmailLocale } from './i18n';
import { renderEmail } from './render';
import type { TemplateId, TemplateProps } from './templates';
import { templates } from './templates';
import type { EmailTransport, Mailbox, OutgoingAttachment, SendResult } from './transport';

/**
 * The one address every system email is sent from. The display name varies
 * (module, workspace, "Host via Workspace"); the address does not. Replies that
 * should reach a person go through Reply-To.
 */
export const SYSTEM_FROM_ADDRESS = 'notifications@mail.weldsuite.org';

type Recipient = string | Mailbox;

export interface SendSystemEmailOptions<Id extends TemplateId> {
  template: Id;
  props: TemplateProps<Id>;
  to: Recipient | Recipient[];
  cc?: Recipient[];
  bcc?: Recipient[];
  /** Recipient's language; see `resolveEmailLocale`. Defaults to English. */
  locale?: EmailLocale;
  /** Defaults to the template's brand. Pass a workspace brand for external recipients. */
  brand?: EmailBrand;
  /** From display name. Defaults to the module (WeldCalendar, …) or the workspace name. */
  fromName?: string;
  replyTo?: Recipient;
  attachments?: OutgoingAttachment[];
  headers?: Record<string, string>;
}

function mailbox(recipient: Recipient): Mailbox {
  return typeof recipient === 'string' ? { email: recipient.trim() } : { ...recipient, email: recipient.email.trim() };
}

function mailboxes(recipients: Recipient | Recipient[] | undefined): Mailbox[] {
  if (!recipients) return [];
  return (Array.isArray(recipients) ? recipients : [recipients]).map(mailbox).filter((m) => m.email);
}

/**
 * Render a template and hand it to a transport. Throws when the transport
 * fails; callers that must not fail on mail (most of them) catch and log.
 */
export async function sendSystemEmail<Id extends TemplateId>(
  transport: EmailTransport,
  options: SendSystemEmailOptions<Id>,
): Promise<SendResult> {
  const to = mailboxes(options.to);
  const cc = mailboxes(options.cc);
  const bcc = mailboxes(options.bcc);
  if (to.length + cc.length + bcc.length === 0) {
    throw new Error(`sendSystemEmail(${options.template}): no recipients`);
  }

  const brand = options.brand ?? templates[options.template].defaultBrand;
  const rendered = await renderEmail(options.template, options.props, { locale: options.locale, brand });

  return transport.send({
    from: { email: SYSTEM_FROM_ADDRESS, name: options.fromName?.trim() || senderNameOf(brand) },
    to,
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    ...(options.replyTo ? { replyTo: mailbox(options.replyTo) } : {}),
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    ...(options.attachments?.length ? { attachments: options.attachments } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
  });
}
