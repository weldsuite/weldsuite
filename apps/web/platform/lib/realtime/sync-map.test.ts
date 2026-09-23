/**
 * Lockstep checks for platformSyncMap — ensure first-slice task/mail topics
 * and WeldCRM topics invalidate the canonical TanStack Query roots.
 *
 * Phase 9 catalog ↔ sync-map ↔ ACL lockstep imports only the
 * `@weldsuite/entity-events/events` + `/hub-topics` subpaths so platform
 * type-check does not pull Cloudflare `Queue` types from the publisher.
 */
import { describe, expect, it } from 'vitest';
import { ENTITY_EVENTS } from '@weldsuite/entity-events/events';
import {
  PERSONAL_HUB_TOPIC_PREFIXES,
  listMemberHubEntityTopics,
} from '@weldsuite/entity-events/hub-topics';
import { platformSyncMap } from './sync-map';
import {
  PLATFORM_SYNC_MAP_INTENTIONAL_OMITS,
  PLATFORM_SYNC_MAP_PERSONAL_ONLY,
} from './intentional-omits';

describe('platformSyncMap — WeldFlow tasks + WeldMail', () => {
  it('project_task invalidates projects, my-tasks, and task-panel', () => {
    const keys = platformSyncMap.project_task?.invalidate ?? [];
    const serialized = keys.map((k) => JSON.stringify(k));
    expect(serialized).toContain(JSON.stringify(['projects']));
    expect(serialized).toContain(JSON.stringify(['task']));
    expect(serialized).toContain(JSON.stringify(['app-api', 'task-panel']));
  });

  it('email + mail folder/label topics invalidate mail caches', () => {
    expect(platformSyncMap.email?.invalidate).toEqual([['mail']]);
    expect(platformSyncMap.mail_folder?.invalidate).toEqual([['mail']]);
    expect(platformSyncMap.mail_label?.invalidate).toEqual([['mail', 'labels']]);
    expect(platformSyncMap.mail_draft?.invalidate).toEqual([['mail', 'drafts']]);
  });

  it('Phase 7 leftovers invalidate mailKeys campaign/signature/rule/template prefixes', () => {
    expect(platformSyncMap.mail_campaign?.invalidate).toEqual([['mail', 'campaigns']]);
    expect(platformSyncMap.mail_signature?.invalidate).toEqual([['mail', 'signatures']]);
    expect(platformSyncMap.email_rule?.invalidate).toEqual([['mail', 'rules']]);
    expect(platformSyncMap.email_template?.invalidate).toEqual([['mail', 'templates']]);
  });

  it('task topic keeps detail helpers for personal/my-tasks detail cache', () => {
    expect(platformSyncMap.task?.updateDetail).toBeTypeOf('function');
    expect(platformSyncMap.task?.remove).toBeTypeOf('function');
    expect(platformSyncMap.task?.invalidate).toEqual([['task']]);
  });
});

