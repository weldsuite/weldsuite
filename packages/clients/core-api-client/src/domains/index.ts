export { createWeldcrmApi } from './weldcrm';
// Identity layer — `companies` and `people` moved to app-api; see
// `apps/web/platform/components/objects/{company,person}/use-{company,person}-data.ts`.
export { createPartiesApi } from './parties';
export { createListsApi } from './lists';
// Legacy customers/contacts domain clients were removed in the
// companies/people migration. Use the canonical hooks in
// apps/web/platform/components/objects/{company,person}/use-{company,person}-data.ts.
export { createTeamApi } from './team';
export { createAccessRequestsApi } from './access-requests';
export { createWeldmailApi } from './weldmail';
export { createWeldconnectApi } from './weldconnect';
export { createGithubApi } from './github';
export { createWeldflowApi } from './weldflow';
export { createWeldstashApi } from './weldstash';
export { createWeldagentApi } from './weldagent';
export { createNotificationsApi } from './notifications';
export { createSearchApi } from './search';
export { createWeldchatActivityApi } from './weldchat-activity';
export { createWeldchatDraftsApi } from './weldchat-drafts';
export { createWeldchatDirectoriesApi } from './weldchat-directories';
export { createWeldhostApi } from './weldhost';
export { createWeldmeetApi } from './weldmeet';
export { createSettingsApi } from './settings';
