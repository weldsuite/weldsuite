/**
 * Copy of the partner (reseller) emails, en + nl. It lives next to the
 * templates instead of in `@weldsuite/i18n/locales/{en,nl}/emails.ts`; move it
 * there when convenient. `Record<EmailLocale, …>` makes a missing nl key a
 * type error.
 */

import type { EmailLocale } from '../../i18n';

export interface PartnerEmailStrings {
  dunning: {
    pastDue: { subject: string; preview: string; kicker: string; body: string };
    finalWarning: { subject: string; preview: string; kicker: string; body: string };
    suspended: { subject: string; preview: string; kicker: string; body: string };
    statement: string;
    amount: string;
    dueDate: string;
    overdue: string;
    overdueDays: string;
    readOnlyDate: string;
    payInvoice: string;
    openPortal: string;
    alreadyPaid: string;
  };
  invitation: {
    subject: string;
    preview: string;
    kicker: string;
    body: string;
    open: string;
    footer: string;
    roles: { owner: string; admin: string; billing: string; viewer: string };
  };
}

export const partnerStrings: Record<EmailLocale, PartnerEmailStrings> = {
  en: {
    dunning: {
      pastDue: {
        subject: 'Payment overdue: WeldSuite statement for {period}',
        preview: 'Your WeldSuite statement for {period} is overdue.',
        kicker: 'Payment overdue',
        body: 'Your WeldSuite statement for {period} ({amount}) was due on {dueDate}. If it stays unpaid, the workspaces you manage become read-only on {readOnlyDate}.',
      },
      finalWarning: {
        subject: 'Final warning: your workspaces go read-only on {readOnlyDate}',
        preview: 'Pay the statement for {period} before {readOnlyDate}.',
        kicker: 'Final warning',
        body: 'Your WeldSuite statement for {period} ({amount}) is still unpaid. On {readOnlyDate} every workspace you manage becomes read-only: members can still sign in, view and export their data, but cannot change anything.',
      },
      suspended: {
        subject: 'Your workspaces are read-only: WeldSuite statement for {period} unpaid',
        preview: 'The workspaces you manage are read-only until the statement is paid.',
        kicker: 'Workspaces read-only',
        body: 'Your WeldSuite statement for {period} ({amount}) is {days} days overdue, so every workspace you manage is now read-only. Members can still sign in, view and export their data. Nothing is deleted, and paying the statement lifts the restriction automatically.',
      },
      statement: 'Statement',
      amount: 'Amount',
      dueDate: 'Due date',
      overdue: 'Overdue',
      overdueDays: '{days} days',
      readOnlyDate: 'Read-only from',
      payInvoice: 'Pay invoice',
      openPortal: 'Open partner portal',
      alreadyPaid: 'If you have already paid, no action is needed: the status updates when the payment arrives.',
    },
    invitation: {
      subject: 'You are invited to the {partner} partner portal',
      preview: 'Manage {partner} workspaces and licences in WeldSuite.',
      kicker: 'Partner portal invitation',
      body: 'You have been added to {partner} in the WeldSuite partner portal as {role}. Sign in with this email address to manage workspaces, licences and statements.',
      open: 'Open partner portal',
      footer: 'This invitation was sent to {email}.',
      roles: { owner: 'Owner', admin: 'Admin', billing: 'Billing', viewer: 'Viewer' },
    },
  },
  nl: {
    dunning: {
      pastDue: {
        subject: 'Betaling te laat: WeldSuite-afrekening over {period}',
        preview: 'Je WeldSuite-afrekening over {period} is te laat.',
        kicker: 'Betaling te laat',
        body: 'Je WeldSuite-afrekening over {period} ({amount}) had op {dueDate} betaald moeten zijn. Blijft die onbetaald, dan worden de workspaces die je beheert op {readOnlyDate} alleen-lezen.',
      },
      finalWarning: {
        subject: 'Laatste waarschuwing: je workspaces worden op {readOnlyDate} alleen-lezen',
        preview: 'Betaal de afrekening over {period} vóór {readOnlyDate}.',
        kicker: 'Laatste waarschuwing',
        body: 'Je WeldSuite-afrekening over {period} ({amount}) is nog niet betaald. Op {readOnlyDate} worden alle workspaces die je beheert alleen-lezen: leden kunnen nog inloggen en hun gegevens bekijken en exporteren, maar niets meer wijzigen.',
      },
      suspended: {
        subject: 'Je workspaces zijn alleen-lezen: WeldSuite-afrekening over {period} onbetaald',
        preview: 'De workspaces die je beheert zijn alleen-lezen tot de afrekening is betaald.',
        kicker: 'Workspaces alleen-lezen',
        body: 'Je WeldSuite-afrekening over {period} ({amount}) is {days} dagen te laat, dus alle workspaces die je beheert zijn nu alleen-lezen. Leden kunnen nog inloggen en hun gegevens bekijken en exporteren. Er wordt niets verwijderd, en zodra je betaalt wordt de beperking automatisch opgeheven.',
      },
      statement: 'Afrekening',
      amount: 'Bedrag',
      dueDate: 'Vervaldatum',
      overdue: 'Te laat',
      overdueDays: '{days} dagen',
      readOnlyDate: 'Alleen-lezen vanaf',
      payInvoice: 'Factuur betalen',
      openPortal: 'Partnerportaal openen',
      alreadyPaid: 'Heb je al betaald, dan hoef je niets te doen: de status wordt bijgewerkt zodra de betaling binnen is.',
    },
    invitation: {
      subject: 'Je bent uitgenodigd voor het partnerportaal van {partner}',
      preview: 'Beheer de workspaces en licenties van {partner} in WeldSuite.',
      kicker: 'Uitnodiging partnerportaal',
      body: 'Je bent als {role} toegevoegd aan {partner} in het WeldSuite-partnerportaal. Log in met dit e-mailadres om workspaces, licenties en afrekeningen te beheren.',
      open: 'Partnerportaal openen',
      footer: 'Deze uitnodiging is verstuurd naar {email}.',
      roles: { owner: 'Eigenaar', admin: 'Beheerder', billing: 'Facturatie', viewer: 'Alleen lezen' },
    },
  },
};