describe('platformSyncMap — WeldCRM', () => {
  it('person/company invalidate people/companies roots with detail helpers', () => {
    expect(platformSyncMap.person?.invalidate).toEqual([['people']]);
    expect(platformSyncMap.company?.invalidate).toEqual([['companies']]);
    expect(platformSyncMap.person?.updateDetail).toBeTypeOf('function');
    expect(platformSyncMap.person?.remove).toBeTypeOf('function');
    expect(platformSyncMap.company?.updateDetail).toBeTypeOf('function');
    expect(platformSyncMap.company?.remove).toBeTypeOf('function');
  });

  it('customer aliases companies; contact aliases people', () => {
    expect(platformSyncMap.customer?.invalidate).toEqual([['companies']]);
    expect(platformSyncMap.contact?.invalidate).toEqual([['people']]);
    expect(platformSyncMap.customer?.updateDetail).toBeTypeOf('function');
    expect(platformSyncMap.contact?.updateDetail).toBeTypeOf('function');
    expect(platformSyncMap.customer?.remove).toBeTypeOf('function');
    expect(platformSyncMap.contact?.remove).toBeTypeOf('function');
  });

  it('contact_link invalidates both people and companies', () => {
    expect(platformSyncMap.contact_link?.invalidate).toEqual([['people'], ['companies']]);
  });

  it('lead/opportunity/activity/pipeline keys match hook roots', () => {
    expect(platformSyncMap.lead?.invalidate).toEqual([['crm', 'leads']]);
    expect(platformSyncMap.opportunity?.invalidate).toEqual([
      ['crm', 'opportunities'],
      ['crm', 'pipelines'],
    ]);
    expect(platformSyncMap.activity?.invalidate).toEqual([['crm', 'activities']]);
    expect(platformSyncMap.pipeline?.invalidate).toEqual([['crm', 'pipelines']]);
    expect(platformSyncMap.pipeline_stage?.invalidate).toEqual([['crm', 'pipeline-stages']]);
    expect(platformSyncMap.call?.invalidate).toEqual([
      ['crm', 'voip-calls'],
      ['crm', 'call-intelligence'],
    ]);
  });

  it('transcription invalidates voip + call-recording + call-intelligence prefixes', () => {
    expect(platformSyncMap.transcription?.invalidate).toEqual([
      ['crm', 'voip-calls'],
      ['crm', 'call-recordings'],
      ['crm', 'call-intelligence'],
    ]);
  });

  it('customer_list invalidates both lists and crm lists roots', () => {
    expect(platformSyncMap.customer_list?.invalidate).toEqual([['lists'], ['crm', 'lists']]);
  });

  it('supplier invalidates weldstash suppliers (WMS table publisher)', () => {
    expect(platformSyncMap.supplier?.invalidate).toEqual([['weldstash', 'suppliers']]);
  });
});

describe('platformSyncMap — WeldDesk', () => {
  it('Phase 2 catalog gaps invalidate helpdesk prefixes', () => {
    expect(platformSyncMap.ticket_note?.invalidate).toEqual([
      ['helpdesk', 'ticket-notes'],
      ['helpdesk', 'tickets'],
    ]);
    expect(platformSyncMap.sla?.invalidate).toEqual([['helpdesk', 'slas']]);
    expect(platformSyncMap.satisfaction_survey?.invalidate).toEqual([
      ['helpdesk', 'satisfaction-surveys'],
      ['helpdesk', 'analytics'],
    ]);
    expect(platformSyncMap.helpdesk_email?.invalidate).toEqual([['helpdesk', 'email']]);
  });

  it('desk v2 topics keep conversation list + detail helpers', () => {
    expect(platformSyncMap.desk_conversation?.invalidate).toEqual([
      ['desk', 'conversations'],
    ]);
    expect(platformSyncMap.desk_conversation?.updateDetail).toBeTypeOf('function');
    expect(platformSyncMap.desk_conversation?.remove).toBeTypeOf('function');
    expect(platformSyncMap.desk_message?.invalidate).toEqual([['desk', 'conversations']]);
    expect(platformSyncMap.desk_widget?.invalidate).toEqual([['desk', 'widget']]);
  });

  it('classic helpdesk ticket/conversation topics invalidate helpdesk roots', () => {
    expect(platformSyncMap.ticket?.invalidate).toEqual([['helpdesk']]);
    expect(platformSyncMap.helpdesk_ticket?.invalidate).toEqual([['helpdesk']]);
    expect(platformSyncMap.helpdesk_conversation?.invalidate).toEqual([['helpdesk']]);
    expect(platformSyncMap.conversation?.invalidate).toEqual([
      ['helpdesk', 'conversations'],
    ]);
  });
});

