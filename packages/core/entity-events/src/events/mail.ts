/**
 * WeldMail entity events.
 */
export const MAIL_ENTITY_EVENTS = {
  mail_account: ['created', 'updated', 'deleted'],
  mail_attachment: ['created', 'updated', 'deleted'],
  mail_campaign: ['created', 'updated', 'deleted', 'sent', 'scheduled'],
  mail_domain: ['created', 'updated', 'deleted', 'verified'],
  mail_draft: ['created', 'updated', 'deleted'],
  mail_folder: ['created', 'updated', 'deleted'],
  mail_label: ['created', 'updated', 'deleted'],
  mail_signature: ['created', 'updated', 'deleted'],
  email: ['created', 'updated', 'deleted', 'email_sent', 'email_scheduled', 'reply_sent'],
  email_rule: ['created', 'updated', 'deleted', 'enabled', 'disabled'],
  email_template: ['created', 'updated', 'deleted'],
} as const;
