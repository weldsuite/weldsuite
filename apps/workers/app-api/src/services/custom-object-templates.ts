/**
 * WeldObjects — ready-made object types (`/api/custom-objects/templates`).
 *
 * A template is an object definition, its fields and its relationships,
 * installed in one go so a workspace gets a working object without building
 * it field by field. What it installs is an ordinary custom object: renaming,
 * adding fields or deleting it afterwards works exactly as for one made by
 * hand.
 *
 * The labels are English. They are data in the workspace, not UI strings, and
 * an admin can rename them in Settings → Custom objects like any other.
 *
 * The Rust twin (`rust/modules/core-objects/src/object_templates.rs`) holds
 * the same definitions; the `core: custom objects` conformance suite compares
 * what both install.
 */

import type {
  CustomObjectCardinality,
  CustomObjectFieldType,
  CustomObjectOnDelete,
  CustomObjectTemplateKey,
} from '@weldsuite/app-api-client/schemas/custom-objects';

export interface TemplateField {
  slug: string;
  name: string;
  fieldType: CustomObjectFieldType;
  required: boolean;
  options?: { label: string; value: string }[];
}

export interface TemplateLink {
  slug: string;
  targetEntityKey: string;
  cardinality: CustomObjectCardinality;
  /** Shown on the target's page (the reverse panel). */
  sourceLabel: string;
  /** Shown on the record's page. */
  targetLabel: string;
  onDelete: CustomObjectOnDelete;
}

export interface CustomObjectTemplateDefinition {
  key: CustomObjectTemplateKey;
  slug: string;
  labelSingular: string;
  labelPlural: string;
  description: string;
  icon: string;
  enableEvents: boolean;
  enableSearch: boolean;
  /** Slug of the field records are titled by. */
  titleField: string;
  fields: TemplateField[];
  links: TemplateLink[];
}

const options = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ label, value }));

/**
 * Assets: equipment and licences, who has them, and the tickets about them.
 * WeldDesk's "Asset register" installs it and attaches assets to inbox
 * conversations through the `tickets` relationship.
 */
const ASSET: CustomObjectTemplateDefinition = {
  key: 'asset',
  slug: 'asset',
  labelSingular: 'Asset',
  labelPlural: 'Assets',
  description: 'Equipment and software licences, who has them and the tickets about them.',
  icon: 'Laptop',
  enableEvents: true,
  enableSearch: true,
  titleField: 'name',
  fields: [
    { slug: 'name', name: 'Name', fieldType: 'text', required: true },
    {
      slug: 'asset_type',
      name: 'Asset type',
      fieldType: 'single_select',
      required: false,
      options: options(
        ['laptop', 'Laptop'],
        ['desktop', 'Desktop'],
        ['monitor', 'Monitor'],
        ['phone', 'Phone'],
        ['tablet', 'Tablet'],
        ['server', 'Server'],
        ['network_device', 'Network device'],
        ['printer', 'Printer'],
        ['software_licence', 'Software licence'],
        ['other', 'Other'],
      ),
    },
    { slug: 'serial_number', name: 'Serial number', fieldType: 'text', required: false },
    { slug: 'location', name: 'Location', fieldType: 'text', required: false },
    { slug: 'warranty_until', name: 'Warranty until', fieldType: 'date', required: false },
    { slug: 'purchase_date', name: 'Purchase date', fieldType: 'date', required: false },
    { slug: 'supplier', name: 'Supplier', fieldType: 'text', required: false },
    {
      slug: 'status',
      name: 'Status',
      fieldType: 'single_select',
      required: false,
      options: options(
        ['in_use', 'In use'],
        ['in_stock', 'In stock'],
        ['in_repair', 'In repair'],
        ['retired', 'Retired'],
        ['lost', 'Lost'],
      ),
    },
    { slug: 'notes', name: 'Notes', fieldType: 'textarea', required: false },
  ],
  links: [
    {
      slug: 'owner',
      targetEntityKey: 'person',
      cardinality: 'many_to_one',
      sourceLabel: 'Assets',
      targetLabel: 'Owner',
      onDelete: 'set_null',
    },
    {
      slug: 'tickets',
      targetEntityKey: 'conversation',
      cardinality: 'many_to_many',
      sourceLabel: 'Assets',
      targetLabel: 'Tickets',
      onDelete: 'set_null',
    },
  ],
};

export const CUSTOM_OBJECT_TEMPLATES: readonly CustomObjectTemplateDefinition[] = [ASSET];

export function findCustomObjectTemplate(key: string): CustomObjectTemplateDefinition | undefined {
  return CUSTOM_OBJECT_TEMPLATES.find((template) => template.key === key);
}