describe('platformSyncMap — WeldBooks', () => {
  it('Phase 3 catalog gaps invalidate provisional accounting prefixes', () => {
    expect(platformSyncMap.purchase_order?.invalidate).toEqual([
      ['accounting', 'purchase-orders'],
    ]);
    expect(platformSyncMap.fiscal_period?.invalidate).toEqual([
      ['accounting', 'fiscal-periods'],
    ]);
    expect(platformSyncMap.fx_rate?.invalidate).toEqual([['accounting', 'fx-rates']]);
  });

  it('invoice/bill/payment use targeted prefixes (not bare accounting)', () => {
    expect(platformSyncMap.invoice?.invalidate).toEqual([
      ['accounting', 'invoices'],
      ['accounting', 'payments'],
      ['accounting', 'dashboard'],
      ['accounting', 'reports'],
    ]);
    expect(platformSyncMap.bill?.invalidate).toEqual([
      ['accounting', 'bills'],
      ['accounting', 'payments'],
      ['accounting', 'dashboard'],
      ['accounting', 'documents'],
    ]);
    expect(platformSyncMap.payment?.invalidate).toEqual([
      ['accounting', 'payments'],
      ['accounting', 'invoices'],
      ['accounting', 'bills'],
      ['accounting', 'dashboard'],
    ]);
    for (const topic of ['invoice', 'bill', 'payment'] as const) {
      const keys = platformSyncMap[topic]?.invalidate ?? [];
      expect(keys.map((k) => JSON.stringify(k))).not.toContain(JSON.stringify(['accounting']));
    }
  });

  it('core GL/banking topics keep targeted accounting prefixes', () => {
    expect(platformSyncMap.account?.invalidate).toEqual([['accounting', 'accounts']]);
    expect(platformSyncMap.journal_entry?.invalidate).toEqual([
      ['accounting', 'journal-entries'],
      ['accounting', 'accounts'],
    ]);
    expect(platformSyncMap.bank_account?.invalidate).toEqual([
      ['accounting', 'bank-accounts'],
    ]);
    expect(platformSyncMap.accounting_entity?.invalidate).toEqual([
      ['accounting', 'entities'],
    ]);
  });
});

describe('platformSyncMap — WeldStash', () => {
  it('inventory publisher + wms_inventory alias invalidate stock/movements', () => {
    expect(platformSyncMap.inventory?.invalidate).toEqual([
      ['weldstash', 'stock'],
      ['weldstash', 'movements'],
    ]);
    expect(platformSyncMap.wms_inventory?.invalidate).toEqual([
      ['weldstash', 'stock'],
      ['weldstash', 'movements'],
    ]);
  });

  it('product publisher invalidates commerce + stash; wms_product stays stash', () => {
    expect(platformSyncMap.product?.invalidate).toEqual([
      ['weldcommerce', 'products'],
      ['weldstash', 'products'],
      ['weldstash', 'stock'],
    ]);
    expect(platformSyncMap.wms_product?.invalidate).toEqual([
      ['weldstash', 'products'],
      ['weldstash', 'stock'],
    ]);
  });

  it('picklist + movements + warehouse keys match weldstash hooks', () => {
    expect(platformSyncMap.picklist?.invalidate).toEqual([
      ['weldstash', 'pickLists'],
      ['weldstash', 'stock'],
    ]);
    expect(platformSyncMap.wms_inventory_movement?.invalidate).toEqual([
      ['weldstash', 'movements'],
      ['weldstash', 'stock'],
    ]);
    expect(platformSyncMap.warehouse?.invalidate).toEqual([
      ['weldstash', 'warehouses'],
      ['weldstash', 'stock'],
    ]);
    expect(platformSyncMap.wms_adjustment?.invalidate).toEqual([
      ['weldstash', 'stock'],
      ['weldstash', 'movements'],
    ]);
  });

  it('Phase 3 provisional WMS catalog types are mapped', () => {
    expect(platformSyncMap.picker?.invalidate).toEqual([['weldstash', 'pickers']]);
    expect(platformSyncMap.putaway?.invalidate).toEqual([
      ['weldstash', 'putaway'],
      ['weldstash', 'stock'],
    ]);
    expect(platformSyncMap.warehouse_zone?.invalidate).toEqual([
      ['weldstash', 'zones'],
      ['weldstash', 'warehouses'],
    ]);
    expect(platformSyncMap.wms_location?.invalidate).toEqual([
      ['weldstash', 'locations'],
      ['weldstash', 'warehouses'],
      ['weldstash', 'stock'],
    ]);
    expect(platformSyncMap.wms_cycle_count?.invalidate).toEqual([
      ['weldstash', 'cycle-counts'],
      ['weldstash', 'stock'],
    ]);
    expect(platformSyncMap.wms_order?.invalidate).toEqual([['weldstash', 'orders']]);
    expect(platformSyncMap.wms_category?.invalidate).toEqual([
      ['weldstash', 'categories'],
      ['weldstash', 'products'],
    ]);
  });
});

