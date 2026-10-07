/**
 * The built-in starter templates may only use what WeldConnect can run today:
 * every one of them, in every language, passes the activation gate
 * (`validateWeldConnectWorkflow`) except for the fields it declares in
 * `setup` — the channel, project, recipient, … that only the workspace can
 * fill in. A template with an unsupported step, an unknown entity event, a
 * broken branch or a forgotten required field fails here.
 */

import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_TEMPLATE_ID_PREFIX,
  BUILT_IN_WORKFLOW_TEMPLATES,
  fillPlaceholders,
  resolveBuiltInTemplate,
  type BuiltInTemplateCatalog,
  type ResolvedBuiltInTemplate,
  type TemplateSetupField,
} from '@weldsuite/app-api-client/schemas/weldconnect-templates';
import { weldconnectTemplates as en } from '@weldsuite/i18n/locales/en/weldconnect-templates';
import { weldconnectTemplates as nl } from '@weldsuite/i18n/locales/nl/weldconnect-templates';
import { validateWeldConnectWorkflow, type WorkflowIssue } from './weldconnect-mvp';

const CATALOGS: Record<string, BuiltInTemplateCatalog> = { en, nl };

function isDeclaredSetup(issue: WorkflowIssue, setup: readonly TemplateSetupField[]): boolean {
  return setup.some((field) => {
    if (field.stepId) return issue.code === 'missing_field' && issue.stepId === field.stepId && issue.field === field.field;
    if (field.triggerId && field.field === 'sourceWorkflowId') {
      return issue.code === 'missing_source_workflow' && issue.triggerId === field.triggerId;
    }
    return false;
  });
}

function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => allStrings(item, out));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      allStrings(item, out);
    }
  }
  return out;
}

/** A `{word}` placeholder that was not filled in (`{{variables}}` are fine). */
const LEFTOVER_PLACEHOLDER = /(^|[^{])\{\w+\}(?!\})/;

const resolved: Array<[string, ResolvedBuiltInTemplate]> = Object.entries(CATALOGS).flatMap(([locale, catalog]) =>
  BUILT_IN_WORKFLOW_TEMPLATES.map((definition): [string, ResolvedBuiltInTemplate] => [
    `${locale}:${definition.id}`,
    resolveBuiltInTemplate(definition, catalog, en),
  ]),
);

describe('built-in workflow templates', () => {
  it('ships a starter set of 6 to 10 templates with unique, storable ids', () => {
    expect(BUILT_IN_WORKFLOW_TEMPLATES.length).toBeGreaterThanOrEqual(6);
    expect(BUILT_IN_WORKFLOW_TEMPLATES.length).toBeLessThanOrEqual(10);
    const ids = BUILT_IN_WORKFLOW_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(BUILT_IN_WORKFLOW_TEMPLATES.map((t) => t.key)).size).toBe(ids.length);
    for (const id of ids) {
      expect(id.startsWith(BUILT_IN_TEMPLATE_ID_PREFIX)).toBe(true);
      // workflows.template_id is varchar(30).
      expect(id.length).toBeLessThanOrEqual(30);
    }
  });

  it.each(resolved)('%s passes the activation gate apart from its declared setup fields', (_label, template) => {
    const issues = validateWeldConnectWorkflow(template);
    expect(issues.filter((issue) => !isDeclaredSetup(issue, template.setup))).toEqual([]);
  });

  it.each(resolved)('%s leaves exactly its declared setup fields blank', (_label, template) => {
    const issues = validateWeldConnectWorkflow(template);
    for (const field of template.setup) {
      expect(issues.some((issue) => isDeclaredSetup(issue, [field]))).toBe(true);
    }
  });

  it.each(resolved)('%s is complete: names, unique step ids, no unfilled placeholders', (_label, template) => {
    expect(template.name.trim()).not.toBe('');
    expect(template.description.trim()).not.toBe('');
    const stepIds = template.steps.map((step) => step.id);
    expect(new Set(stepIds).size).toBe(stepIds.length);
    for (const step of template.steps) expect(step.name?.trim()).toBeTruthy();
    for (const trigger of template.triggers) expect(trigger.id.length).toBeLessThanOrEqual(30);
    for (const text of allStrings({ triggers: template.triggers, steps: template.steps })) {
      expect(text).not.toContain('undefined');
      expect(text).not.toMatch(LEFTOVER_PLACEHOLDER);
    }
  });

  it('has every English string translated to Dutch, with the same placeholders', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, strings] of Object.entries(en)) {
      const dutch = nl[key as keyof typeof nl];
      expect(dutch, key).toBeDefined();
      expect(Object.keys(dutch.steps).sort(), `${key}.steps`).toEqual(Object.keys(strings.steps).sort());
      expect(Object.keys(dutch.text).sort(), `${key}.text`).toEqual(Object.keys(strings.text).sort());
      for (const [textKey, text] of Object.entries(strings.text)) {
        expect(placeholders(dutch.text[textKey as keyof typeof dutch.text]), `${key}.text.${textKey}`).toEqual(placeholders(text));
      }
    }
  });

  it('falls back to English for a string a locale lacks', () => {
    const definition = BUILT_IN_WORKFLOW_TEMPLATES[0];
    const partial = {
      ...nl,
      [definition.key]: { ...nl[definition.key], steps: {}, text: {} },
    } as BuiltInTemplateCatalog;
    const template = resolveBuiltInTemplate(definition, partial, en);
    expect(template.name).toBe(nl[definition.key].name);
    expect(template.steps[0].name).toBe(Object.values(en[definition.key].steps)[0]);
  });
});

describe('fillPlaceholders', () => {
  it('fills single-brace placeholders and leaves workflow variables alone', () => {
    expect(fillPlaceholders('Hi {name}, see {{steps.a.url}} and {missing}', { name: '{{trigger.record.fullName}}' })).toBe(
      'Hi {{trigger.record.fullName}}, see {{steps.a.url}} and {missing}',
    );
  });
});
