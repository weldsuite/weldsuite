/**
 * Resend Email Client
 *
 * Simple fetch-based client for Resend's API (https://resend.com/docs/api-reference).
 * Used for transactional/system emails (notifications, digests) sent from @mail.weldsuite.org.
 * No SDK dependency — just raw fetch.
 */

export interface EmailAttachment {
  filename: string;
  content: string;
  content_type?: string;
}

export interface SendEmailParams {
  from: string;
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string[];
  bcc?: string[];
  headers?: Record<string, string>;
  attachments?: EmailAttachment[];
}

export interface SendTemplateEmailParams {
  from: string;
  to: string[];
  subject?: string;
  template: {
    id: string;
    variables: Record<string, string | number | boolean>;
  };
  attachments?: EmailAttachment[];
}

export interface SendEmailResult {
  id: string;
}

export async function sendEmail(
  apiKey: string,
  params: SendEmailParams,
): Promise<SendEmailResult> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }

  return res.json() as Promise<SendEmailResult>;
}

export async function sendTemplateEmail(
  apiKey: string,
  params: SendTemplateEmailParams,
): Promise<SendEmailResult> {
  const body: Record<string, unknown> = {
    from: params.from,
    to: params.to,
    template: params.template,
  };
  if (params.subject) body.subject = params.subject;
  if (params.attachments?.length) body.attachments = params.attachments;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend API error ${res.status}: ${text}`);
  }

  return res.json() as Promise<SendEmailResult>;
}
