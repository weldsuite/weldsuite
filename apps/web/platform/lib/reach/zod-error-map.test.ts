import { describe, expect, it } from 'vitest';
import { appAccessRequestInputSchema, createReachMailboxSchema } from '@weldsuite/app-api-client/schemas/reach';
import { createReachSchemaOptions } from './zod-error-map';

// Echo the key and its parameters so the test shows which message was picked.
const t = (path: string, params?: Record<string, unknown>) => (params ? `${path}:${JSON.stringify(params)}` : path);

function messages(schema: typeof createReachMailboxSchema | typeof appAccessRequestInputSchema, input: unknown) {
  const result = schema.safeParse(input, createReachSchemaOptions(t));
  if (result.success) return {} as Record<string, string>;
  return Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.'), issue.message]));
}

describe('createReachSchemaOptions', () => {
  it('translates required and blank strings', () => {
    const issues = messages(createReachMailboxSchema, {
      domainId: '',
      localPart: '',
      firstName: '  ',
      lastName: 'x',
      type: 'shared',
    });
    expect(issues.domainId).toBe('reach.validation.required');
    expect(issues.firstName).toBe('reach.validation.required');
  });

  it('translates a missing field as required, not as an invalid type', () => {
    const issues = messages(createReachMailboxSchema, { domainId: 'd1', lastName: 'x', type: 'shared' });
    expect(issues.firstName).toBe('reach.validation.required');
    expect(issues.localPart).toBe('reach.validation.required');
  });

  it('translates email, length, number and array checks', () => {
    const issues = messages(appAccessRequestInputSchema, {
      companyName: 'Acme',
      website: 'acme.com',
      contactName: 'Anna',
      contactEmail: 'not-an-email',
      useCase: 'too short',
      expectedDailySends: Number.NaN,
      targetCountries: [],
      listSource: 'own_research',
      termsVersion: 'v',
      termsAccepted: [],
    });
    expect(issues.contactEmail).toBe('reach.validation.invalidEmail');
    expect(issues.useCase).toBe('reach.validation.tooShort:{"min":10}');
    expect(issues.expectedDailySends).toBe('reach.validation.required');
    expect(issues.targetCountries).toBe('reach.validation.selectAtLeast:{"min":1}');
  });

  it('keeps a message written into the schema itself', () => {
    const issues = messages(createReachMailboxSchema, {
      domainId: 'd1',
      localPart: 'bad address!',
      firstName: 'A',
      lastName: 'B',
      type: 'shared',
    });
    expect(issues.localPart).toBe('Letters, digits, dots, dashes and underscores only');
  });
});
