import { describe, expect, it } from 'vitest';
import type { SignRecipientDto } from '@weldsuite/app-api-client/schemas/weldsign';
import { buildUseTemplateInput, canUseTemplate, needsAccessCode, recipientDefaults } from './use-template';

const role = (overrides: Partial<SignRecipientDto>) =>
  ({ id: 'sgr_1', role: 'signer', name: null, email: null, authMode: 'link', ...overrides }) as SignRecipientDto;

describe('needsAccessCode', () => {
  it('is true for a signing role protected with an access code', () => {
    expect(needsAccessCode(role({ authMode: 'access_code' }))).toBe(true);
    // A copy role signs nothing: the server opens it by link alone and asks no code.
    expect(needsAccessCode(role({ role: 'cc', authMode: 'access_code' }))).toBe(false);
    expect(needsAccessCode(role({ authMode: 'email_code' }))).toBe(false);
    expect(needsAccessCode(role({ authMode: 'link' }))).toBe(false);
  });
});

describe('recipientDefaults', () => {
  it("starts from the role's usual person", () => {
    expect(recipientDefaults(role({ id: 'sgr_9', name: 'Ann', email: 'ann@example.com' }))).toEqual({
      roleId: 'sgr_9',
      name: 'Ann',
      email: 'ann@example.com',
      accessCode: undefined,
    });
  });

  it('leaves the fields empty when the role has no usual person, with an empty code box where one is needed', () => {
    expect(recipientDefaults(role({ authMode: 'access_code' }))).toEqual({ roleId: 'sgr_1', name: '', email: '', accessCode: '' });
  });
});

describe('buildUseTemplateInput', () => {
  const template = {
    title: 'Service agreement',
    message: 'Please sign.',
    recipientList: [role({ id: 'sgr_1', authMode: 'access_code' }), role({ id: 'sgr_2' })],
  };
  const recipients = [
    { roleId: 'sgr_1', name: 'Ann', email: 'ann@example.com', accessCode: '4821' },
    { roleId: 'sgr_2', name: 'Bob', email: 'bob@example.com', accessCode: 'ignored' },
  ];

  it('leaves the title and message to the template when they are unchanged', () => {
    const input = buildUseTemplateInput({ title: 'Service agreement', message: 'Please sign.', recipients }, template);
    expect(input.title).toBeUndefined();
    expect(input.message).toBeUndefined();
  });

  it('sends a changed title and message', () => {
    const input = buildUseTemplateInput({ title: ' Agreement for Acme ', message: 'Hello', recipients }, template);
    expect(input.title).toBe('Agreement for Acme');
    expect(input.message).toBe('Hello');
  });

  it('sends a cleared message as null, but not a message that was never there', () => {
    expect(buildUseTemplateInput({ title: 'Service agreement', message: '', recipients }, template).message).toBeNull();
    expect(buildUseTemplateInput({ title: 'Service agreement', message: '', recipients }, { ...template, message: null }).message).toBeUndefined();
  });

  it('sends the access code only for a role that needs one', () => {
    const input = buildUseTemplateInput({ title: 'Service agreement', recipients }, template);
    expect(input.recipients).toEqual([
      { roleId: 'sgr_1', name: 'Ann', email: 'ann@example.com', accessCode: '4821' },
      { roleId: 'sgr_2', name: 'Bob', email: 'bob@example.com', accessCode: undefined },
    ]);
  });
});

describe('canUseTemplate', () => {
  it('needs a document and a role: the server refuses a template without either', () => {
    expect(canUseTemplate({ documentCount: 1, roles: [{}] })).toBe(true);
    expect(canUseTemplate({ documentCount: 0, roles: [{}] })).toBe(false);
    expect(canUseTemplate({ documentCount: 1, roles: [] })).toBe(false);
  });
});
