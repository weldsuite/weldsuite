/**
 * Form schemas and payload builders of the RAID dialogs.
 *
 * The field rules are the shared request schemas of
 * `@weldsuite/app-api-client/schemas/project-control` (the ones flow-api
 * validates with), picked field by field. The forms hold what inputs hold (a
 * `YYYY-MM-DD` date, a number or null), so the builders turn a form into a
 * request body and every body is checked against the full shared schema
 * before it is sent.
 */

import { z } from 'zod';
import {
  assessRiskSchema,
  convertRaidItemSchema,
  createAssumptionSchema,
  createDependencySchema,
  createIssueSchema,
  createRaidItemSchema,
  createRaidTaskSchema,
  createRiskSchema,
  updateRaidItemSchemas,
} from '@weldsuite/app-api-client/schemas/project-control';
import type {
  AssessRiskInput,
  ConvertRaidItemInput,
  CreateRaidItemInput,
  CreateRaidTaskInput,
  RaidItem,
  RaidKind,
  UpdateRaidItemInput,
} from '@weldsuite/app-api-client/domains/project-control';
import type { RaidCopy, Format } from './copy';
import { fromDateInput, toDateInput } from './raid';

// ── Error messages ──────────────────────────────────────────────────────────

/**
 * Turns Zod's issues into the messages of the user's language. The shared
 * schemas carry no messages of their own, so every rule they enforce ends up
 * here (and a rule added there falls back to "This value is not valid").
 */
export function raidErrorMap(copy: RaidCopy['validation'], format: Format): z.ZodErrorMap {
  return (issue, ctx) => {
    switch (issue.code) {
      case z.ZodIssueCode.invalid_type:
        if (issue.received === 'undefined' || issue.received === 'null') {
          return { message: issue.expected === 'number' ? copy.ratingRequired : copy.required };
        }
        if (issue.expected === 'integer') return { message: copy.invalidWholeNumber };
        if (issue.expected === 'number') return { message: copy.invalidNumber };
        return { message: copy.invalidValue };
      case z.ZodIssueCode.too_small:
        return { message: issue.type === 'string' ? copy.required : copy.invalidNumber };
      case z.ZodIssueCode.too_big:
        return { message: issue.type === 'string' ? format(copy.tooLong, { max: String(issue.maximum) }) : copy.invalidValue };
      case z.ZodIssueCode.invalid_enum_value:
        return { message: copy.required };
      case z.ZodIssueCode.invalid_string:
        return { message: issue.validation === 'datetime' ? copy.invalidDate : copy.invalidValue };
      case z.ZodIssueCode.custom: {
        const code = (issue.params as { code?: keyof RaidCopy['validation'] } | undefined)?.code;
        return { message: code ? copy[code] : ctx.defaultError };
      }
      default:
        return { message: ctx.defaultError };
    }
  };
}

/**
 * The `schemaOptions` of `zodResolver`: the error map above, in the full shape
 * the resolver's types ask for (`parseAsync` takes `path` and `async` from its
 * own context, so these two values change nothing).
 */
export function raidResolverOptions(copy: RaidCopy['validation'], format: Format) {
  return { errorMap: raidErrorMap(copy, format), path: [] as (string | number)[], async: true };
}

// ── Building blocks ─────────────────────────────────────────────────────────

const risk = createRiskSchema.shape;
const assumption = createAssumptionSchema.shape;
const issue = createIssueSchema.shape;
const dependency = createDependencySchema.shape;

/** A date input: empty, or `YYYY-MM-DD`. */
const dateInput = z.string().refine((value) => value === '' || fromDateInput(value) !== null, {
  params: { code: 'invalidDate' },
});

/** The statuses are free text in the form (the dialog offers the ones of the kind); the API checks them. */
const status = z.string().optional();

// ── Form schemas ────────────────────────────────────────────────────────────

export const riskFormSchema = z
  .object({
    title: risk.title,
    description: risk.description,
    category: risk.category,
    ownerId: risk.ownerId,
    probability: risk.probability,
    impact: risk.impact,
    residualProbability: risk.residualProbability,
    residualImpact: risk.residualImpact,
    strategy: risk.strategy,
    trigger: risk.trigger,
    costImpact: risk.costImpact,
    scheduleImpactDays: risk.scheduleImpactDays,
    dueDate: dateInput,
    status,
    /** Create only: the milestone the risk threatens. */
    milestoneId: z.string().nullable(),
    /** Create only: also create a mitigation task for the owner. */
    createTask: z.boolean(),
  })
  .superRefine((values, ctx) => {
    if ((values.residualProbability != null) !== (values.residualImpact != null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { code: 'residualPair' },
        path: [values.residualProbability != null ? 'residualImpact' : 'residualProbability'],
      });
    }
  });

