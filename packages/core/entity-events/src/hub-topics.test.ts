import { describe, expect, it } from 'vitest';
import { ENTITY_EVENTS } from './events';
import {
  EXTRA_MEMBER_HUB_TOPICS,
  PERSONAL_HUB_TOPIC_PREFIXES,
  listMemberHubEntityTopics,
  listMemberHubTopics,
} from './hub-topics';

describe('listMemberHubEntityTopics', () => {
  it('includes every catalog entity type except bare personal prefixes', () => {
    const topics = new Set(listMemberHubEntityTopics());
    const personal = new Set<string>(PERSONAL_HUB_TOPIC_PREFIXES);

    for (const entityType of Object.keys(ENTITY_EVENTS)) {
      if (personal.has(entityType)) {
        expect(topics.has(entityType)).toBe(false);
      } else {
        expect(topics.has(entityType)).toBe(true);
      }
    }
  });

  it('excludes notification (personal) even though it is in the catalog', () => {
    expect(Object.keys(ENTITY_EVENTS)).toContain('notification');
    expect(listMemberHubEntityTopics()).not.toContain('notification');
  });

  it('includes underscore entity types that short prefixes do not unlock', () => {
    const topics = listMemberHubEntityTopics();
    expect(topics).toContain('project_task');
    expect(topics).toContain('helpdesk_ticket');
    expect(topics).toContain('mail_folder');
    expect(topics).toContain('wms_product');
    expect(topics).toContain('knowledge_page');
  });

  it('listMemberHubTopics adds presence and stays free of bare personal prefixes', () => {
    const topics = listMemberHubTopics();
    for (const extra of EXTRA_MEMBER_HUB_TOPICS) {
      expect(topics).toContain(extra);
    }
    for (const prefix of PERSONAL_HUB_TOPIC_PREFIXES) {
      expect(topics).not.toContain(prefix);
    }
  });
});
