/**
 * Every system email, by id. Adding a template: create the file under
 * `templates/<area>/`, register it here, and add its strings to
 * `@weldsuite/i18n/locales/{en,nl}/emails.ts`. The snapshot test and the
 * preview server pick it up from this registry.
 */

import workspaceDeletion from './admin/workspace-deletion';
import booking from './booking/booking';
import calendarEvent from './calendar/event';
import flowDigest from './flow/digest';
import hrBankChanged from './hr/bank-changed';
import hrPayslipReady from './hr/payslip-ready';
import hrPortalInvite from './hr/portal-invite';
import enterpriseInquiry from './internal/enterprise-inquiry';
import meetInvitation from './meet/invitation';
import notification from './notifications/notification';
import partnerDunning from './partner/dunning';
import partnerInvitation from './partner/invitation';
import portalSignIn from './portal/sign-in';
import taskAssigned from './task/assigned';
import workspaceInvitation from './workspace/invitation';

export const templates = {
  'calendar.event': calendarEvent,
  'meet.invitation': meetInvitation,
  booking,
  'workspace.invitation': workspaceInvitation,
  notification,
  'task.assigned': taskAssigned,
  'flow.digest': flowDigest,
  'portal.sign-in': portalSignIn,
  'hr.portal-invite': hrPortalInvite,
  'hr.payslip-ready': hrPayslipReady,
  'hr.bank-changed': hrBankChanged,
  'admin.workspace-deletion': workspaceDeletion,
  'partner.dunning': partnerDunning,
  'partner.invitation': partnerInvitation,
  'internal.enterprise-inquiry': enterpriseInquiry,
};

export type TemplateId = keyof typeof templates;

/** The props a template takes. */
export type TemplateProps<Id extends TemplateId> =
  (typeof templates)[Id] extends { previews: Record<string, { props: infer P }> } ? P : never;

export type { WorkspaceDeletionEmailProps } from './admin/workspace-deletion';
export type { BookingEmailKind, BookingEmailProps, BookingLocation } from './booking/booking';
export type { CalendarEventEmailProps, CalendarEventKind } from './calendar/event';
export type { DigestTask, FlowDigestEmailProps } from './flow/digest';
export type { HrBankChangedEmailProps } from './hr/bank-changed';
export type { HrPayslipReadyEmailProps } from './hr/payslip-ready';
export type { HrPortalInviteEmailProps } from './hr/portal-invite';
export type { EnterpriseInquiryEmailProps } from './internal/enterprise-inquiry';
export type { MeetInvitationEmailProps } from './meet/invitation';
export type { NotificationEmailProps } from './notifications/notification';
export type { PartnerDunningEmailProps, PartnerDunningStage } from './partner/dunning';
export type { PartnerInvitationEmailProps } from './partner/invitation';
export type { PortalSignInEmailProps } from './portal/sign-in';
export type { TaskAssignedEmailProps } from './task/assigned';
export type { WorkspaceInvitationEmailProps } from './workspace/invitation';
