import { describe, expect, it } from 'vitest';
import type { Buyer } from '@/hooks/queries/use-commerce-buyers-queries';
import {
  amountWithCurrency,
  approvalActorName,
  buildEditSchema,
  buildInviteSchema,
  buyerDisplayName,
  buyerErrorMessage,
  buyerRoleHint,
  buyerRoleLabel,
  buyerStatusLabel,
  buyerStatusTone,
  editValuesFromBuyer,
  emptyInviteValues,
  normalizeAmount,
  toBuyerPatch,
  toInviteInput,
} from './buyers';

const buyer = (over: Partial<Buyer> = {}): Buyer => ({
  id: 'byr_1',
  personId: 'per_1',
  companyId: 'cmp_1',
  name: 'Jan de Vries',
  email: 'jan@acme.test',
  role: 'buyer',
  spendLimit: '1500.00',
  spendLimitCurrency: 'EUR',
  status: 'active',
  invitedAt: '2026-11-01T10:00:00.000Z',
  acceptedAt: '2026-11-02T10:00:00.000Z',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
  ...over,
});

describe('labels and tones', () => {
  it('say the role and the status in words, and give each status a tone', () => {
    expect(buyerRoleLabel('approver')).toBe('Approver');
    expect(buyerRoleHint('admin')).toContain('manages the buyers');
    expect(buyerStatusLabel('invited')).toBe('Invited');
    expect(buyerStatusTone('active')).toBe('success');
    expect(buyerStatusTone('invited')).toBe('warning');
    expect(buyerStatusTone('disabled')).toBe('neutral');
  });

  it('show a role this version does not know as stored', () => {
    expect(buyerRoleLabel('super_admin' as never)).toBe('super admin');
  });

  it('name a buyer by name, else by email, and an approval actor by name, else email, else nothing', () => {
    expect(buyerDisplayName(buyer())).toBe('Jan de Vries');
    expect(buyerDisplayName(buyer({ name: '  ' }))).toBe('jan@acme.test');
    expect(approvalActorName({ name: 'Eva', email: 'eva@acme.test' })).toBe('Eva');
    expect(approvalActorName({ name: null, email: 'eva@acme.test' })).toBe('eva@acme.test');
    expect(approvalActorName({ name: null })).toBeNull();
    expect(approvalActorName(null)).toBeNull();
  });
});

describe('amounts', () => {
  it('normalises an amount to two decimals, empty to empty, and leaves a non-amount as typed', () => {
    expect(normalizeAmount('1500')).toBe('1500.00');
    expect(normalizeAmount(' 1500.5 ')).toBe('1500.50');
    expect(normalizeAmount('')).toBe('');
    expect(normalizeAmount('12,50')).toBe('12,50');
  });

  it('pairs an amount with an upper-case currency, or neither', () => {
    expect(amountWithCurrency('250', 'eur')).toEqual({ amount: '250.00', currency: 'EUR' });
    expect(amountWithCurrency('  ', 'EUR')).toEqual({ amount: null, currency: null });
  });
});

describe('the invite form', () => {
  const schema = buildInviteSchema();
  const values = { ...emptyInviteValues('EUR'), email: 'jan@acme.test' };
  const messagesOf = (input: unknown) => {
    const result = schema.safeParse(input);
    return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  };

  it('accepts an email with a buyer role and no limit, and starts with the invitation switched on', () => {
    expect(schema.safeParse(values).success).toBe(true);
    expect(values.sendInvite).toBe(true);
    expect(values.role).toBe('buyer');
  });

  it('asks for an email, and a valid one', () => {
    expect(messagesOf({ ...values, email: '' })).toContain('email: Enter an email address.');
    expect(messagesOf({ ...values, email: 'jan@' })).toContain('email: Enter a valid email address.');
  });

  it('checks a limit: a plain positive amount with a three-letter currency', () => {
    expect(messagesOf({ ...values, spendLimit: 'lots' })).toContain('spendLimit: Enter an amount such as 1500 or 1500.50.');
    expect(messagesOf({ ...values, spendLimit: '0' })).toContain('spendLimit: The amount must be more than zero.');
    expect(messagesOf({ ...values, spendLimit: '100', currency: 'EU' })).toContain(
      'currency: Enter a three-letter currency code, such as EUR.',
    );
    expect(messagesOf({ ...values, spendLimit: '100.50' })).toEqual([]);
  });

  it('ignores the currency when there is no limit', () => {
    expect(messagesOf({ ...values, spendLimit: '', currency: '' })).toEqual([]);
  });

  it('builds the request: trimmed, names only when given, the limit with its currency only when set', () => {
    expect(toInviteInput('cmp_1', { ...values, email: ' jan@acme.test ' })).toEqual({
      companyId: 'cmp_1',
      email: 'jan@acme.test',
      role: 'buyer',
      sendInvite: true,
    });
    expect(
      toInviteInput('cmp_1', {
        ...values,
        firstName: ' Jan ',
        lastName: 'de Vries',
        role: 'approver',
        spendLimit: '1500',
        currency: 'eur',
        sendInvite: false,
      }),
    ).toEqual({
      companyId: 'cmp_1',
      email: 'jan@acme.test',
      firstName: 'Jan',
      lastName: 'de Vries',
      role: 'approver',
      spendLimit: '1500.00',
      spendLimitCurrency: 'EUR',
      sendInvite: false,
    });
  });
});

