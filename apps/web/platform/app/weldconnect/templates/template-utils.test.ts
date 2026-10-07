import { describe, expect, it } from 'vitest';
import { FileText, Trophy } from 'lucide-react';
import {
  BUILT_IN_WORKFLOW_TEMPLATES,
  resolveBuiltInTemplate,
  type WorkflowTemplateSetupIssue,
} from '@weldsuite/app-api-client/schemas/weldconnect-templates';
import { weldconnectTemplates as en } from '@weldsuite/i18n/locales/en/weldconnect-templates';
import { findUnknownVariables, isInsideLoop } from '@/components/workflow-editor/lib/step-issues';
import { getRecordFields } from '../record-fields';
import { hasUnavailableParts, setupCount, stepState, templateIcon, triggerState } from './template-utils';
import { templateToFlowData } from './components/template-preview';

const withIssues = (setupIssues: WorkflowTemplateSetupIssue[]) => ({ setupIssues });

describe('template setup state', () => {
  const template = withIssues([
    { code: 'missing_field', stepId: 'a', field: 'channelId' },
    { code: 'missing_field', stepId: 'a', field: 'message' },
    { code: 'unsupported_action', stepId: 'b', type: 'query_data' },
    { code: 'missing_source_workflow', triggerId: 't' },
  ]);

  it('marks each step as ready, needing setup, or unavailable', () => {
    expect(stepState(template, 'a')).toBe('setup');
    expect(stepState(template, 'b')).toBe('unavailable');
    expect(stepState(template, 'c')).toBe('ready');
    expect(triggerState(template)).toBe('setup');
    expect(triggerState(withIssues([]))).toBe('ready');
  });

  it('counts the steps and the trigger still to fill in, not the unavailable ones', () => {
    expect(setupCount(template)).toBe(2);
    expect(setupCount(withIssues([]))).toBe(0);
    expect(hasUnavailableParts(template)).toBe(true);
    expect(hasUnavailableParts(withIssues([{ code: 'missing_field', stepId: 'a' }]))).toBe(false);
  });

  it('maps icon names to icons, with a fallback', () => {
    expect(templateIcon('Trophy')).toBe(Trophy);
    expect(templateIcon('NoSuchIcon')).toBe(FileText);
    expect(templateIcon(null)).toBe(FileText);
  });
});

describe('templateToFlowData', () => {
  it('moves flat trigger settings under config and keeps branch steps under their branch', () => {
    const { trigger, steps } = templateToFlowData(
      [{ id: 'trigger_main', type: 'entity_event', isEnabled: true, entityType: 'lead', eventType: 'created' }],
      [
        { id: 's1', type: 'condition', name: 'Check', config: {}, order: 0 },
        { id: 's2', type: 'send_notification', name: 'Notify', config: { title: 'x' }, order: 1, parentBranchId: 's1_if' },
      ],
    );
    expect(trigger).toMatchObject({
      id: 'trigger_main',
      type: 'entity_event',
      isEnabled: true,
      config: { type: 'entity_event', entityType: 'lead', eventType: 'created' },
    });
    expect(steps[1]).toMatchObject({ id: 's2', parentBranchId: 's1_if', inputs: {} });
    expect(templateToFlowData([], []).trigger).toBeNull();
  });
});

// The editor flags `{{variables}}` that resolve to nothing (flagUnknownVariables):
// a starter template must not open with such warnings.
describe('built-in templates in the editor', () => {
  it.each(BUILT_IN_WORKFLOW_TEMPLATES.map((definition) => [definition.id, definition] as const))(
    '%s only uses variables the editor knows',
    (_id, definition) => {
      const template = resolveBuiltInTemplate(definition, en);
      const trigger = template.triggers[0];
      const recordFields =
        trigger.type === 'entity_event'
          ? getRecordFields(String(trigger.entityType), String(trigger.eventType))?.map((field) => field.path)
          : undefined;
      template.steps.forEach((step, index) => {
        const unknown = findUnknownVariables(step.config, {
          triggerType: trigger.type,
          recordFields,
          previousStepIds: template.steps.slice(0, index).map((s) => s.id),
          variableNames: [],
          inLoop: isInsideLoop(step, template.steps),
        });
        expect(unknown, `${definition.id} / ${step.id}`).toEqual([]);
      });
    },
  );
});
