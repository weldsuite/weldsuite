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
