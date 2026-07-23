/**
 * WeldHost (domains, DNS) + VoIP entity events.
 */
export const HOST_ENTITY_EVENTS = {
  domain: ['created', 'updated', 'deleted', 'use_external', 'use_internal'],
  domain_transfer: ['created', 'updated', 'deleted', 'approved', 'rejected'],
  dns_record: ['created', 'updated', 'deleted'],
  dns_zone: ['created', 'updated', 'deleted'],
  email_forward: ['created', 'updated', 'deleted'],
  voip_phone_number: ['created', 'updated', 'deleted'],
  voip_porting_order: ['created', 'updated', 'deleted', 'approved', 'rejected'],
} as const;
