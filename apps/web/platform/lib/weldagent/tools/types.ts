import { z } from 'zod';
import type { ScopedDb } from '@/lib/db/scoped';

// Module keys for WeldAgent access
export type ModuleKey =
  | 'general'
  | 'crm'
  | 'commerce'
  | 'accounting'
  | 'mail'
  | 'helpdesk'
  | 'parcel'
  | 'projects'
  | 'tasks'
  | 'host';

// Tool operation types
type ToolOperation = 'read' | 'create' | 'update' | 'delete';

// Context passed to tool execution
interface ToolContext {
  workspaceId: string;
  userId: string;
  db: ScopedDb;
  moduleKey: ModuleKey;
}

// Result from tool execution
interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  summary?: string; // Human-readable summary for AI
}

// Base interface for all WeldAgent tools
interface WeldAgentTool<TParams = unknown, TResult = unknown> {
  /** Unique tool identifier (snake_case) */
  name: string;

  /** Human-readable description for the AI */
  description: string;

  /** Which module this tool belongs to */
  module: ModuleKey;

  /** Type of operation (for permission checking) */
  operation: ToolOperation;

  /** Zod schema for parameter validation */
  parameters: z.ZodType<TParams>;

  /** Execute the tool with validated parameters */
  execute: (params: TParams, context: ToolContext) => Promise<ToolResult<TResult>>;

  /** Required permissions to use this tool */
  requiredPermissions?: string[];
}

// Helper type for creating tools
type CreateToolParams<TParams, TResult> = Omit<
  WeldAgentTool<TParams, TResult>,
  'execute'
> & {
  execute: (params: TParams, context: ToolContext) => Promise<ToolResult<TResult>>;
};

// Tool definition for AI SDK format conversion
interface AISDKToolDefinition {
  description: string;
  parameters: z.ZodSchema;
  execute?: (args: unknown) => Promise<unknown>;
}

// App permissions type (matches database schema)
export interface AppPermissions {
  crm?: boolean;
  commerce?: boolean;
  accounting?: boolean;
  mail?: boolean;
  helpdesk?: boolean;
  parcel?: boolean;
  projects?: boolean;
  tasks?: boolean;
  host?: boolean;
}

// Entity context for tools (what entity the user is viewing)
export interface EntityContext {
  type: string;
  id: string;
  title?: string;
  customSystemPrompt?: string;
  data?: Record<string, unknown>;
  suggestedTools?: string[];
  /** Short chat-starter prompts shown as suggestion chips on the empty panel. */
  suggestedPrompts?: string[];
}

// Available AI models
export interface AIModel {
  id: string;
  name: string;
  provider: 'OpenAI' | 'Anthropic' | 'Google';
  tier: 'standard' | 'premium';
  inputPrice: number; // per 1M tokens in cents
  outputPrice: number; // per 1M tokens in cents
  creditsPerKToken: number; // credits charged per 1000 tokens
}

/** API response shape from GET /api/ai/models */
export interface AIModelFromAPI {
  modelId: string;
  provider: string;
  displayName: string;
  tier: string;
  inputPriceCents: number;
  outputPriceCents: number;
  creditsPerKToken: number;
  sortOrder: number;
}

/**
 * Static fallback models — used when the API is unavailable.
 * The API (GET /api/ai/models) is the source of truth.
 */
export const AVAILABLE_MODELS: AIModel[] = [
  // OpenAI
  { id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'OpenAI', tier: 'premium', inputPrice: 250, outputPrice: 1000, creditsPerKToken: 1 },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', provider: 'OpenAI', tier: 'standard', inputPrice: 15, outputPrice: 60, creditsPerKToken: 1 },
  // Anthropic
  { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'Anthropic', tier: 'premium', inputPrice: 300, outputPrice: 1500, creditsPerKToken: 1 },
  { id: 'anthropic/claude-3-5-haiku-latest', name: 'Claude Haiku', provider: 'Anthropic', tier: 'standard', inputPrice: 80, outputPrice: 400, creditsPerKToken: 1 },
  // Google
  { id: 'google/gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'Google', tier: 'standard', inputPrice: 10, outputPrice: 40, creditsPerKToken: 1 },
  { id: 'google/gemini-1.5-pro', name: 'Gemini 1.5 Pro', provider: 'Google', tier: 'premium', inputPrice: 125, outputPrice: 500, creditsPerKToken: 1 },
];

export const DEFAULT_MODEL = 'openai/gpt-4o';
const DEFAULT_FALLBACK_MODEL = 'anthropic/claude-sonnet-4-20250514';

/** Convert API model response to the local AIModel format */
export function apiModelToLocal(m: AIModelFromAPI): AIModel {
  const providerMap: Record<string, AIModel['provider']> = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google',
  };
  return {
    id: m.modelId,
    name: m.displayName,
    provider: providerMap[m.provider] || 'OpenAI',
    tier: m.tier as 'standard' | 'premium',
    inputPrice: m.inputPriceCents,
    outputPrice: m.outputPriceCents,
    creditsPerKToken: m.creditsPerKToken,
  };
}

// ============================================
// Inline Forms for Interactive Chat Elements
// ============================================

/** Field types supported in inline forms */
type InlineFormFieldType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'date'
  | 'datetime'
  | 'number'
  | 'checkbox'
  | 'radio'
  | 'email'
  | 'url'
  | 'phone';

/** Option for select, radio, and checkbox fields */
interface InlineFormOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

