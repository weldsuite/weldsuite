import { describe, expect, it } from 'vitest';
import {
  buildVariableCreateBody,
  buildVariableUpdateBody,
  getVariableFormErrors,
  variableValueToFormText,
  type VariableFormFields,
  type VariableFormInitial,
} from './variable-form';

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

describe('getVariableFormErrors (create)', () => {
  it('accepts a valid global variable', () => {
    expect(getVariableFormErrors('create', form(), messages)).toEqual({});
  });

  it('puts name problems on the name field', () => {
    expect(getVariableFormErrors('create', form({ name: '' }), messages).name).toBe('nameRequired');
    expect(getVariableFormErrors('create', form({ name: 'api key' }), messages).name).toBe('nameInvalid');
    expect(getVariableFormErrors('create', form({ name: '9lives' }), messages).name).toBe('nameInvalid');
    expect(getVariableFormErrors('create', form({ name: 'api-key' }), messages).name).toBe('nameInvalid');
  });

  it('needs a workflow for workflow scope', () => {
    expect(getVariableFormErrors('create', form({ scope: 'workflow' }), messages).workflowId).toBe('workflowRequired');
    expect(getVariableFormErrors('create', form({ scope: 'workflow', workflowId: 'wf_1' }), messages)).toEqual({});
  });

  it('needs a value, confirmed for secrets', () => {
    expect(getVariableFormErrors('create', form({ value: '  ' }), messages).value).toBe('valueRequired');
    expect(getVariableFormErrors('create', form({ isSecret: true, confirmValue: 'abd' }), messages).confirmValue).toBe('valuesMismatch');
    expect(getVariableFormErrors('create', form({ isSecret: true, confirmValue: 'abc' }), messages)).toEqual({});
  });

  it('reports every field at once', () => {
    expect(getVariableFormErrors('create', form({ name: '', value: '' }), messages)).toEqual({
      name: 'nameRequired',
      value: 'valueRequired',
    });
  });
});

const initial = (overrides: Partial<VariableFormInitial> = {}): VariableFormInitial => ({
  name: 'api_key',
  value: 'abc',
  description: '',
  isSecret: false,
  ...overrides,
});

describe('getVariableFormErrors (edit)', () => {
  it('flags an edit that changes nothing', () => {
    expect(getVariableFormErrors('edit', form(), messages, initial()).form).toBe('updateRequiresChange');
  });

  it('accepts a changed name, value or description', () => {
    expect(getVariableFormErrors('edit', form({ name: 'renamed' }), messages, initial())).toEqual({});
    expect(getVariableFormErrors('edit', form({ value: 'new' }), messages, initial())).toEqual({});
    expect(getVariableFormErrors('edit', form({ description: 'x' }), messages, initial())).toEqual({});
  });

  it('validates the name on rename, inline', () => {
    expect(getVariableFormErrors('edit', form({ name: 'bad name' }), messages, initial()).name).toBe('nameInvalid');
    expect(getVariableFormErrors('edit', form({ name: '' }), messages, initial()).name).toBe('nameRequired');
  });

  it('does not let a plain value be emptied', () => {
    expect(getVariableFormErrors('edit', form({ value: '' }), messages, initial()).value).toBe('valueRequired');
  });

  it('keeps a secret as is when its value is left blank', () => {
    const secret = initial({ isSecret: true, value: '' });
    expect(getVariableFormErrors('edit', form({ isSecret: true, value: '' }), messages, secret).form).toBe('updateRequiresChange');
    expect(getVariableFormErrors('edit', form({ isSecret: true, value: '', description: 'd' }), messages, secret)).toEqual({});
    expect(getVariableFormErrors('edit', form({ isSecret: true, value: 'new' }), messages, secret)).toEqual({});
  });
});

describe('variableValueToFormText', () => {
  it('pre-fills plain values and never a secret', () => {
    expect(variableValueToFormText('https://e2e-test.invalid', false)).toBe('https://e2e-test.invalid');
    expect(variableValueToFormText(42, false)).toBe('42');
    expect(variableValueToFormText(true, false)).toBe('true');
    expect(variableValueToFormText({ a: 1 }, false)).toBe('{"a":1}');
    expect(variableValueToFormText(null, false)).toBe('');
    expect(variableValueToFormText('********', true)).toBe('');
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
  it('sends only what changed', () => {
    expect(buildVariableUpdateBody(form({ description: 'new description' }), initial())).toEqual({ description: 'new description' });
    expect(buildVariableUpdateBody(form({ value: 'new' }), initial())).toEqual({ value: 'new' });
    expect(buildVariableUpdateBody(form({ name: ' renamed ' }), initial())).toEqual({ name: 'renamed' });
    expect(buildVariableUpdateBody(form(), initial())).toEqual({});
  });

  it('can clear a description', () => {
    expect(buildVariableUpdateBody(form({ description: '' }), initial({ description: 'old' }))).toEqual({ description: '' });
  });

  it('never sends a secret value unless a new one was typed', () => {
    const secret = initial({ isSecret: true, value: '' });
    expect(buildVariableUpdateBody(form({ isSecret: true, value: '' }), secret)).toEqual({});
    expect(buildVariableUpdateBody(form({ isSecret: true, value: 'new' }), secret)).toEqual({ value: 'new' });
  });
});