describe('platformSyncMap — WeldCommerce', () => {
  const COMMERCE_CATALOG = [
    'order',
    'commerce_order',
    'product',
    'category',
    'commerce_customer',
    'discount',
    'website',
    'website_domain',
    'website_page',
    'website_section',
    'cart',
    'return',
    'return_reason',
    'return_rule',
    'shipment',
    'shipping_price',
    'shipping_rule',
  ] as const;

  it('covers all 17 commerce catalog entity types', () => {
    for (const topic of COMMERCE_CATALOG) {
      expect(platformSyncMap[topic]?.invalidate?.length, topic).toBeGreaterThan(0);
    }
  });

  it('product dual-maps commerce + stash; category/orders match commerceKeys', () => {
    expect(platformSyncMap.product?.invalidate).toEqual([
      ['weldcommerce', 'products'],
      ['weldstash', 'products'],
      ['weldstash', 'stock'],
    ]);
    expect(platformSyncMap.category?.invalidate).toEqual([
      ['weldcommerce', 'categories'],
      ['weldcommerce', 'products'],
    ]);
    expect(platformSyncMap.commerce_order?.invalidate).toEqual([
      ['weldcommerce', 'orders'],
    ]);
    expect(platformSyncMap.order?.invalidate).toEqual([['weldcommerce', 'orders']]);
  });

  it('commerce_customer aliases CRM people/companies roots', () => {
    expect(platformSyncMap.commerce_customer?.invalidate).toEqual([
      ['companies'],
      ['people'],
    ]);
  });

  it('provisional fulfillment + website builder prefixes use weldcommerce', () => {
    expect(platformSyncMap.discount?.invalidate).toEqual([['weldcommerce', 'discounts']]);
    expect(platformSyncMap.website?.invalidate).toEqual([['weldcommerce', 'websites']]);
    expect(platformSyncMap.website_domain?.invalidate).toEqual([
      ['weldcommerce', 'websites'],
      ['weldcommerce', 'website-domains'],
    ]);
    expect(platformSyncMap.website_page?.invalidate).toEqual([
      ['weldcommerce', 'websites'],
      ['weldcommerce', 'website-pages'],
    ]);
    expect(platformSyncMap.website_section?.invalidate).toEqual([
      ['weldcommerce', 'websites'],
      ['weldcommerce', 'website-sections'],
      ['weldcommerce', 'website-pages'],
    ]);
    expect(platformSyncMap.cart?.invalidate).toEqual([['weldcommerce', 'carts']]);
    expect(platformSyncMap.return?.invalidate).toEqual([['weldcommerce', 'returns']]);
    expect(platformSyncMap.return_reason?.invalidate).toEqual([
      ['weldcommerce', 'return-reasons'],
    ]);
    expect(platformSyncMap.return_rule?.invalidate).toEqual([
      ['weldcommerce', 'return-rules'],
    ]);
    expect(platformSyncMap.shipment?.invalidate).toEqual([['weldcommerce', 'shipments']]);
    expect(platformSyncMap.shipping_price?.invalidate).toEqual([
      ['weldcommerce', 'shipping-prices'],
    ]);
    expect(platformSyncMap.shipping_rule?.invalidate).toEqual([
      ['weldcommerce', 'shipping-rules'],
    ]);
  });
});