/** Individual field definition for inline forms */
export interface InlineFormField {
  /** Unique field name (used as form key) */
  name: string;

  /** Field type determines the input component */
  type: InlineFormFieldType;

  /** Display label for the field */
  label: string;

  /** Optional placeholder text */
  placeholder?: string;

  /** Whether this field is required */
  required?: boolean;

  /** Options for select/radio/checkbox fields */
  options?: InlineFormOption[];

  /** Default/prefilled value */
  defaultValue?: unknown;

  /** Validation constraints */
  validation?: {
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  };

  /** Helper text shown below the field */
  helperText?: string;
}

/** Request for rendering an inline form in chat */
export interface InlineFormRequest {
  /** Unique identifier for this form instance */
  formId: string;

  /** Type of form (used for routing submission) */
  formType: string;

  /** Form title displayed above fields */
  title: string;

  /** Optional description/instructions */
  description?: string;

  /** Array of form fields to render */
  fields: InlineFormField[];

  /** Custom submit button label */
  submitLabel?: string;

  /** Custom cancel button label (if cancellable) */
  cancelLabel?: string;

  /** Whether form can be dismissed without submitting */
  cancellable?: boolean;

  /** Pre-filled values keyed by field name */
  prefilled?: Record<string, unknown>;

  /** Additional context passed back on submission */
  context?: Record<string, unknown>;
}

/** Extended tool result that can request an inline form */
interface FormToolResult<T = unknown> extends ToolResult<T> {
  /** If present, renders an inline form for user input */
  requiresForm?: InlineFormRequest;
}

/** Submitted form data from inline form */
export interface InlineFormSubmission {
  /** ID of the form being submitted */
  formId: string;

  /** Type of form (matches InlineFormRequest.formType) */
  formType: string;

  /** User-provided values keyed by field name */
  values: Record<string, unknown>;

  /** Context passed through from form request */
  context?: Record<string, unknown>;
}

/** Result of processing a form submission */
interface FormSubmissionResult<T = unknown> extends ToolResult<T> {
  /** If true, form was processed successfully */
  formProcessed: boolean;

  /** If present, show a follow-up form */
  nextForm?: InlineFormRequest;
}

// ============================================
// Inline Charts for Data Visualization
// ============================================

/** Chart types supported in inline charts */
type ChartType = 'bar' | 'line' | 'area' | 'pie';

/** Series configuration for chart data */
interface ChartSeries {
  /** Data key to plot */
  dataKey: string;

  /** Display label for the series */
  label: string;

  /** Optional color (uses shadcn chart colors by default) */
  color?: string;

  /** Stack group for stacked charts */
  stackId?: string;
}

/** Chart data configuration */
export interface ChartData {
  /** Type of chart to render */
  chartType: ChartType;

  /** Array of data points */
  data: Array<Record<string, unknown>>;

  /** Chart configuration */
  config: {
    /** Key for X-axis values (bar/line/area) or name key (pie) */
    xAxisKey: string;

    /** Series to display */
    series: ChartSeries[];

    /** Optional Y-axis label */
    yAxisLabel?: string;

    /** Optional X-axis label */
    xAxisLabel?: string;

    /** Show legend (default: true for multiple series) */
    showLegend?: boolean;

    /** Show grid lines (default: true) */
    showGrid?: boolean;
  };

  /** Chart title */
  title?: string;

  /** Chart description/subtitle */
  description?: string;
}

/** Extended tool result that can render a chart */
interface ChartToolResult<T = unknown> extends ToolResult<T> {
  /** If present, renders an inline chart visualization */
  requiresChart?: ChartData;

  /** Human-readable message to display with the chart */
  message?: string;
}

// ============================================
// @ Mentions for Entity References
// ============================================

/** Entity types that can be mentioned */
export type MentionEntityType =
  | 'product'
  | 'customer'
  | 'order'
  | 'contact'
  | 'task'
  | 'project'
  | 'ticket'
  | 'member';

/** A mention reference to an entity */
export interface Mention {
  /** Entity ID */
  id: string;

  /** Type of entity */
  type: MentionEntityType;

  /** Display label */
  label: string;

  /** Optional description/subtitle */
  description?: string;
}

/** Search result for mentions with additional display info */
export interface MentionSearchResult extends Mention {
  /** Icon identifier for the entity type */
  icon?: string;
}

/** Configuration for mention entity categories */
export interface MentionCategory {
  type: MentionEntityType;
  label: string;
  icon: string;
  pluralLabel: string;
}

/** Category configuration for mentions */
export const MENTION_CATEGORIES: MentionCategory[] = [
  { type: 'product', label: 'Product', pluralLabel: 'Products', icon: 'package' },
  { type: 'customer', label: 'Customer', pluralLabel: 'Customers', icon: 'users' },
  { type: 'order', label: 'Order', pluralLabel: 'Orders', icon: 'shopping-cart' },
  { type: 'contact', label: 'Contact', pluralLabel: 'Contacts', icon: 'user' },
  { type: 'task', label: 'Task', pluralLabel: 'Tasks', icon: 'check-square' },
  { type: 'project', label: 'Project', pluralLabel: 'Projects', icon: 'folder' },
  { type: 'ticket', label: 'Ticket', pluralLabel: 'Tickets', icon: 'ticket' },
  { type: 'member', label: 'Team Member', pluralLabel: 'Team Members', icon: 'user-circle' },
];
