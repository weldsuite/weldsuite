/**
 * Pure helpers for the template gallery: what a template still needs set up
 * (from the API's `setupIssues`, which are the activation gate's issues), and
 * the icon a template shows.
 */

import {
  AlertTriangle,
  FileText,
  Mail,
  ShieldCheck,
  Sheet,
  Sparkles,
  Tags,
  Trophy,
  UserPlus,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import type { WorkflowTemplateItem, WorkflowTemplateSetupIssue } from '@weldsuite/app-api-client/schemas/weldconnect-templates';

/** Gate issues meaning "WeldConnect can't run this", as opposed to "fill this in". */
const UNAVAILABLE_CODES = new Set(['unsupported_action', 'unsupported_trigger']);

export type TemplatePartState = 'ready' | 'setup' | 'unavailable';

function issuesFor(template: Pick<WorkflowTemplateItem, 'setupIssues'>, match: (issue: WorkflowTemplateSetupIssue) => boolean) {
  return template.setupIssues.filter(match);
}

function stateOf(issues: WorkflowTemplateSetupIssue[]): TemplatePartState {
  if (issues.some((issue) => UNAVAILABLE_CODES.has(issue.code))) return 'unavailable';
  return issues.length > 0 ? 'setup' : 'ready';
}

/** Whether a step can run as is, needs filling in, or can't run in WeldConnect at all. */
export function stepState(template: Pick<WorkflowTemplateItem, 'setupIssues'>, stepId: string): TemplatePartState {
  return stateOf(issuesFor(template, (issue) => issue.stepId === stepId));
}

/** Same for the trigger(s): any issue that names a trigger, or names no step at all (e.g. `no_trigger`). */
export function triggerState(template: Pick<WorkflowTemplateItem, 'setupIssues'>): TemplatePartState {
  return stateOf(issuesFor(template, (issue) => !issue.stepId && issue.code !== 'no_steps'));
}

/** How many steps (and the trigger) still need something filled in. */
export function setupCount(template: Pick<WorkflowTemplateItem, 'setupIssues'>): number {
  const parts = new Set(
    template.setupIssues
      .filter((issue) => !UNAVAILABLE_CODES.has(issue.code))
      .map((issue) => (issue.stepId ? `step:${issue.stepId}` : 'trigger')),
  );
  return parts.size;
}

export function hasUnavailableParts(template: Pick<WorkflowTemplateItem, 'setupIssues'>): boolean {
  return template.setupIssues.some((issue) => UNAVAILABLE_CODES.has(issue.code));
}

const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  AlertTriangle,
  Mail,
  ShieldCheck,
  Sheet,
  Sparkles,
  Tags,
  Trophy,
  UserPlus,
  Webhook,
};

export function templateIcon(name: string | null | undefined): LucideIcon {
  return (name && TEMPLATE_ICONS[name]) || FileText;
}