describe('platformSyncMap — WeldHost', () => {
  const HOST_CATALOG = [
    'domain',
    'domain_transfer',
    'dns_record',
    'dns_zone',
    'email_forward',
    'voip_phone_number',
    'voip_porting_order',
  ] as const;

  it('covers all 7 host catalog entity types', () => {
    for (const topic of HOST_CATALOG) {
      expect(platformSyncMap[topic]?.invalidate?.length, topic).toBeGreaterThan(0);
    }
  });

  it('domain/dns/voip keys match hostKeys + phone/porting hooks', () => {
    expect(platformSyncMap.domain?.invalidate).toEqual([
      ['host', 'domains'],
      ['host', 'dashboard'],
    ]);
    expect(platformSyncMap.domain_transfer?.invalidate).toEqual([['host']]);
    expect(platformSyncMap.dns_record?.invalidate).toEqual([['host']]);
    expect(platformSyncMap.dns_zone?.invalidate).toEqual([['host']]);
    expect(platformSyncMap.voip_phone_number?.invalidate).toEqual([
      ['phone-numbers'],
      ['crm', 'voip-calls', 'phone-numbers'],
    ]);
    expect(platformSyncMap.voip_porting_order?.invalidate).toEqual([['porting']]);
  });

  it('email_forward invalidates provisional forwards + domains', () => {
    expect(platformSyncMap.email_forward?.invalidate).toEqual([
      ['host', 'email-forwards'],
      ['host', 'domains'],
    ]);
  });
});

describe('platformSyncMap — WeldMeet + Calendar', () => {
  const MEET_CATALOG = [
    'meeting',
    'meeting_session',
    'meeting_message',
    'meeting_waitlist',
    'meeting_bot_session',
    'calendar',
    'calendar_event',
    'calendar_booking',
    'calendar_booking_page',
    'calendar_share',
  ] as const;

  it('covers all 10 meet/calendar catalog entity types', () => {
    for (const topic of MEET_CATALOG) {
      expect(platformSyncMap[topic]?.invalidate?.length, topic).toBeGreaterThan(0);
    }
  });

  it('meeting/session/waitlist invalidate weldmeet; message uses meeting-chat', () => {
    expect(platformSyncMap.meeting?.invalidate).toEqual([['weldmeet']]);
    expect(platformSyncMap.meeting_session?.invalidate).toEqual([['weldmeet']]);
    expect(platformSyncMap.meeting_waitlist?.invalidate).toEqual([['weldmeet']]);
    expect(platformSyncMap.meeting_message?.invalidate).toEqual([['meeting-chat']]);
  });

  it('calendar topics match calendarKeys / user-calendars / booking-pages', () => {
    expect(platformSyncMap.calendar_event?.invalidate).toEqual([['calendar']]);
    expect(platformSyncMap.calendar?.invalidate).toEqual([
      ['user-calendars'],
      ['calendar'],
    ]);
    expect(platformSyncMap.calendar_booking?.invalidate).toEqual([['calendar']]);
    expect(platformSyncMap.calendar_booking_page?.invalidate).toEqual([
      ['booking-pages'],
    ]);
    expect(platformSyncMap.calendar_share?.invalidate).toEqual([['user-calendars']]);
  });

  it('meeting_bot_session stays on CRM call-intelligence prefix', () => {
    expect(platformSyncMap.meeting_bot_session?.invalidate).toEqual([
      ['crm', 'call-intelligence', 'meeting-bot'],
    ]);
  });
});

describe('platformSyncMap — Drive', () => {
  it('file/folder/doc invalidate drive root', () => {
    expect(platformSyncMap.file?.invalidate).toEqual([['drive']]);
    expect(platformSyncMap.folder?.invalidate).toEqual([['drive']]);
    expect(platformSyncMap.doc?.invalidate).toEqual([['drive']]);
  });
});