describe('the edit form', () => {
  const schema = buildEditSchema();

  it('starts from the buyer, and from the default currency when there is no limit', () => {
    expect(editValuesFromBuyer(buyer({ status: 'disabled' }), 'USD')).toEqual({
      role: 'buyer',
      spendLimit: '1500.00',
      currency: 'EUR',
      disabled: true,
    });
    expect(editValuesFromBuyer(buyer({ spendLimit: null, spendLimitCurrency: null }), 'USD')).toMatchObject({
      spendLimit: '',
      currency: 'USD',
    });
  });

  it('checks the limit as the invite does', () => {
    expect(schema.safeParse({ role: 'buyer', spendLimit: '-5', currency: 'EUR', disabled: false }).success).toBe(false);
    expect(schema.safeParse({ role: 'buyer', spendLimit: '5', currency: 'EUR', disabled: false }).success).toBe(true);
  });

  it('sends nothing when nothing changed, even when the limit is written another way', () => {
    const values = { role: 'buyer' as const, spendLimit: '1500', currency: 'eur', disabled: false };
    expect(toBuyerPatch(buyer(), values)).toEqual({});
  });

  it('sends only what changed', () => {
    const base = editValuesFromBuyer(buyer(), 'EUR');
    expect(toBuyerPatch(buyer(), { ...base, role: 'admin' })).toEqual({ role: 'admin' });
    expect(toBuyerPatch(buyer(), { ...base, spendLimit: '2000' })).toEqual({ spendLimit: '2000.00', spendLimitCurrency: 'EUR' });
    expect(toBuyerPatch(buyer(), { ...base, currency: 'USD' })).toEqual({ spendLimit: '1500.00', spendLimitCurrency: 'USD' });
  });

  it('clears the limit with nulls', () => {
    const base = editValuesFromBuyer(buyer(), 'EUR');
    expect(toBuyerPatch(buyer(), { ...base, spendLimit: '' })).toEqual({ spendLimit: null, spendLimitCurrency: null });
    expect(toBuyerPatch(buyer({ spendLimit: null, spendLimitCurrency: null }), { ...base, spendLimit: '' })).toEqual({});
  });

  it('disables a buyer, and enables one again to where it was before', () => {
    const base = editValuesFromBuyer(buyer(), 'EUR');
    expect(toBuyerPatch(buyer(), { ...base, disabled: true })).toEqual({ status: 'disabled' });
    expect(toBuyerPatch(buyer({ status: 'disabled' }), { ...base, disabled: false })).toEqual({ status: 'active' });
    expect(toBuyerPatch(buyer({ status: 'disabled', acceptedAt: null }), { ...base, disabled: false })).toEqual({ status: 'invited' });
    expect(toBuyerPatch(buyer({ status: 'invited', acceptedAt: null }), { ...base, disabled: false })).toEqual({});
  });
});

describe('buyerErrorMessage', () => {
  const failure = (code: string, message = 'raw') => ({ status: 409, body: { error: { code, message } } });

  it('says LAST_ADMIN in words, anything else as the server worded it, else the fallback', () => {
    expect(buyerErrorMessage(failure('LAST_ADMIN'), 'x')).toContain('last admin');
    expect(buyerErrorMessage(failure('OTHER'), 'x')).toBe('raw');
    expect(buyerErrorMessage(new Error('network down'), 'x')).toBe('network down');
    expect(buyerErrorMessage({}, 'fallback')).toBe('fallback');
  });
});
