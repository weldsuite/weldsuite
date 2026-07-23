export * from './activities';
// Identity layer (new — Companies/People refactor)
// Note: ./companies moved to @weldsuite/app-api-client/schemas/companies
export * from './people';
export * from './person-companies';
export * from './parties';
// CRM shapes (legacy customers/contacts/suppliers/contact-links removed in
// the companies/people migration — use schemas/companies + schemas/people +
// schemas/person-companies above).
export * from './enrichments';
export * from './leads';
export * from './lists';
export * from './opportunities';
export * from './pipelines-crm';
export * from './pipeline-stages';
export * from './sequences';
export * from './customer-statuses';
export * from './pipelines';
export * from './members';
export * from './member-profile';
export * from './access-requests';
// Note: ./weldmail intentionally NOT re-exported — the entire
// weldmail surface moved to `@weldsuite/app-api-client/schemas/mail-*`.
// Re-export would clash with `createLabelSchema` / `CreateLabelInput` in
// ./weldflow. The file is retained so direct subpath imports keep working
// until any remaining consumers are migrated.
export * from './weldconnect';
export * from './weldconnect-builder';
export * from './welddesk-blocks';
export * from './entity-channels';
export * from './github';
export * from './weldflow';
export * from './weldstash';
export * from './notifications';
export * from './search';
export * from './weldchat-activity';
export * from './weldchat-drafts';
export * from './weldchat-directories';
export * from './weldmeet';
export * from './workspace';
export * from './calendar';
