/**
 * WeldConnect workflow templates: the API shapes of the template gallery and
 * the built-in starter templates every workspace sees next to its own.
 *
 * Built-ins are code, not rows: connect-api serves them read-only from this
 * module (no per-workspace seeding, no migration), so a fix to a starter
 * template ships with the next deploy to every workspace at once and is
 * reviewed in git like any other change. Their texts live in
 * `@weldsuite/i18n/locales/<locale>/weldconnect-templates` and are filled in
 * by `resolveBuiltInTemplate`; the structure (triggers, steps, branches,
 * variables) lives here and is the same for every language.
 *
 * Every built-in must pass WeldConnect's activation gate except for the fields
 * it lists in `setup` (the channel, project, recipient, … only the workspace
 * can choose): see `built-in-workflow-templates.test.ts` in connect-api.
 */

import { z } from 'zod';

// ============================================================================
// Categories
// ============================================================================

/** Mirrors `TemplateCategory` in packages/core/db/src/schema/workflow-templates.ts. */
export const WORKFLOW_TEMPLATE_CATEGORIES = [
  'sales',
  'marketing',
  'support',
  'operations',
  'finance',
  'hr',
  'development',
  'productivity',
  'communication',
  'data',
  'custom',
] as const;

export const workflowTemplateCategorySchema = z.enum(WORKFLOW_TEMPLATE_CATEGORIES);
export type WorkflowTemplateCategory = z.infer<typeof workflowTemplateCategorySchema>;

// ============================================================================
// Request schemas
// ============================================================================

/** Locales the starter templates are translated into; anything else falls back to English. */
export const WORKFLOW_TEMPLATE_LOCALES = ['en', 'nl'] as const;
export type WorkflowTemplateLocale = (typeof WORKFLOW_TEMPLATE_LOCALES)[number];

export function toTemplateLocale(value: unknown): WorkflowTemplateLocale {
  const base = typeof value === 'string' ? (value.toLowerCase().split(/[-_]/)[0] ?? '') : '';
  return (WORKFLOW_TEMPLATE_LOCALES as readonly string[]).includes(base) ? (base as WorkflowTemplateLocale) : 'en';
}

/** POST /api/workflow-templates/:id/use — always creates a draft. */
export const createFromTemplateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(5000).optional(),
  /** Language of a built-in template's step names and texts. */
  locale: z.string().max(16).optional(),
});
export type CreateFromTemplateInput = z.infer<typeof createFromTemplateSchema>;

/** POST /api/workflow-templates/from-workflow/:workflowId ("Save as template"). */
export const saveWorkflowAsTemplateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(5000).optional(),
  category: workflowTemplateCategorySchema.optional(),
});
export type SaveWorkflowAsTemplateInput = z.infer<typeof saveWorkflowAsTemplateSchema>;

/** PATCH /api/workflow-templates/:id from the gallery's "Edit details". */
export const updateWorkflowTemplateDetailsSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(5000).optional(),
  category: workflowTemplateCategorySchema.optional(),
});
export type UpdateWorkflowTemplateDetailsInput = z.infer<typeof updateWorkflowTemplateDetailsSchema>;

// ============================================================================
// Response shape
// ============================================================================

export type WorkflowTemplateSource = 'builtin' | 'workspace';

/** A trigger as the WeldConnect editor stores it: flat, its settings next to `type`. */
export type TemplateTrigger = { id: string; type: string; isEnabled?: boolean } & Record<string, unknown>;

/** A step as the WeldConnect editor stores it; branch steps point at their branch via `parentBranchId`. */
export interface TemplateStep {
  id: string;
  type: string;
  name: string;
  config: Record<string, unknown>;
  order: number;
  parentBranchId?: string;
}

/**
 * Something to fill in before a workflow made from the template can go live —
 * an issue of WeldConnect's activation gate (`missing_field` with the step and
 * field, `missing_source_workflow` on a trigger, `unsupported_action`, …).
 */
