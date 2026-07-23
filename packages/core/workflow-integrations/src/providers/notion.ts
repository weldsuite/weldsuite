/**
 * Notion integration — create/update database pages.
 * Auth: internal integration token (the page/database must be shared with it).
 */

import type { IntegrationDef } from '../types';

export const notion: IntegrationDef = {
  id: 'notion',
  type: 'notion',
  label: 'Notion',
  description: 'Create and update pages in a Notion database.',
  category: 'productivity',
  icon: 'file-text',
  auth: {
    kind: 'api_key',
    fields: [{ key: 'token', label: 'Internal Integration Token', secret: true, placeholder: 'secret_...' }],
  },
  actions: [
    {
      id: 'notion.create_page',
      name: 'Create Page',
      description: 'Create a page in a database.',
      inputs: [
        { key: 'databaseId', label: 'Database ID', type: 'string', required: true },
        { key: 'title', label: 'Title', type: 'string', required: true, description: 'Sets the database\'s Name/title property.' },
        { key: 'properties', label: 'Extra properties (JSON)', type: 'json', required: false, description: 'Notion property objects, merged with Title.' },
      ],
    },
    {
      id: 'notion.update_page',
      name: 'Update Page',
      description: 'Update properties of an existing page.',
      inputs: [
        { key: 'pageId', label: 'Page ID', type: 'string', required: true },
        { key: 'properties', label: 'Properties (JSON)', type: 'json', required: true },
      ],
    },
  ],
  triggers: [],
};
