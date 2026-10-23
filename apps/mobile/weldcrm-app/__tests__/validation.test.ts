import { parseDateInput } from '@/lib/dates';
import { en } from '@/lib/i18n/locales/en';
import { nl } from '@/lib/i18n/locales/nl';
import {
  checkOptionalAmount,
  checkOptionalEmail,
  checkRequired,
  checkRequiredEmail,
  describeError,
  isValidEmail,
  optionalText,
  parseAmountInput,
  validateActivity,
  validateCompany,
  validateDeal,
  checkEmployeeCount,
  checkWebsite,
  validatePerson,
  validateTask,
} from '@/lib/validation';

describe('email checks', () => {
  it('accepts normal addresses and rejects malformed ones', () => {
    expect(isValidEmail('jane@acme.com')).toBe(true);
    expect(isValidEmail(' jane@acme.com ')).toBe(true);
    expect(isValidEmail('jane@acme')).toBe(false);
    expect(isValidEmail('jane acme.com')).toBe(false);
  });

  it('rejects the edge cases a pattern would be tempted to let through', () => {
    expect(isValidEmail('@acme.com')).toBe(false);
    expect(isValidEmail('jane@.com')).toBe(false);
    expect(isValidEmail('jane@acme.c')).toBe(false);
    expect(isValidEmail('jane@@acme.com')).toBe(false);
    expect(isValidEmail('jane@acme .com')).toBe(false);
    expect(isValidEmail('jane@mail.acme.co')).toBe(true);
  });

  it('answers a long pathological input straight away', () => {
    const started = Date.now();
    expect(isValidEmail(`${'a'.repeat(50_000)}@${'b.'.repeat(50_000)}`)).toBe(true);
    expect(isValidEmail(`${'a'.repeat(50_000)}@${'b'.repeat(50_000)}`)).toBe(false);
    expect(isValidEmail(`a@${'b.'.repeat(25_000)} ${'b.'.repeat(25_000)}`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('required email is required and must be valid', () => {
    expect(checkRequiredEmail('')).toBe('required');
    expect(checkRequiredEmail('nope')).toBe('invalidEmail');
    expect(checkRequiredEmail('a@b.co')).toBeNull();
  });

  it('optional email is only checked when filled in', () => {
    expect(checkOptionalEmail('')).toBeNull();
    expect(checkOptionalEmail('nope')).toBe('invalidEmail');
  });
});

describe('field checks', () => {
  it('required rejects blank and whitespace', () => {
    expect(checkRequired('')).toBe('required');
    expect(checkRequired('   ')).toBe('required');
    expect(checkRequired('x')).toBeNull();
  });

  it('amounts accept comma or point and reject negatives and text', () => {
    expect(checkOptionalAmount('')).toBeNull();
    expect(checkOptionalAmount('50,5')).toBeNull();
    expect(checkOptionalAmount('-1')).toBe('invalidNumber');
    expect(checkOptionalAmount('abc')).toBe('invalidNumber');
    expect(parseAmountInput('1250,75')).toBe(1250.75);
    expect(parseAmountInput('')).toBeUndefined();
  });

  it('optionalText drops empty strings', () => {
    expect(optionalText('  ')).toBeUndefined();
    expect(optionalText(' hi ')).toBe('hi');
  });
});

describe('whole-form validation', () => {
  it('a person needs a first or last name', () => {
    expect(validatePerson({ firstName: '', lastName: '', email: '' })).toEqual({ firstName: 'required' });
    expect(validatePerson({ firstName: '', lastName: 'Doe', email: '' })).toEqual({});
    expect(validatePerson({ firstName: 'Jane', lastName: '', email: 'bad' })).toEqual({ email: 'invalidEmail' });
  });

  it('a company needs a name', () => {
    expect(validateCompany({ name: ' ', email: '' })).toEqual({ name: 'required' });
    expect(validateCompany({ name: 'Acme', email: 'info@acme.com' })).toEqual({});
  });

  it('checks a website the way the API does', () => {
    expect(checkWebsite('')).toBeNull();
    expect(checkWebsite('acme.com')).toBeNull();
    expect(checkWebsite('https://www.acme.co.uk/about')).toBeNull();
    expect(checkWebsite('not a url')).toBe('invalidUrl');
    expect(checkWebsite('localhost')).toBe('invalidUrl');
  });

  it('accepts an employee count or range', () => {
    expect(checkEmployeeCount('')).toBeNull();
    expect(checkEmployeeCount('42')).toBeNull();
    expect(checkEmployeeCount('11-50')).toBeNull();
    expect(checkEmployeeCount('10001+')).toBeNull();
    expect(checkEmployeeCount('about 50')).toBe('invalidEmployees');
  });

  it('a task needs a title and a real due date when one is typed', () => {
    expect(validateTask({ title: '', dueDate: '' }, parseDateInput)).toEqual({ title: 'required' });
    expect(validateTask({ title: 'Call', dueDate: '31/12/2026' }, parseDateInput)).toEqual({ dueDate: 'invalidDate' });
    expect(validateTask({ title: 'Call', dueDate: '2026-12-31' }, parseDateInput)).toEqual({});
  });

  it('a deal needs a name; value and close date are optional but checked', () => {
    expect(validateDeal({ name: '', value: '', closeDate: '' }, parseDateInput)).toEqual({ name: 'required' });
    expect(validateDeal({ name: 'Q4', value: 'x', closeDate: '2026-02-30' }, parseDateInput)).toEqual({
      value: 'invalidNumber',
      closeDate: 'invalidDate',
    });
  });

  it('an activity needs a subject', () => {
    expect(validateActivity({ subject: '' })).toEqual({ subject: 'required' });
  });
});

describe('describeError', () => {
  it('says "X is required" in the user language', () => {
    expect(describeError(en, 'required', 'First name')).toBe('First name is required');
    expect(describeError(nl, 'required', 'Voornaam')).toBe('Voornaam is verplicht');
  });

  it('uses the fixed message for the other errors', () => {
    expect(describeError(en, 'invalidEmail', 'Email')).toBe(en.validation.invalidEmail);
    expect(describeError(nl, 'invalidDate', 'Deadline')).toBe(nl.validation.invalidDate);
  });
});