export const assumptionFormSchema = z.object({
  title: assumption.title,
  description: assumption.description,
  ownerId: assumption.ownerId,
  confidence: assumption.confidence,
  ifWrong: assumption.ifWrong,
  dueDate: dateInput,
  status,
});

export const issueFormSchema = z.object({
  title: issue.title,
  description: issue.description,
  category: issue.category,
  ownerId: issue.ownerId,
  severity: issue.severity,
  escalated: z.boolean(),
  dueDate: dateInput,
  status,
});

export const dependencyFormSchema = z
  .object({
    title: dependency.title,
    description: dependency.description,
    ownerId: dependency.ownerId,
    direction: dependency.direction,
    partyType: dependency.partyType,
    partyProjectId: dependency.partyProjectId,
    partyName: dependency.partyName,
    dueDate: dateInput,
    status,
  })
  .superRefine((values, ctx) => {
    if (values.partyType === 'project' && !values.partyProjectId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, params: { code: 'partyProjectRequired' }, path: ['partyProjectId'] });
    }
  });

export type RiskFormValues = z.infer<typeof riskFormSchema>;
export type AssumptionFormValues = z.infer<typeof assumptionFormSchema>;
export type IssueFormValues = z.infer<typeof issueFormSchema>;
export type DependencyFormValues = z.infer<typeof dependencyFormSchema>;
export type RaidFormValues = RiskFormValues | AssumptionFormValues | IssueFormValues | DependencyFormValues;

// ── Defaults ────────────────────────────────────────────────────────────────

export function defaultRiskValues(ownerId: string | null = null): RiskFormValues {
  return {
    title: '',
    description: '',
    category: null,
    ownerId,
    probability: 3,
    impact: 3,
    residualProbability: null,
    residualImpact: null,
    strategy: 'mitigate',
    trigger: '',
    costImpact: null,
    scheduleImpactDays: null,
    dueDate: '',
    status: undefined,
    milestoneId: null,
    createTask: true,
  };
}

export function defaultAssumptionValues(ownerId: string | null = null): AssumptionFormValues {
  return { title: '', description: '', ownerId, confidence: 'medium', ifWrong: '', dueDate: '', status: undefined };
}

export function defaultIssueValues(ownerId: string | null = null): IssueFormValues {
  return { title: '', description: '', category: null, ownerId, severity: 'medium', escalated: false, dueDate: '', status: undefined };
}

export function defaultDependencyValues(ownerId: string | null = null): DependencyFormValues {
  return {
    title: '',
    description: '',
    ownerId,
    direction: 'inbound',
    partyType: null,
    partyProjectId: null,
    partyName: '',
    dueDate: '',
    status: undefined,
  };
}

/** The form values of an existing item. */
export function riskValuesFromItem(item: RaidItem): RiskFormValues {
  return {
    title: item.title,
    description: item.description ?? '',
    category: item.category,
    ownerId: item.ownerId,
    probability: item.probability ?? 3,
    impact: item.impact ?? 3,
    residualProbability: item.residualProbability,
    residualImpact: item.residualImpact,
    strategy: item.strategy as RiskFormValues['strategy'],
    trigger: item.trigger ?? '',
    costImpact: item.costImpact === null ? null : Number(item.costImpact),
    scheduleImpactDays: item.scheduleImpactDays,
    dueDate: toDateInput(item.dueAt),
    status: item.status,
    milestoneId: null,
    createTask: false,
  };
}

export function assumptionValuesFromItem(item: RaidItem): AssumptionFormValues {
  return {
    title: item.title,
    description: item.description ?? '',
    ownerId: item.ownerId,
    confidence: item.confidence as AssumptionFormValues['confidence'],
    ifWrong: item.ifWrong ?? '',
    dueDate: toDateInput(item.dueAt),
    status: item.status,
  };
}

export function issueValuesFromItem(item: RaidItem): IssueFormValues {
  return {
    title: item.title,
    description: item.description ?? '',
    category: item.category,
    ownerId: item.ownerId,
    severity: (item.severity ?? 'medium') as IssueFormValues['severity'],
    escalated: item.escalatedAt !== null,
    dueDate: toDateInput(item.dueAt),
    status: item.status,
  };
}

