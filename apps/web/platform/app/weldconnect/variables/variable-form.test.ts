import { describe, expect, it } from 'vitest';
import { buildVariableCreateBody, buildVariableUpdateBody, getVariableFormError, type VariableFormFields } from './variable-form';

const messages = {
  nameRequired: 'nameRequired',
  nameInvalid: 'nameInvalid',
  valueRequired: 'valueRequired',
  valuesMismatch: 'valuesMismatch',
  workflowRequired: 'workflowRequired',
  updateRequiresChange: 'updateRequiresChange',
};

const form = (overrides: Partial<VariableFormFields> = {}): VariableFormFields => ({
  name: 'api_key',
  value: 'abc',
  confirmValue: '',
  description: '',
  isSecret: false,
  scope: 'global',
  workflowId: '',
  ...overrides,
});

describe('getVariableFormError (create)', () => {
  it('accepts a valid global variable', () => {
    expect(getVariableFormError('create', form(), messages)).toBeNull();
  });

  it('rejects names {{variables.<name>}} cannot reach', () => {
    expect(getVariableFormError('create', form({ name: '' }), messages)).toBe('nameRequired');
    expect(getVariableFormError('create', form({ name: 'api key' }), messages)).toBe('nameInvalid');
    expect(getVariableFormError('create', form({ name: '9lives' }), messages)).toBe('nameInvalid');
    expect(getVariableFormError('create', form({ name: 'api-key' }), messages)).toBe('nameInvalid');
  });

  it('needs a workflow for workflow scope', () => {
    expect(getVariableFormError('create', form({ scope: 'workflow' }), messages)).toBe('workflowRequired');
    expect(getVariableFormError('create', form({ scope: 'workflow', workflowId: 'wf_1' }), messages)).toBeNull();
  });

  it('needs a value, confirmed for secrets', () => {
    expect(getVariableFormError('create', form({ value: '  ' }), messages)).toBe('valueRequired');
    expect(getVariableFormError('create', form({ isSecret: true, confirmValue: 'abd' }), messages)).toBe('valuesMismatch');
    expect(getVariableFormError('create', form({ isSecret: true, confirmValue: 'abc' }), messages)).toBeNull();
  });
});

describe('getVariableFormError (edit)', () => {
  it('needs a new value or a description', () => {
    expect(getVariableFormError('edit', form({ value: '', description: '' }), messages)).toBe('updateRequiresChange');
    expect(getVariableFormError('edit', form({ value: '', description: 'x' }), messages)).toBeNull();
  });
});

describe('buildVariableCreateBody', () => {
  it('sends an explicit scope and only a workflowId for workflow scope', () => {
    expect(buildVariableCreateBody(form({ name: ' api_key ', workflowId: 'wf_stale' }))).toEqual({
      name: 'api_key',
      value: 'abc',
      description: undefined,
      isSecret: false,
      scope: 'global',
      workflowId: undefined,
    });
    expect(buildVariableCreateBody(form({ scope: 'workflow', workflowId: 'wf_1' }))).toMatchObject({
      scope: 'workflow',
      workflowId: 'wf_1',
    });
  });
});

describe('buildVariableUpdateBody', () => {
  it('leaves out empty fields so the stored value is kept', () => {
    expect(buildVariableUpdateBody('', 'new description')).toEqual({ description: 'new description' });
    expect(buildVariableUpdateBody('new', '')).toEqual({ value: 'new' });
  });
});
