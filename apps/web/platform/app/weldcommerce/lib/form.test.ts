import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createCommerceErrorMap,
  currencyInput,
  isPortalColor,
  isPortalLogoUrl,
  optionalNumber,
  optionalText,
} from './form';

function messages(schema: z.ZodTypeAny, value: unknown): string[] {
  const result = schema.safeParse(value, { errorMap: createCommerceErrorMap() });
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('commerce form inputs', () => {
  it('reads a blank input as "not given", not "" or NaN', () => {
    expect(optionalText.setValueAs('')).toBeUndefined();
    expect(optionalText.setValueAs('  ')).toBeUndefined();
    expect(optionalText.setValueAs('SKU-1')).toBe('SKU-1');
    expect(optionalNumber.setValueAs('')).toBeUndefined();
    expect(optionalNumber.setValueAs('12.5')).toBe(12.5);
    expect(currencyInput.setValueAs(' eur ')).toBe('EUR');
    expect(currencyInput.setValueAs('')).toBeUndefined();
  });
});

describe('createCommerceErrorMap', () => {
  it('says what to do in the UI language instead of Zod English', () => {
    expect(messages(z.object({ name: z.string().min(1) }), { name: '' })).toEqual(['Fill in this field.']);
    expect(messages(z.object({ name: z.string().max(3) }), { name: 'abcd' })).toEqual(['Use at most 3 characters.']);
    expect(messages(z.object({ price: z.number().min(0) }), { price: -1 })).toEqual(['Enter 0 or more.']);
    expect(messages(z.object({ n: z.number().int() }), { n: 1.5 })).toEqual(['Enter a whole number.']);
    expect(messages(z.object({ n: z.number() }), { n: undefined })).toEqual(['Fill in this field.']);
    expect(messages(z.object({ code: z.string().length(3) }), { code: 'EURO' })).toEqual(['Use exactly 3 characters.']);
    expect(messages(z.object({ email: z.string().email() }), { email: 'nope' })).toEqual(['Enter a valid email address.']);
  });

  it('keeps a message the schema wrote itself', () => {
    const schema = z.string().refine(() => false, { message: 'Own message' });
    expect(messages(schema, 'x')).toEqual(['Own message']);
  });
});

describe('portal settings checks', () => {
  it('takes an http(s) logo address or nothing', () => {
    expect(isPortalLogoUrl('')).toBe(true);
    expect(isPortalLogoUrl('https://cdn.example.com/logo.png')).toBe(true);
    expect(isPortalLogoUrl('not a url')).toBe(false);
    expect(isPortalLogoUrl('javascript:alert(1)')).toBe(false);
  });

  it('takes a hex color or nothing', () => {
    expect(isPortalColor('')).toBe(true);
    expect(isPortalColor('#1a73e8')).toBe(true);
    expect(isPortalColor('#FFF')).toBe(true);
    expect(isPortalColor('notacolor')).toBe(false);
    expect(isPortalColor('#12345')).toBe(false);
  });
});
