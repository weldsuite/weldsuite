export * from './types';

// Tasks / projects / tickets / companies / object-templates — pre-existing.
export * from './schemas/tasks';
export * from './schemas/projects';
export * from './schemas/tickets';
export * from './schemas/companies';
export * from './schemas/object-templates';
export * from './domains/tasks';
export * from './domains/projects';
export * from './domains/tickets';
export * from './domains/companies';
export * from './domains/object-templates';

// WeldMail — one schema + domain per entity. Re-export everything so the
// platform can import from `@weldsuite/app-api-client` directly without
// having to know the per-entity subpath, while the package.json `exports`
// map still allows tree-shaking when sub-imports are used.
export * from './schemas/mail-accounts';
export * from './schemas/mail-messages';
export * from './schemas/mail-labels';
export * from './schemas/mail-drafts';
export * from './schemas/mail-attachments';
export * from './schemas/mail-folders';
export * from './schemas/mail-templates';
export * from './schemas/mail-signatures';
export * from './schemas/mail-rules';
export * from './schemas/mail-campaigns';
export * from './schemas/mail-domains';
export * from './schemas/mail-scheduled';
export * from './schemas/mail-snooze';
export * from './schemas/mail-sync';
export * from './schemas/mail-threads';
export * from './schemas/mail-weldmail';
export * from './schemas/mail-ai';

export * from './domains/mail-accounts';
export * from './domains/mail-messages';
export * from './domains/mail-labels';
export * from './domains/mail-drafts';
export * from './domains/mail-attachments';
export * from './domains/mail-folders';
export * from './domains/mail-templates';
export * from './domains/mail-signatures';
export * from './domains/mail-rules';
export * from './domains/mail-campaigns';
export * from './domains/mail-domains';
export * from './domains/mail-scheduled';
export * from './domains/mail-snooze';
export * from './domains/mail-sync';
export * from './domains/mail-threads';
export * from './domains/mail-weldmail';
export * from './domains/mail-ai';

// Mobile-consolidation surfaces — workspaces switcher + push tokens.
export * from './schemas/push-tokens';
export * from './domains/push-tokens';
export * from './domains/workspaces';

// Feature flags — client-exposed flags resolved via Cloudflare Flagship.
export * from './schemas/feature-flags';
export * from './domains/feature-flags';

// WeldAgent — personal AI assistant conversations / messages / settings / mentions.
export * from './schemas/weldagent';
export * from './domains/weldagent';

// WeldChat — channels / messages / sections / DMs / search / calls / members.
// Pure typed domain wrappers over the flat /api/chat-* + /api/channels surface.
export * from './domains/channels';
export * from './domains/chat-messages';
export * from './domains/chat-sections';
export * from './domains/chat-dm';
export * from './domains/chat-search';
export * from './domains/chat-calls';
export * from './domains/chat-members';
export * from './domains/chat-agent';

// Notifications — flat /api/notifications/* surface (list / unread-count / read).
export * from './domains/notifications';

// Dashboard — read-only workspace-home reads (installed apps for the WeldChat layout).
export * from './domains/dashboard';
