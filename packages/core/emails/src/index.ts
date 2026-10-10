/**
 * @weldsuite/emails — every system email WeldSuite sends: React Email
 * templates on one shared layout, en/nl copy, and transports for Cloudflare
 * Email Service.
 *
 *   const transport = workerTransport(env);          // '@weldsuite/emails/transports/binding'
 *   if (transport) {
 *     await sendSystemEmail(transport, {
 *       template: 'calendar.event',
 *       props: { kind: 'invite', ... },
 *       to: attendee.email,
 *       locale: resolveEmailLocale(userLanguage, workspaceLanguage),
 *       attachments: [icsAttachment({ ... })],
 *     });
 *   }
 *
 * Next.js apps use `restTransport` from '@weldsuite/emails/transports/rest'.
 * Design guide: .claude/skills/weldsuite-email/SKILL.md.
 */

export { theme, type Theme } from './theme';
export { accentOf, logoUrlOf, senderNameOf, type EmailBrand, type EmailModule } from './brand';
export {
  EMAIL_LOCALES,
  emailStrings,
  fill,
  resolveEmailLocale,
  rich,
  type EmailLocale,
  type EmailStrings,
} from './i18n';
export { formatDate, formatTime, formatTimeRange, formatWhen, isValidTimeZone, zoneOr } from './format';
export { defineTemplate, type EmailTemplate, type TemplateEnv, type TemplatePreview } from './define';
export {
  templates,
  type TemplateId,
  type TemplateProps,
  type BookingEmailKind,
  type BookingEmailProps,
  type BookingLocation,
  type CalendarEventEmailProps,
  type CalendarEventKind,
  type DigestTask,
  type EnterpriseInquiryEmailProps,
  type FlowDigestEmailProps,
  type HrPortalInviteEmailProps,
  type MeetInvitationEmailProps,
  type NotificationEmailProps,
  type PartnerDunningEmailProps,
  type PartnerDunningStage,
  type PartnerInvitationEmailProps,
  type PortalSignInEmailProps,
  type TaskAssignedEmailProps,
  type WorkspaceDeletionEmailProps,
  type WorkspaceInvitationEmailProps,
} from './templates';
export { htmlToText, renderEmail, renderHtml, renderTemplate, type RenderOptions, type RenderedEmail } from './render';
export { SYSTEM_FROM_ADDRESS, sendSystemEmail, type SendSystemEmailOptions } from './send';
export {
  formatMailbox,
  type EmailTransport,
  type Mailbox,
  type OutgoingAttachment,
  type OutgoingEmail,
  type SendResult,
} from './transport';
export { buildIcs, icsAttachment, nextIcsSequence, type IcsEvent, type IcsMethod } from './ics';
