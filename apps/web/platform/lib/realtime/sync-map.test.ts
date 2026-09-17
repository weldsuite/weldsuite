/**
 * Lockstep checks for platformSyncMap — ensure first-slice task/mail topics
 * and WeldCRM topics invalidate the canonical TanStack Query roots.
 *
 * Phase 0 member ACL ↔ catalog lockstep lives in realtime-worker /
 * `@weldsuite/entity-events` (hub-topics) so platform type-check does not
 * pull Cloudflare `Queue` types from the entity-events publisher.
 */
import { describe, expect, it } from 'vitest';
import { platformSyncMap } from './sync-map';

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

  it('product publisher + wms_product alias invalidate products/stock', () => {
    expect(platformSyncMap.product?.invalidate).toEqual([
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
