/**
 * WeldMail entity events.
 */
export const MAIL_ENTITY_EVENTS = {
  mail_account: ['created', 'updated', 'deleted'],
  mail_attachment: ['created', 'updated', 'deleted'],
  mail_campaign: ['created', 'updated', 'deleted', 'sent', 'scheduled'],
  // `dmarc_failing`: WeldSuite's mail for the domain failed DMARC in a
  // receiver's aggregate report (ADR MAIL-015).
  mail_domain: ['created', 'updated', 'deleted', 'verified', 'dmarc_failing'],
  // A workspace marked a sending source in its DMARC reports as its own or not.
  mail_dmarc_source: ['updated'],
  mail_draft: ['created', 'updated', 'deleted'],
  mail_folder: ['created', 'updated', 'deleted'],
  mail_label: ['created', 'updated', 'deleted'],
  mail_signature: ['created', 'updated', 'deleted'],
  mail_subscription: ['unsubscribed'],
  email: ['created', 'updated', 'deleted', 'email_sent', 'email_scheduled', 'reply_sent'],
  email_rule: ['created', 'updated', 'deleted', 'enabled', 'disabled'],
  email_template: ['created', 'updated', 'deleted'],
} as const;