export function dependencyValuesFromItem(item: RaidItem): DependencyFormValues {
  return {
    title: item.title,
    description: item.description ?? '',
    ownerId: item.ownerId,
    direction: (item.direction ?? 'inbound') as DependencyFormValues['direction'],
    partyType: item.partyType as DependencyFormValues['partyType'],
    partyProjectId: item.partyProjectId,
    partyName: item.partyName ?? '',
    dueDate: toDateInput(item.dueAt),
    status: item.status,
  };
}

// ── Request bodies ──────────────────────────────────────────────────────────

/** Empty text is "not set": null, which clears the field on an edit. */
function textOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** The body of `POST /api/project-raid` for a risk, assumption, issue or dependency form. */
export function buildCreateBody(kind: RaidKind, projectId: string, values: RaidFormValues): unknown {
  const dueAt = fromDateInput((values as { dueDate: string }).dueDate);
  const common = {
    kind,
    projectId,
    title: values.title,
    description: textOrNull(values.description),
    ownerId: values.ownerId ?? null,
    dueAt,
  };
  switch (kind) {
    case 'risk': {
      const v = values as RiskFormValues;
      return {
        ...common,
        category: textOrNull(v.category),
        probability: v.probability,
        impact: v.impact,
        residualProbability: v.residualProbability ?? null,
        residualImpact: v.residualImpact ?? null,
        strategy: v.strategy ?? null,
        trigger: textOrNull(v.trigger),
        costImpact: v.costImpact ?? null,
        scheduleImpactDays: v.scheduleImpactDays ?? null,
      };
    }
    case 'assumption': {
      const v = values as AssumptionFormValues;
      return { ...common, confidence: v.confidence ?? null, ifWrong: textOrNull(v.ifWrong) };
    }
    case 'issue': {
      const v = values as IssueFormValues;
      return {
        ...common,
        category: textOrNull(v.category),
        severity: v.severity ?? 'medium',
        escalatedAt: v.escalated ? new Date().toISOString() : null,
      };
    }
    case 'dependency': {
      const v = values as DependencyFormValues;
      return {
        ...common,
        direction: v.direction,
        partyType: v.partyType ?? null,
        partyProjectId: v.partyType === 'project' ? (v.partyProjectId ?? null) : null,
        partyName: v.partyType === 'project' ? null : textOrNull(v.partyName),
      };
    }
  }
}

/** The create body, checked against the shared schema: the data, or null when it does not pass. */
export function parseCreateBody(body: unknown): CreateRaidItemInput | null {
  const parsed = createRaidItemSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/**
 * The body of `PATCH /api/project-raid/:id`: the editable fields of the item's
 * kind. A risk's probability and impact are not part of an edit (a new rating
 * is a reassessment); the status is sent only when it changed.
 */
export function buildUpdateBody(item: RaidItem, values: RaidFormValues): unknown {
  const dueAt = fromDateInput((values as { dueDate: string }).dueDate);
  const common = {
    title: values.title,
    description: textOrNull(values.description),
    ownerId: values.ownerId ?? null,
    dueAt,
    ...(values.status && values.status !== item.status ? { status: values.status } : {}),
  };
  switch (item.kind) {
    case 'risk': {
      const v = values as RiskFormValues;
      return {
        ...common,
        category: textOrNull(v.category),
        strategy: v.strategy ?? null,
        trigger: textOrNull(v.trigger),
        costImpact: v.costImpact ?? null,
        scheduleImpactDays: v.scheduleImpactDays ?? null,
      };
    }
    case 'assumption': {
      const v = values as AssumptionFormValues;
      return { ...common, confidence: v.confidence ?? null, ifWrong: textOrNull(v.ifWrong) };
    }
    case 'issue': {
      const v = values as IssueFormValues;
      return {
        ...common,
        category: textOrNull(v.category),
        severity: v.severity ?? 'medium',
        // Keep the time an issue was escalated; set it when switched on, clear it when switched off.
        ...(v.escalated === (item.escalatedAt !== null) ? {} : { escalatedAt: v.escalated ? new Date().toISOString() : null }),
      };
    }
    case 'dependency': {
      const v = values as DependencyFormValues;
      return {
        ...common,
        direction: v.direction,
        partyType: v.partyType ?? null,
        partyProjectId: v.partyType === 'project' ? (v.partyProjectId ?? null) : null,
        partyName: v.partyType === 'project' ? null : textOrNull(v.partyName),
      };
    }
  }
}

/** The update body, checked against the schema of the item's kind. */
export function parseUpdateBody(kind: RaidKind, body: unknown): UpdateRaidItemInput | null {
  const parsed = updateRaidItemSchemas[kind].safeParse(body);
  return parsed.success ? (parsed.data as UpdateRaidItemInput) : null;
}

// ── Assess ──────────────────────────────────────────────────────────────────

export const assessFormSchema = z
  .object({
    probability: assessRiskSchema.shape.probability,
    impact: assessRiskSchema.shape.impact,
    residualProbability: assessRiskSchema.shape.residualProbability,
    residualImpact: assessRiskSchema.shape.residualImpact,
    note: assessRiskSchema.shape.note,
    nextReviewDate: dateInput,
  })
  .superRefine((values, ctx) => {
    if ((values.residualProbability != null) !== (values.residualImpact != null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { code: 'residualPair' },
        path: [values.residualProbability != null ? 'residualImpact' : 'residualProbability'],
      });
    }
  });