export interface WorkflowTemplateSetupIssue {
  code: string;
  stepId?: string;
  triggerId?: string;
  field?: string;
  type?: string;
}

export interface WorkflowTemplateItem {
  id: string;
  source: WorkflowTemplateSource;
  name: string;
  description: string | null;
  category: string;
  /** A lucide icon name for built-ins; whatever was stored for workspace templates. */
  icon: string | null;
  triggers: TemplateTrigger[];
  steps: TemplateStep[];
  /** Third-party providers the steps use (`slack`, `google_sheets`, …), each needing a connection. */
  requiredIntegrations: string[];
  setupIssues: WorkflowTemplateSetupIssue[];
  usageCount: number;
  authorId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** The workflow "Use template" created (a draft). */
export interface WorkflowFromTemplate {
  id: string;
  templateId: string;
  name: string;
}

// ============================================================================
// Built-in starter templates
// ============================================================================

export const BUILT_IN_TEMPLATE_ID_PREFIX = 'builtin_';

export function isBuiltInTemplateId(id: string): boolean {
  return id.startsWith(BUILT_IN_TEMPLATE_ID_PREFIX);
}

export type BuiltInTemplateKey =
  | 'leadFollowUp'
  | 'dealWonAnnouncement'
  | 'weeklyKickoff'
  | 'webhookToContact'
  | 'contactApproval'
  | 'companyToSheet'
  | 'workflowFailureAlert'
  | 'aiLeadTriage'
  | 'welcomeEmail';

/** One template's strings in one language (`@weldsuite/i18n/locales/<locale>/weldconnect-templates`). */
export interface BuiltInTemplateStrings {
  name: string;
  description: string;
  /** Step names, by the step's short key (`step_task` → `task`). */
  steps: Record<string, string>;
  /** Texts that go into step settings; `{placeholders}` are filled with workflow variables. */
  text: Record<string, string>;
}

export type BuiltInTemplateCatalog = Record<BuiltInTemplateKey, BuiltInTemplateStrings>;

/** A field the user must fill in: a step's config field, or a trigger setting. */
export interface TemplateSetupField {
  stepId?: string;
  triggerId?: string;
  field: string;
}

export interface BuiltInTemplateDefinition {
  id: string;
  key: BuiltInTemplateKey;
  category: WorkflowTemplateCategory;
  icon: string;
  /** Left blank on purpose: user-specific (a channel, a project, a recipient, …). */
  setup: readonly TemplateSetupField[];
  build: (strings: BuiltInTemplateStrings) => { triggers: TemplateTrigger[]; steps: TemplateStep[] };
}

/**
 * `{name}` → value. Only single-brace word placeholders are replaced, so the
 * `{{workflow.variables}}` the values insert are left alone.
 */
export function fillPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/**
 * A string of the template's catalog. `resolveBuiltInTemplate` merges the
 * English strings under every locale, so a key missing here means the English
 * catalog lacks it: a bug the built-in template tests catch.
 */
function at(strings: Record<string, string>, key: string): string {
  const value = strings[key];
  if (value === undefined) throw new Error(`Missing WeldConnect template string "${key}"`);
  return value;
}

const MAIN_TRIGGER = 'trigger_main';

/** Steps in order, numbered by position. */
function ordered(steps: Array<Omit<TemplateStep, 'order'>>): TemplateStep[] {
  return steps.map((step, order) => ({ ...step, order }));
}

function entityTrigger(entityType: string, eventType: string): TemplateTrigger {
  return { id: MAIN_TRIGGER, type: 'entity_event', isEnabled: true, entityType, eventType };
}

const LEAD = {
  name: '{{trigger.record.fullName}}',
  company: '{{trigger.record.companyName}}',
  email: '{{trigger.record.email}}',
  phone: '{{trigger.record.phone}}',
  title: '{{trigger.record.title}}',
  website: '{{trigger.record.website}}',
  source: '{{trigger.record.source}}',
};

const PERSON = {
  id: '{{trigger.record.id}}',
  name: '{{trigger.record.fullName}}',
  firstName: '{{trigger.record.firstName}}',
  email: '{{trigger.record.email}}',
};

export const BUILT_IN_WORKFLOW_TEMPLATES: readonly BuiltInTemplateDefinition[] = [
  {
    id: 'builtin_lead_follow_up',
    key: 'leadFollowUp',
    category: 'sales',
    icon: 'UserPlus',
    setup: [{ stepId: 'step_task', field: 'projectId' }],
    build: ({ steps, text }) => ({
      triggers: [entityTrigger('lead', 'created')],
      steps: ordered([
        {
          id: 'step_task',
          type: 'create_task',
          name: at(steps, 'task'),
          config: {
            projectId: '',
            title: fillPlaceholders(at(text, 'taskTitle'), { name: LEAD.name }),
            description: fillPlaceholders(at(text, 'taskDescription'), { company: LEAD.company, email: LEAD.email, phone: LEAD.phone }),
            dueDate: 'tomorrow',
            priority: 'high',
          },
        },
        {
          id: 'step_notify',
          type: 'send_notification',
          name: at(steps, 'notify'),
          config: {
            title: fillPlaceholders(at(text, 'notifyTitle'), { name: LEAD.name }),
            body: fillPlaceholders(at(text, 'notifyBody'), { task: '{{steps.step_task.url}}' }),
          },
        },
      ]),
    }),
  },
  {
    id: 'builtin_deal_won',
    key: 'dealWonAnnouncement',
    category: 'sales',
    icon: 'Trophy',
    setup: [{ stepId: 'step_announce', field: 'channelId' }],
    build: ({ steps, text }) => ({
      triggers: [entityTrigger('opportunity', 'won')],
      steps: ordered([
        {
          id: 'step_announce',
          type: 'post_chat_message',
          name: at(steps, 'announce'),
          config: {
            channelId: '',
            message: fillPlaceholders(at(text, 'message'), { deal: '{{trigger.record.name}}', amount: '{{trigger.record.amount}}' }),
          },
        },
        {
          id: 'step_log',
          type: 'log_activity',
          name: at(steps, 'log'),
          config: {
            type: 'note',
            subject: fillPlaceholders(at(text, 'activitySubject'), { deal: '{{trigger.record.name}}' }),
            description: at(text, 'activityDescription'),
            opportunityId: '{{trigger.record.id}}',
          },
        },
      ]),
    }),
  },
  {
    id: 'builtin_weekly_kickoff',
    key: 'weeklyKickoff',
    category: 'productivity',
    icon: 'Sparkles',
    setup: [{ stepId: 'step_email', field: 'to' }],
    build: ({ steps, text }) => ({
      triggers: [
        {
          id: MAIN_TRIGGER,
          type: 'schedule',
          isEnabled: true,
          scheduleType: 'recurring',
          cronExpression: '0 8 * * 1',
          timezone: 'Europe/Amsterdam',
        },
      ],
      steps: ordered([
        {
          id: 'step_write',
          type: 'ai_generate',
          name: at(steps, 'write'),
          config: { prompt: fillPlaceholders(at(text, 'prompt'), { date: '{{trigger.scheduledTimeLocal}}' }) },
        },
        {
          id: 'step_email',
          type: 'send_email',
          name: at(steps, 'email'),
          config: { to: '', subject: at(text, 'subject'), body: '{{steps.step_write.text}}', isHtml: false },
        },
      ]),
    }),
  },
  {
    id: 'builtin_webhook_contact',
    key: 'webhookToContact',
    category: 'data',
    icon: 'Webhook',
    setup: [{ stepId: 'step_slack', field: 'channel' }],
    build: ({ steps, text }) => ({
      triggers: [{ id: MAIN_TRIGGER, type: 'webhook', isEnabled: true }],
      steps: ordered([
        {
          id: 'step_contact',
          type: 'create_contact',
          name: at(steps, 'contact'),
          config: {
            firstName: '{{trigger.body.firstName}}',
            lastName: '{{trigger.body.lastName}}',
            email: '{{trigger.body.email}}',
            phone: '{{trigger.body.phone}}',
            skipIfEmailExists: true,
          },
        },
        {
          id: 'step_slack',
          type: 'slack.post_message',
          name: at(steps, 'slack'),
          config: {
            channel: '',
            text: fillPlaceholders(at(text, 'slackText'), { name: '{{steps.step_contact.name}}', email: '{{steps.step_contact.email}}' }),
          },
        },
      ]),
    }),
  },
  {
    id: 'builtin_contact_approval',
    key: 'contactApproval',
    category: 'operations',
    icon: 'ShieldCheck',
    setup: [],
    build: ({ steps, text }) => ({
      triggers: [entityTrigger('person', 'created')],
      steps: ordered([
        {
          id: 'step_review',
          type: 'manual_step',
          name: at(steps, 'review'),
          config: {
            title: fillPlaceholders(at(text, 'reviewTitle'), { name: PERSON.name }),
            description: fillPlaceholders(at(text, 'reviewDescription'), { name: PERSON.name, email: PERSON.email }),
          },
        },
        {
          id: 'step_check',
          type: 'condition',
          name: at(steps, 'check'),
          config: { field: '{{steps.step_review.approved}}', operator: 'eq', value: 'true' },
        },
        {
          id: 'step_tag',
          type: 'update_contact',
          name: at(steps, 'tag'),
          parentBranchId: 'step_check_if',
          config: { contactId: PERSON.id, tags: at(text, 'tag') },
        },
        {
          id: 'step_notify',
          type: 'send_notification',
          name: at(steps, 'notify'),
          parentBranchId: 'step_check_if_not',
          config: {
            title: fillPlaceholders(at(text, 'notifyTitle'), { name: PERSON.name }),
            body: fillPlaceholders(at(text, 'notifyBody'), { comment: '{{steps.step_review.comment}}' }),
          },
        },
      ]),
    }),
  },
  {
    id: 'builtin_company_sheet',
    key: 'companyToSheet',
    category: 'data',
    icon: 'Sheet',
    setup: [{ stepId: 'step_row', field: 'spreadsheetId' }],
    build: ({ steps, text }) => ({
      triggers: [entityTrigger('company', 'created')],
      steps: ordered([
        {
          id: 'step_row',
          type: 'google_sheets.append_row',
          name: at(steps, 'row'),
          config: {
            spreadsheetId: '',
            sheetName: '',
            columnMapping: {
              [at(text, 'columnName')]: '{{trigger.record.name}}',
              [at(text, 'columnWebsite')]: '{{trigger.record.website}}',
              [at(text, 'columnIndustry')]: '{{trigger.record.industry}}',
              [at(text, 'columnEmail')]: '{{trigger.record.email}}',
              [at(text, 'columnPhone')]: '{{trigger.record.phone}}',
            },
          },
        },
      ]),
    }),
  },
  {
    id: 'builtin_workflow_failed',
    key: 'workflowFailureAlert',
    category: 'operations',
    icon: 'AlertTriangle',
    setup: [{ triggerId: MAIN_TRIGGER, field: 'sourceWorkflowId' }],
    build: ({ steps, text }) => ({
      triggers: [
        { id: MAIN_TRIGGER, type: 'workflow_complete', isEnabled: true, sourceWorkflowId: '', triggerOn: 'failure' },
      ],
      steps: ordered([
        {
          id: 'step_notify',
          type: 'send_notification',
          name: at(steps, 'notify'),
          config: {
            title: fillPlaceholders(at(text, 'title'), { workflow: '{{trigger.sourceWorkflowName}}' }),
            body: fillPlaceholders(at(text, 'body'), { workflow: '{{trigger.sourceWorkflowName}}' }),
            severity: 'error',
            actionUrl: '/weldconnect/executions/{{trigger.sourceExecutionId}}',
          },
        },
      ]),
    }),
  },
  {
    id: 'builtin_ai_lead_triage',
    key: 'aiLeadTriage',
    category: 'sales',
    icon: 'Tags',
    setup: [],
    build: ({ steps, text }) => ({
      triggers: [entityTrigger('lead', 'created')],
      steps: ordered([
        {
          id: 'step_classify',
          type: 'ai_classify',
          name: at(steps, 'classify'),
          config: {
            text: fillPlaceholders(at(text, 'classifyText'), {
              name: LEAD.name,
              title: LEAD.title,
              company: LEAD.company,
              website: LEAD.website,
              source: LEAD.source,
            }),
            categories: [at(text, 'hot'), at(text, 'warm'), at(text, 'cold')],
          },
        },
        {
          id: 'step_check',
          type: 'condition',
          name: at(steps, 'check'),
          config: { field: '{{steps.step_classify.category}}', operator: 'eq', value: at(text, 'hot') },
        },
        {
          id: 'step_notify',
          type: 'send_notification',
          name: at(steps, 'notify'),
          parentBranchId: 'step_check_if',
          config: {
            title: fillPlaceholders(at(text, 'notifyTitle'), { name: LEAD.name }),
            body: fillPlaceholders(at(text, 'notifyBody'), { company: LEAD.company }),
          },
        },
      ]),
    }),
  },
  {
    id: 'builtin_welcome_email',
    key: 'welcomeEmail',
    category: 'communication',
    icon: 'Mail',
    setup: [],
    build: ({ steps, text }) => ({
      triggers: [entityTrigger('person', 'created')],
      steps: ordered([
        { id: 'step_wait', type: 'delay', name: at(steps, 'wait'), config: { days: 1 } },
        {
          id: 'step_check',
          type: 'condition',
          name: at(steps, 'check'),
          config: { field: PERSON.email, operator: 'isNotEmpty' },
        },
        {
          id: 'step_email',
          type: 'send_email',
          name: at(steps, 'email'),
          parentBranchId: 'step_check_if',
          config: {
            to: PERSON.email,
            subject: fillPlaceholders(at(text, 'subject'), { firstName: PERSON.firstName }),
            body: fillPlaceholders(at(text, 'body'), { firstName: PERSON.firstName }),
          },
        },
      ]),
    }),
  },
];

export function findBuiltInTemplate(id: string): BuiltInTemplateDefinition | undefined {
  return BUILT_IN_WORKFLOW_TEMPLATES.find((template) => template.id === id);
}

export interface ResolvedBuiltInTemplate {
  id: string;
  key: BuiltInTemplateKey;
  name: string;
  description: string;
  category: WorkflowTemplateCategory;
  icon: string;
  triggers: TemplateTrigger[];
  steps: TemplateStep[];
  setup: readonly TemplateSetupField[];
}

/**
 * A built-in template in one language. A string missing from `catalog` falls
 * back to `fallback` (English), so a half-translated locale still yields a
 * complete template.
 */
export function resolveBuiltInTemplate(
  definition: BuiltInTemplateDefinition,
  catalog: BuiltInTemplateCatalog,
  fallback: BuiltInTemplateCatalog = catalog,
): ResolvedBuiltInTemplate {
  const base = fallback[definition.key];
  const local = catalog[definition.key] ?? base;
  const strings: BuiltInTemplateStrings = {
    name: local.name || base.name,
    description: local.description || base.description,
    steps: { ...base.steps, ...local.steps },
    text: { ...base.text, ...local.text },
  };
  const { triggers, steps } = definition.build(strings);
  return {
    id: definition.id,
    key: definition.key,
    name: strings.name,
    description: strings.description,
    category: definition.category,
    icon: definition.icon,
    triggers,
    steps,
    setup: definition.setup,
  };
}

/** The third-party providers a template's steps use: `slack.post_message` → `slack`. */
export function templateProviders(steps: ReadonlyArray<{ type?: unknown }>): string[] {
  const providers = new Set<string>();
  for (const step of steps) {
    const type = typeof step.type === 'string' ? step.type : '';
    const dot = type.indexOf('.');
    if (dot > 0) providers.add(type.slice(0, dot));
  }
  return [...providers];
}
