/**
 * What `generate.mts` writes: the Zod schemas the /v1 routes validate with
 * (by the Rust constant's name), and the tenant tables they write (by their
 * export name in `@weldsuite/db/schema`). Schemas a route defines inline are
 * written by hand in `src/schemas.rs`.
 */

const core = (file: string) => `@weldsuite/core-api-client/schemas/${file}`;
const app = (file: string) => `@weldsuite/app-api-client/schemas/${file}`;

export interface SchemaEntry {
  name: string;
  from: string;
  export: string;
  /** `.strip()` of the export (a route that strips a passthrough schema). */
  strip?: boolean;
  /** What the route makes of the export (`.omit()`, `.extend()`), given zod's module. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  derive?: (schema: any, zod: any) => unknown;
}

const s = (name: string, from: string, exportName: string, strip = false): SchemaEntry => ({
  name,
  from,
  export: exportName,
  strip,
});

export const SCHEMAS: SchemaEntry[] = [
  // CRM
  s('CREATE_PERSON', core('people'), 'createPersonSchema'),
  s('UPDATE_PERSON', core('people'), 'updatePersonSchema'),
  s('LIST_PEOPLE', core('people'), 'listPeopleQuery'),
  s('CREATE_COMPANY', app('companies'), 'createCompanySchema'),
  s('UPDATE_COMPANY', app('companies'), 'updateCompanySchema'),
  s('LIST_COMPANIES', app('companies'), 'listCompaniesQuery'),
  s('CREATE_LEAD', core('leads'), 'createLeadSchema'),
  s('UPDATE_LEAD', core('leads'), 'updateLeadSchema'),
  s('LIST_LEADS', core('leads'), 'listLeadsQuery'),
  s('CREATE_OPPORTUNITY', core('opportunities'), 'createOpportunitySchema'),
  s('UPDATE_OPPORTUNITY', core('opportunities'), 'updateOpportunitySchema'),
  s('LIST_OPPORTUNITIES', core('opportunities'), 'listOpportunitiesQuery'),
  s('CREATE_PIPELINE', core('pipelines-crm'), 'createPipelineSchema'),
  s('UPDATE_PIPELINE', core('pipelines-crm'), 'updatePipelineSchema'),
  s('LIST_PIPELINES', core('pipelines-crm'), 'listPipelinesQuery'),
  s('CREATE_PIPELINE_STAGE', core('pipeline-stages'), 'createPipelineStageSchema'),
  s('UPDATE_PIPELINE_STAGE', core('pipeline-stages'), 'updatePipelineStageSchema'),
  s('LIST_PIPELINE_STAGES', core('pipeline-stages'), 'listPipelineStagesQuery'),
  s('CREATE_ACTIVITY', core('activities'), 'createActivitySchema'),
  s('UPDATE_ACTIVITY', core('activities'), 'updateActivitySchema'),
  s('LIST_ACTIVITIES', core('activities'), 'listActivitiesQuery'),
  // Flow
  s('CREATE_PROJECT', app('projects'), 'createProjectSchema'),
  s('UPDATE_PROJECT', app('projects'), 'updateProjectSchema'),
  s('CREATE_TASK', app('tasks'), 'createTaskSchema', true),
  s('UPDATE_TASK', app('tasks'), 'updateTaskSchema'),
  s('CREATE_GOAL', core('goals'), 'createGoalSchema'),
  s('UPDATE_GOAL', core('goals'), 'updateGoalSchema'),
  s('CREATE_MILESTONE', core('milestones'), 'createMilestoneSchema'),
  s('UPDATE_MILESTONE', core('milestones'), 'updateMilestoneSchema'),
  s('CREATE_SPRINT', core('sprints'), 'createSprintSchema'),
  s('UPDATE_SPRINT', core('sprints'), 'updateSprintSchema'),
  s('CREATE_TASK_COMMENT', core('task-comments'), 'createTaskCommentSchema'),
  s('UPDATE_TASK_COMMENT', core('task-comments'), 'updateTaskCommentSchema'),
  s('CREATE_TASK_TAG', core('task-tags'), 'createTaskTagSchema'),
  s('UPDATE_TASK_TAG', core('task-tags'), 'updateTaskTagSchema'),
  s('CREATE_PROJECT_DOCUMENT', core('project-documents'), 'createProjectDocumentSchema'),
  s('UPDATE_PROJECT_DOCUMENT', core('project-documents'), 'updateProjectDocumentSchema'),
  s('CREATE_PROJECT_FILE', core('project-files'), 'createProjectFileSchema'),
  s('UPDATE_PROJECT_FILE', core('project-files'), 'updateProjectFileSchema'),
  s('CREATE_PROJECT_LABEL', core('project-labels'), 'createProjectLabelSchema'),
  s('UPDATE_PROJECT_LABEL', core('project-labels'), 'updateProjectLabelSchema'),
  s('CREATE_PROJECT_MEMBER', core('project-members'), 'createProjectMemberSchema'),
  s('UPDATE_PROJECT_MEMBER', core('project-members'), 'updateProjectMemberSchema'),
  s('CREATE_PROJECT_MESSAGE', core('project-messages'), 'createProjectMessageSchema'),
  s('UPDATE_PROJECT_MESSAGE', core('project-messages'), 'updateProjectMessageSchema'),
  s('CREATE_WHITEBOARD', core('whiteboards'), 'createWhiteboardSchema'),
  s('UPDATE_WHITEBOARD', core('whiteboards'), 'updateWhiteboardSchema'),
  // Desk
  s('CREATE_ARTICLE', core('articles'), 'createArticleSchema'),
  s('UPDATE_ARTICLE', core('articles'), 'updateArticleSchema'),
  // Chat
  s('CREATE_CHANNEL', core('channels'), 'createChannelSchema'),
  s('UPDATE_CHANNEL', core('channels'), 'updateChannelSchema'),
  s('CREATE_CHANNEL_MEMBER', core('channel-members'), 'createChannelMemberSchema'),
  s('UPDATE_CHANNEL_MEMBER', core('channel-members'), 'updateChannelMemberSchema'),
  s('CREATE_CHAT_MESSAGE', core('chat-messages'), 'createChatMessageSchema'),
  s('UPDATE_CHAT_MESSAGE', core('chat-messages'), 'updateChatMessageSchema'),
  s('CREATE_CHAT_BOOKMARK', core('chat-bookmarks'), 'createChatBookmarkSchema'),
  s('UPDATE_CHAT_BOOKMARK', core('chat-bookmarks'), 'updateChatBookmarkSchema'),
  s('CREATE_CHAT_DRAFT', core('chat-drafts'), 'createChatDraftSchema'),
  s('UPDATE_CHAT_DRAFT', core('chat-drafts'), 'updateChatDraftSchema'),
  s('CREATE_CHAT_SECTION', core('chat-sections'), 'createChatSectionSchema'),
  s('UPDATE_CHAT_SECTION', core('chat-sections'), 'updateChatSectionSchema'),
  // Calendar
  s('CREATE_CALENDAR', core('calendars'), 'createCalendarSchema'),
  s('UPDATE_CALENDAR', core('calendars'), 'updateCalendarSchema'),
  s('CREATE_CALENDAR_EVENT', core('calendar-events'), 'createCalendarEventSchema'),
  s('UPDATE_CALENDAR_EVENT', core('calendar-events'), 'updateCalendarEventSchema'),
  // Commerce
  s('CREATE_PRODUCT', core('products'), 'createProductSchema'),
  s('UPDATE_PRODUCT', core('products'), 'updateProductSchema'),
  s('CREATE_ORDER', core('orders'), 'createOrderSchema'),
  s('UPDATE_ORDER', core('orders'), 'updateOrderSchema'),
  // Social
  s('CREATE_SOCIAL_ACCOUNT', core('social-accounts'), 'createSocialAccountSchema'),
  s('UPDATE_SOCIAL_ACCOUNT', core('social-accounts'), 'updateSocialAccountSchema'),
  s('CREATE_SOCIAL_CAMPAIGN', core('social-campaigns'), 'createSocialCampaignSchema'),
  s('UPDATE_SOCIAL_CAMPAIGN', core('social-campaigns'), 'updateSocialCampaignSchema'),
  s('CREATE_SOCIAL_ANALYTICS', core('social-analytics'), 'createSocialAnalyticsSchema'),
  s('UPDATE_SOCIAL_ANALYTICS', core('social-analytics'), 'updateSocialAnalyticsSchema'),
  s('CREATE_SOCIAL_MEDIA', core('social-media'), 'createSocialMediaSchema'),
  s('UPDATE_SOCIAL_MEDIA', core('social-media'), 'updateSocialMediaSchema'),
  s('CREATE_SOCIAL_POST', core('social-posts'), 'createSocialPostSchema'),
  s('UPDATE_SOCIAL_POST', core('social-posts'), 'updateSocialPostSchema'),
  // Books
  s('CREATE_ACCOUNTING_CONTACT', core('accounting-contacts'), 'createAccountingContactSchema'),
  s('UPDATE_ACCOUNTING_CONTACT', core('accounting-contacts'), 'updateAccountingContactSchema'),
  // Host
  s('LIST_DOMAINS', core('domains'), 'listDomainsQuery'),
  s('CREATE_DOMAIN', core('domains'), 'createDomainSchema'),
  s('UPDATE_DOMAIN', core('domains'), 'updateDomainSchema'),
  s('CREATE_DNS_ZONE', core('dns-zones'), 'createDnsZoneSchema'),
  s('UPDATE_DNS_ZONE', core('dns-zones'), 'updateDnsZoneSchema'),
  s('CREATE_DNS_RECORD', core('dns-records'), 'createDnsRecordSchema'),
  s('UPDATE_DNS_RECORD', core('dns-records'), 'updateDnsRecordSchema'),
  // Know
  s('CREATE_KNOWLEDGE_SPACE', core('knowledge'), 'createKnowledgeSpaceSchema'),
  s('UPDATE_KNOWLEDGE_SPACE', core('knowledge'), 'updateKnowledgeSpaceSchema'),
  // Desk: tickets (read-mostly; a new one opens an inbox conversation) and the inbox
  s('LIST_TICKETS', app('tickets'), 'listTicketsQuery'),
  {
    ...s('OPEN_TICKET', app('tickets'), 'createTicketSchema'),
    derive: (schema, zod) => schema.extend({ externalId: zod.z.string().trim().min(1).max(255).optional() }),
  },
  s('UPDATE_TICKET', app('tickets'), 'updateTicketSchema'),
  {
    ...s('CREATE_TICKET_MESSAGE', core('ticket-messages'), 'createTicketMessageSchema'),
    derive: (schema) => schema.omit({ ticketId: true }),
  },
  {
    ...s('LIST_CONVERSATIONS', core('desk-conversations'), 'listConversationsQuerySchema'),
    derive: (schema, zod) => schema.extend({ search: zod.z.string().trim().max(200).optional() }),
  },
  s('GET_CONVERSATION_QUERY', core('desk-conversations'), 'getConversationQuerySchema'),
  s('LIST_CONVERSATION_MESSAGES', core('desk-conversations'), 'listConversationMessagesQuerySchema'),
  s('OPEN_CONVERSATION', core('desk-conversations'), 'openDeskConversationSchema'),
  s('UPDATE_CONVERSATION', core('desk-conversations'), 'updateDeskConversationSchema'),
  s('ADD_CONVERSATION_MESSAGE', core('desk-conversations'), 'addDeskConversationMessageSchema'),
  // Drive
  s('LIST_FILES', core('files'), 'listFilesQuery'),
  s('CREATE_FILE', core('files'), 'createFileSchema'),
  s('UPDATE_FILE', core('files'), 'updateFileSchema'),
  s('LIST_FOLDERS', core('folders'), 'listFoldersQuery'),
  s('CREATE_FOLDER', core('folders'), 'createFolderSchema'),
  s('UPDATE_FOLDER', core('folders'), 'updateFolderSchema'),
  // Connect
  s('CREATE_WORKFLOW', core('weldconnect'), 'createWorkflowSchema'),
  s('UPDATE_WORKFLOW', core('weldconnect'), 'updateWorkflowSchema'),
  {
    ...s('CREATE_SCHEDULE', core('weldconnect'), 'createScheduleSchema'),
    derive: (schema) => schema.omit({ workflowId: true }),
  },
  s('UPDATE_SCHEDULE', core('weldconnect'), 'updateScheduleSchema'),
];

export const TABLES = [
  // CRM
  'people',
  'companies',
  'crmLeads',
  'crmOpportunities',
  'crmPipelines',
  'crmPipelineStages',
  'crmActivities',
  'crmQuotes',
  // Flow
  'projects',
  'tasks',
  'projectGoals',
  'milestones',
  'sprints',
  'taskComments',
  'taskTags',
  'projectDocuments',
  'projectFiles',
  'projectLabels',
  'projectMembers',
  'projectMessages',
  'projectWhiteboards',
  'timeEntries',
  // Desk
  'helpdeskArticles',
  // Commerce
  'categories',
  // Chat
  'chatChannels',
  'chatChannelMembers',
  'chatMessages',
  'chatBookmarks',
  'chatDrafts',
  'chatSections',
  // Calendar
  'calendars',
  'calendarEvents',
  // Commerce
  'products',
  'orders',
  // Social
  'socialAccounts',
  'socialCampaigns',
  'socialAnalytics',
  'socialMedia',
  'socialPosts',
  // Books (read through `columnsFor`: ciphertext columns left out)
  'entities',
  'accounts',
  'invoices',
  'bills',
  'journalEntries',
  'payments',
  'bankAccounts',
  'bankTransactions',
  'taxRates',
  'recurringInvoices',
  'reconciliationRules',
  'fiscalPeriods',
  'fxRates',
  'vatReturns',
  'icpDeclarations',
  'documents',
  'settings',
  'parties',
  // Host
  'hostDomains',
  'hostDnsZones',
  'hostDnsRecords',
  // Know
  'knowledgeSpaces',
  'knowledgePages',
  // Desk
  'helpdeskTickets',
  'helpdeskTicketMessages',
  // Drive
  'files',
  'folders',
  // Connect
  'workflows',
  'workflowSchedules',
  'workflowExecutions',
  'workflowWebhooks',
] as const;

/** Tables read without their ciphertext columns (`selectableColumns`). */
export const OMIT_SENSITIVE: ReadonlySet<string> = new Set(['entities', 'bankAccounts', 'parties']);
