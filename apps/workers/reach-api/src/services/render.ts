/**
 * Turning a campaign step into the text that is sent: template variables from
 * the prospect and the sending mailbox, the mailbox signature, and the
 * opt-out + sender-identity footer.
 *
 * Nothing here references a WeldSuite domain (docs/plans/weldreach.md,
 * "Deliverability rules").
 */

import { renderReachTemplate } from '@weldsuite/app-api-client/schemas/reach';

export interface RenderProspect {
  email: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  title: string | null;
  customFields: Record<string, string> | null;
}

export interface RenderSender {
  firstName: string;
  lastName: string;
}

export const DEFAULT_OPT_OUT_TEXT = "If you'd rather not hear from me, just reply 'stop' and I won't email you again.";

function joinName(first: string | null | undefined, last: string | null | undefined): string | null {
  const full = [first, last]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part)
    .join(' ');
  return full === '' ? null : full;
}

/**
 * Variables a template can use. Custom fields come first so the built-in names
 * always win over a CSV column that happens to share one.
 */
export function buildTemplateValues(prospect: RenderProspect, sender: RenderSender | null): Record<string, string | null> {
  return {
    ...(prospect.customFields ?? {}),
    firstName: prospect.firstName,
    lastName: prospect.lastName,
    fullName: joinName(prospect.firstName, prospect.lastName),
    email: prospect.email,
    companyName: prospect.companyName,
    title: prospect.title,
    senderFirstName: sender?.firstName ?? null,
    senderLastName: sender?.lastName ?? null,
    senderFullName: sender ? joinName(sender.firstName, sender.lastName) : null,
  };
}

/** A header value must stay on one line. */
export function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export interface RenderedStep {
  subject: string;
  body: string;
  /** Variables with no value and no fallback, in the subject or the body. */
  missing: string[];
}

export function renderStepContent(
  step: { subject: string; body: string },
  values: Record<string, string | null | undefined>,
): RenderedStep {
  const subject = renderReachTemplate(step.subject, values);
  const body = renderReachTemplate(step.body, values);
  return {
    subject: singleLine(subject.text),
    body: body.text,
    missing: [...new Set([...subject.missing, ...body.missing])],
  };
}

/** "Re: <subject>", without stacking "Re: Re:". */
export function replySubject(subject: string): string {
  return /^re:\s/i.test(subject) ? subject : `Re: ${subject}`;
}

/** Body followed by the mailbox signature (when it has one and the body does not already end with it). */
export function composeBody(body: string, signature: string | null | undefined): string {
  const sig = signature?.trim();
  const trimmed = body.trimEnd();
  if (!sig || trimmed.endsWith(sig)) return trimmed;
  return `${trimmed}\n\n${sig}`;
}

export interface FooterSettings {
  optOutText: string | null;
  senderCompanyName: string | null;
  senderAddress: string | null;
}

/**
 * The legal footer: after the standard signature delimiter, the opt-out line,
 * then who is sending and where from. Empty lines are dropped.
 */
export function buildEmailFooter(settings: FooterSettings | null | undefined): string {
  const lines = [
    settings?.optOutText?.trim() || DEFAULT_OPT_OUT_TEXT,
    settings?.senderCompanyName?.trim() ?? '',
    settings?.senderAddress?.trim() ?? '',
  ].filter((line) => line !== '');
  return `\n\n-- \n${lines.join('\n')}`;
}

/** First ~500 characters of a text body on one line, for the inbox list. */
export function snippetOf(text: string, max = 500): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
