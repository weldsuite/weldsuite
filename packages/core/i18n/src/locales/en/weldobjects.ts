/**
 * WeldObjects — user-defined custom objects.
 *
 * `{object}` / `{objects}` / `{field}` / `{target}` placeholders are replaced
 * at render time with the workspace's own labels. Those labels are DATA, not
 * translations — a workspace that names an object "Machines" sees "Machines"
 * in every locale.
 */
export const weldobjects = {
  // Record list (/objects/:slug)
  list: {
    nameColumn: 'Name',
    create: 'New {object}',
    created: '{object} created',
    notFoundTitle: 'Object not found',
    notFoundBody: 'This object may have been deleted or disabled.',
    noFieldsTitle: 'No fields yet',
    noFieldsBody: 'Add at least one field before creating a {object}.',
    addFields: 'Add fields',
  },

  // Record detail (/objects/:slug/:recordId)
  detail: {
    details: 'Details',
    edit: 'Edit',
    delete: 'Delete',
    saved: 'Changes saved',
    deleted: 'Record deleted',
    deleteTitle: 'Delete this {object}?',
    deleteBody: 'This cannot be undone.',
    notFoundTitle: 'Record not found',
    backToList: 'Back to {objects}',
    noRelated: 'Nothing linked yet',
    unlink: 'Unlink',
  },

  // Create / edit record form
  form: {
    createTitle: 'New {object}',
    editTitle: 'Edit {object}',
    requiredField: '{field} is required',
    cancel: 'Cancel',
    save: 'Save',
    saving: 'Saving…',
  },

  // Object creation dialog
  create: {
    title: 'New custom object',
    description: 'Define a new type of record for your workspace.',
    pluralLabel: 'Plural name',
    pluralPlaceholder: 'Machines',
    singularLabel: 'Singular name',
    singularPlaceholder: 'Machine',
    slugLabel: 'Identifier',
    slugHelp: 'Used in URLs and the API (/objects/{slug}). This cannot be changed later.',
    descriptionLabel: 'Description',
    submit: 'Create object',
    creating: 'Creating…',
  },

  // Settings — object list + builder
  settings: {
    title: 'Custom objects',
    subtitle: 'Define your own record types with custom fields and relationships.',
    newObject: 'New object',
    emptyTitle: 'No custom objects yet',
    emptyBody: 'Create your first object to track something WeldSuite does not cover.',
    notFound: 'Object not found',
    backToObjects: 'Back to custom objects',
    fields: 'Fields',
    records: 'Records',
    relationships: 'Relationships',
    settingsTab: 'Settings',
    general: 'General',
    addField: 'Add field',
    editField: 'Edit',
    required: 'Required',
    titleField: 'Title field',
    titleFieldAuto: 'Automatic',
    titleFieldHelp: 'The field shown as each record’s name in lists and search.',
    noFieldsTitle: 'No fields yet',
    noFieldsBody: 'Add fields to describe what this object stores.',
    activate: 'Activate',
    activateNeedsFields: 'Add at least one field first',
    disable: 'Disable',
    icon: 'Icon',
    iconHelp: 'A Lucide icon name, e.g. Box, Wrench, Truck.',
    slugImmutable:
      'The identifier is permanent — changing it would orphan existing records, saved layouts and granted permissions.',
    integrations: 'Integrations',
    integrationsHelp: 'Choose which parts of the platform this object plugs into.',
    integrationEvents: 'Workflows & webhooks',
    integrationEventsHelp: 'Publish events so WeldConnect workflows can react to changes.',
    integrationSearch: 'Global search',
    integrationSearchHelp: 'Include records in platform search results.',
    integrationAgent: 'AI tools',
    integrationAgentHelp:
      'Let WeldAgent and MCP clients read and create records. Requires the public API, which the tools call through.',
    integrationApi: 'Public API',
    integrationApiHelp: 'Expose records through the third-party API at api.weldsuite.org.',
    dangerZone: 'Danger zone',
    dangerHelp: 'Deleting an object removes every record it holds.',
    deleteObject: 'Delete {object}',
    deleteObjectTitle: 'Delete {object}?',
    deleteObjectBody:
      'This permanently removes {records} record(s), {fields} field(s) and {relations} relationship(s).',
    deleteObjectConfirm: 'Delete everything',
    objectDeleted: 'Object deleted',
    deleteFieldTitle: 'Delete field?',
    deleteFieldBody: 'Values stored in “{field}” will be removed from every record.',
    status: {
      draft: 'Draft',
      active: 'Active',
      disabled: 'Disabled',
    },
  },

  // Relationship editor
  links: {
    add: 'Add relationship',
    emptyTitle: 'No relationships yet',
    emptyBody:
      'Link this object to customers, people, tickets or another custom object so related records appear on both sides.',
    dialogTitle: 'New relationship',
    dialogDescription: 'Connect {object} to another type of record.',
    target: 'Related to',
    targetPlaceholder: 'Choose a record type',
    customObject: 'custom object',
    cardinalityLabel: 'Relationship type',
    targetPanelLabel: 'Panel name here',
    targetPanelHelp: 'Shown on this object’s records.',
    sourcePanelLabel: 'Panel name there',
    sourcePanelHelp: 'Shown on the related record.',
    onDeleteLabel: 'When the related record is deleted',
    create: 'Create relationship',
    deleteTitle: 'Delete relationship?',
    deleteBody: 'Existing links through “{link}” will be removed.',
    cardinality: {
      one_to_one: 'One to one',
      one_to_many: 'One to many',
      many_to_one: 'Many to one',
      many_to_many: 'Many to many',
    },
    cardinalityOption: {
      many_to_one: 'Each {object} belongs to one {target}',
      one_to_many: 'Each {object} has many {target}',
      many_to_many: 'Many {object} to many {target}',
      one_to_one: 'Each {object} pairs with exactly one {target}',
    },
    onDelete: {
      set_null: 'unlink',
      cascade: 'delete linked records',
      restrict: 'block deletion',
    },
    onDeleteOption: {
      set_null: 'Just remove the link',
      cascade: 'Delete the linked {objects} too',
      restrict: 'Prevent deletion while links exist',
    },
  },

  errors: {
    saveFailed: 'Could not save changes',
    deleteFailed: 'Could not delete',
    updateFailed: 'Could not update record',
    unlinkFailed: 'Could not unlink record',
    createObjectFailed: 'Could not create object',
  },
};
