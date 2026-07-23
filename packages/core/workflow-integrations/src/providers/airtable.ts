/**
 * Airtable integration — create/update records, trigger on new records (poll).
 * Auth: Personal Access Token.
 */

import type { IntegrationDef } from '../types';

export const airtable: IntegrationDef = {
  id: 'airtable',
  type: 'airtable',
  label: 'Airtable',
  description: 'Create and update records, and trigger workflows on new records.',
  category: 'productivity',
  icon: 'table',
  auth: {
    kind: 'api_key',
    fields: [{ key: 'token', label: 'Personal Access Token', secret: true, placeholder: 'pat...' }],
  },
  actions: [
    {
      id: 'airtable.create_record',
      name: 'Create Record',
      description: 'Create a record in a table.',
      inputs: [
        { key: 'baseId', label: 'Base ID', type: 'string', required: true, placeholder: 'app...' },
        { key: 'tableId', label: 'Table ID or name', type: 'string', required: true },
        { key: 'fields', label: 'Fields (JSON object)', type: 'json', required: true },
      ],
    },
    {
      id: 'airtable.update_record',
      name: 'Update Record',
      description: 'Update fields on an existing record.',
      inputs: [
        { key: 'baseId', label: 'Base ID', type: 'string', required: true },
        { key: 'tableId', label: 'Table ID or name', type: 'string', required: true },
        { key: 'recordId', label: 'Record ID', type: 'string', required: true, placeholder: 'rec...' },
        { key: 'fields', label: 'Fields (JSON object)', type: 'json', required: true },
      ],
    },
  ],
  triggers: [
    {
      id: 'airtable.new_record',
      name: 'New Record',
      description: 'Triggers when a new record is added to a watched table.',
      kind: 'poll',
      outputFields: ['id', 'fields', 'createdTime'],
    },
  ],
};