export type AssessFormValues = z.infer<typeof assessFormSchema>;

export function assessValuesFromItem(item: RaidItem): AssessFormValues {
  return {
    probability: item.probability ?? 3,
    impact: item.impact ?? 3,
    residualProbability: item.residualProbability,
    residualImpact: item.residualImpact,
    note: '',
    nextReviewDate: '',
  };
}

export function buildAssessBody(values: AssessFormValues): AssessRiskInput | null {
  const nextReviewAt = fromDateInput(values.nextReviewDate);
  const parsed = assessRiskSchema.safeParse({
    probability: values.probability,
    impact: values.impact,
    residualProbability: values.residualProbability ?? null,
    residualImpact: values.residualImpact ?? null,
    note: textOrNull(values.note),
    ...(nextReviewAt ? { nextReviewAt } : {}),
  });
  return parsed.success ? parsed.data : null;
}

// ── Convert ─────────────────────────────────────────────────────────────────

export const convertFormSchema = z.object({
  title: convertRaidItemSchema.shape.title.unwrap(),
  /** Assumption to risk. */
  probability: convertRaidItemSchema.shape.probability.unwrap().nullable(),
  impact: convertRaidItemSchema.shape.impact.unwrap().nullable(),
  /** Risk to issue. */
  severity: convertRaidItemSchema.shape.severity.unwrap().nullable(),
  dueDate: dateInput,
});

export type ConvertFormValues = z.infer<typeof convertFormSchema>;

/** The convert form for a target kind: a new risk needs its probability and impact. */
export function convertFormSchemaFor(to: 'risk' | 'issue') {
  return convertFormSchema.superRefine((values, ctx) => {
    if (to !== 'risk') return;
    for (const field of ['probability', 'impact'] as const) {
      if (values[field] == null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, params: { code: 'ratingRequired' }, path: [field] });
      }
    }
  });
}

export function convertValuesFromItem(item: RaidItem): ConvertFormValues {
  return {
    title: item.title,
    probability: null,
    impact: null,
    severity: (item.band ?? 'medium') as ConvertFormValues['severity'],
    dueDate: '',
  };
}

export function buildConvertBody(to: 'risk' | 'issue', values: ConvertFormValues): ConvertRaidItemInput | null {
  const dueAt = fromDateInput(values.dueDate);
  // The route's own rule: a risk made from an assumption needs its rating, an issue takes none.
  if (to === 'risk' && (values.probability == null || values.impact == null)) return null;
  const parsed = convertRaidItemSchema.safeParse({
    to,
    title: values.title,
    ...(dueAt ? { dueAt } : {}),
    ...(to === 'risk'
      ? { probability: values.probability, impact: values.impact }
      : values.severity
        ? { severity: values.severity }
        : {}),
  });
  return parsed.success ? parsed.data : null;
}

// ── Mitigation and resolution tasks ─────────────────────────────────────────

export const raidTaskFormSchema = z.object({
  title: createRaidTaskSchema.shape.title,
  description: createRaidTaskSchema.shape.description,
  assigneeId: createRaidTaskSchema.shape.assigneeId,
  dueDate: dateInput,
  priority: createRaidTaskSchema.shape.priority,
});

export type RaidTaskFormValues = z.infer<typeof raidTaskFormSchema>;

export function buildRaidTaskBody(values: RaidTaskFormValues): CreateRaidTaskInput | null {
  const dueDate = fromDateInput(values.dueDate);
  const parsed = createRaidTaskSchema.safeParse({
    title: values.title,
    description: textOrNull(values.description),
    assigneeId: values.assigneeId ?? null,
    dueDate,
    priority: values.priority ?? undefined,
  });
  return parsed.success ? parsed.data : null;
}