describe('platformSyncMap — WeldKnow', () => {
  it('knowledge_space invalidates spaces + tree', () => {
    expect(platformSyncMap.knowledge_space?.invalidate).toEqual([
      ['knowledge', 'spaces'],
      ['knowledge', 'tree'],
    ]);
  });

  it('knowledge_page invalidates tree/trash/favorites/pages with detail helpers', () => {
    expect(platformSyncMap.knowledge_page?.invalidate).toEqual([
      ['knowledge', 'tree'],
      ['knowledge', 'trash'],
      ['knowledge', 'favorites'],
      ['knowledge', 'pages'],
    ]);
    expect(platformSyncMap.knowledge_page?.updateDetail).toBeTypeOf('function');
    expect(platformSyncMap.knowledge_page?.remove).toBeTypeOf('function');
  });
});

describe('platformSyncMap — WeldConnect leftovers', () => {
  it('connector_connection invalidates connectors root', () => {
    expect(platformSyncMap.connector_connection?.invalidate).toEqual([
      ['connectors'],
    ]);
  });

  it('notification_template uses provisional parcel-notifications prefix', () => {
    expect(platformSyncMap.notification_template?.invalidate).toEqual([
      ['parcel-notifications'],
    ]);
  });

  it('workflow topics keep automation prefixes', () => {
    expect(platformSyncMap.workflow?.invalidate).toEqual([
      ['automation', 'workflows'],
      ['automation', 'workflow-stats'],
      ['automation', 'workflows-chaining'],
    ]);
    expect(platformSyncMap.workflow_execution?.invalidate).toEqual([
      ['automation', 'executions'],
      ['automation', 'dashboard'],
    ]);
  });
});

describe('platformSyncMap — WeldSocial', () => {
  const SOCIAL_CATALOG = [
    'social_account',
    'social_approval',
    'social_campaign',
    'social_media',
    'social_post',
    'social_settings',
    'social_team_member',
  ] as const;

  it('covers all 7 social catalog entity types', () => {
    for (const topic of SOCIAL_CATALOG) {
      expect(platformSyncMap[topic]?.invalidate?.length, topic).toBeGreaterThan(0);
    }
  });

  it('all social topics invalidate socialKeys root', () => {
    for (const topic of SOCIAL_CATALOG) {
      expect(platformSyncMap[topic]?.invalidate, topic).toEqual([['social']]);
    }
  });
});

describe('platformSyncMap — Parcels', () => {
  const PARCEL_CATALOG = [
    'parcel',
    'parcel_box',
    'parcel_carrier',
    'parcel_order',
    'parcel_pickup',
    'parcel_wallet',
    'parcel_settings',
  ] as const;

  it('covers all 7 parcel catalog entity types with provisional root', () => {
    for (const topic of PARCEL_CATALOG) {
      expect(platformSyncMap[topic]?.invalidate, topic).toEqual([['parcel']]);
    }
  });
});

describe('platformSyncMap — Ads', () => {
  const ADS_CATALOG = [
    'ad_platform_connection',
    'ad_account',
    'ad_campaign',
  ] as const;

  it('covers all 3 ads catalog entity types', () => {
    for (const topic of ADS_CATALOG) {
      expect(platformSyncMap[topic]?.invalidate, topic).toEqual([['weldads']]);
    }
  });
});

describe('platformSyncMap — WeldHR', () => {
  it('covers every hr_* catalog entity type with the weldhr root', () => {
    const hrTopics = Object.keys(ENTITY_EVENTS).filter((topic) => topic.startsWith('hr_'));
    expect(hrTopics.length).toBeGreaterThan(0);
    for (const topic of hrTopics) {
      expect(platformSyncMap[topic]?.invalidate, topic).toEqual([['weldhr']]);
    }
  });
});

describe('platformSyncMap — WeldData', () => {
  const WELDDATA_CATALOG = [
    'welddata_list',
    'welddata_lead',
    'welddata_column',
  ] as const;

  it('covers all 3 welddata catalog entity types', () => {
    for (const topic of WELDDATA_CATALOG) {
      expect(platformSyncMap[topic]?.invalidate, topic).toEqual([['welddata']]);
    }
  });
});

describe('platformSyncMap — WeldApps', () => {
  it('user_app invalidates user-apps and installed-apps roots', () => {
    expect(platformSyncMap.user_app?.invalidate).toEqual([
      ['user-apps'],
      ['installed-apps'],
    ]);
  });
});

describe('platformSyncMap — WeldMail Phase 7 leftovers', () => {
  const MAIL_LEFTOVERS = [
    'mail_campaign',
    'mail_signature',
    'email_rule',
    'email_template',
  ] as const;

  it('covers all Phase 7 leftover catalog types', () => {
    for (const topic of MAIL_LEFTOVERS) {
      expect(platformSyncMap[topic]?.invalidate?.length, topic).toBeGreaterThan(0);
    }
  });

  it('covers campaign/signature/rule/template with mailKeys prefixes', () => {
    expect(platformSyncMap.mail_campaign?.invalidate).toEqual([['mail', 'campaigns']]);
    expect(platformSyncMap.mail_signature?.invalidate).toEqual([['mail', 'signatures']]);
    expect(platformSyncMap.email_rule?.invalidate).toEqual([['mail', 'rules']]);
    expect(platformSyncMap.email_template?.invalidate).toEqual([['mail', 'templates']]);
  });
});

describe('platformSyncMap — Phase 9 catalog ↔ map ↔ ACL lockstep', () => {
  const catalogTypes = Object.keys(ENTITY_EVENTS);
  const omitKeys = Object.keys(PLATFORM_SYNC_MAP_INTENTIONAL_OMITS);
  const personalOnly = new Set<string>([
    ...PERSONAL_HUB_TOPIC_PREFIXES,
    ...PLATFORM_SYNC_MAP_PERSONAL_ONLY,
  ]);
  const memberHubTopics = new Set(listMemberHubEntityTopics());

  it('documents a non-empty reason for every intentional omit', () => {
    for (const [topic, reason] of Object.entries(PLATFORM_SYNC_MAP_INTENTIONAL_OMITS)) {
      expect(topic.length, topic).toBeGreaterThan(0);
      expect(reason.trim().length, topic).toBeGreaterThan(10);
      expect(catalogTypes, `${topic} must be a catalog type`).toContain(topic);
      expect(platformSyncMap[topic], `${topic} must stay out of sync-map`).toBeUndefined();
    }
  });

  it('catalog − intentional omits ⊆ platformSyncMap keys', () => {
    const omit = new Set(omitKeys);
    const missing = catalogTypes.filter(
      (entityType) => !omit.has(entityType) && !(entityType in platformSyncMap),
    );
    expect(missing, `Add sync-map entries or intentional omits: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('every sync-map key is a catalog entity type', () => {
    const catalog = new Set(catalogTypes);
    const orphans = Object.keys(platformSyncMap).filter((key) => !catalog.has(key));
    expect(orphans, `Remove or catalog these sync-map keys: ${orphans.join(', ')}`).toEqual([]);
  });

  it('non-personal sync-map keys are on the member hub ACL allow-list', () => {
    const blocked: string[] = [];
    for (const topic of Object.keys(platformSyncMap)) {
      if (personalOnly.has(topic)) continue;
      if (!memberHubTopics.has(topic)) blocked.push(topic);
    }
    expect(
      blocked,
      `Member ACL missing sync-map topics: ${blocked.join(', ')}`,
    ).toEqual([]);
  });

  it('bare personal sync-map topics stay off the member hub entity allow-list', () => {
    for (const topic of PLATFORM_SYNC_MAP_PERSONAL_ONLY) {
      expect(topic in platformSyncMap, topic).toBe(true);
      expect(memberHubTopics.has(topic), topic).toBe(false);
    }
  });
});
