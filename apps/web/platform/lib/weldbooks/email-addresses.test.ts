import { describe, expect, it } from 'vitest';
import { addressProblem, isEmailAddress, MAX_RECIPIENTS, parseAddresses } from './email-addresses';
import { fillTemplate, placeholdersFor, placeholdersIn, unknownPlaceholders } from './email-template-preview';
import { canEditQuote, canInvoiceQuote, quoteTone, shareLeft } from './quote-status';

describe('e-mail addresses', () => {
  it('splits on commas, semicolons and spaces and drops repeats', () => {
    expect(parseAddresses('a@b.test, c@d.test;  A@B.test\ne@f.test')).toEqual(['a@b.test', 'c@d.test', 'e@f.test']);
    expect(parseAddresses('  ')).toEqual([]);
  });

  it('accepts plain addresses and refuses the rest', () => {
    expect(isEmailAddress('klant@example.test')).toBe(true);
    for (const bad of ['klant', 'klant@', '@example.test', 'klant@example', 'a b@c.test']) expect(isEmailAddress(bad)).toBe(false);
  });

  it('keeps the edge cases of the plain check', () => {
    for (const ok of ['a@b.c', 'a@.b.c', 'a@b..c', 'a.b+c@sub.example.test']) expect(isEmailAddress(ok)).toBe(true);
    for (const bad of ['a@b.', 'a@.b', 'a@b@c.d', 'a@b.c d', 'a@b.c,d', 'a;b@c.d', 'a@b.c\n', '']) expect(isEmailAddress(bad)).toBe(false);
  });

  it('answers a long hostile input at once', () => {
    const started = performance.now();
    expect(isEmailAddress(`a@${'a'.repeat(200_000)}`)).toBe(false);
    expect(isEmailAddress(`a@${'.'.repeat(200_000)}`)).toBe(true);
    expect(isEmailAddress(`${'a'.repeat(200_000)}@b`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('says what is wrong: nothing, too many, or one bad address', () => {
    expect(addressProblem('', { required: true })).toEqual({ kind: 'required' });
    expect(addressProblem('', { required: false })).toBeNull();
    expect(addressProblem('a@b.test, nope', { required: true })).toEqual({ kind: 'invalid', address: 'nope' });
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `u${i}@b.test`).join(',');
    expect(addressProblem(many, { required: true })).toEqual({ kind: 'tooMany', max: MAX_RECIPIENTS });
    expect(addressProblem('a@b.test', { required: true })).toBeNull();
  });
});

describe('e-mail template preview', () => {
  it('fills the placeholders it knows and leaves the others as written', () => {
    expect(fillTemplate('Dear {customerName}, {number} {unknown}', { customerName: 'Jansen', number: 'F-1' })).toBe('Dear Jansen, F-1 {unknown}');
  });

  it('offers the statutory placeholders only to reminders', () => {
    const all = ['customerName', 'link', 'collectionCosts', 'totalClaim'];
    expect(placeholdersFor('invoice', all)).toEqual(['customerName', 'link']);
    expect(placeholdersFor('reminder3', all)).toEqual(all);
  });

  it('finds the placeholders in a text and the ones the server does not know', () => {
    expect(placeholdersIn('{a} and {b} and {a}')).toEqual(['a', 'b']);
    expect(unknownPlaceholders('{a} {zzz}', ['a'])).toEqual(['zzz']);
  });
});

describe('quote status', () => {
  it('colours each status and falls back to grey', () => {
    expect(quoteTone('accepted')).toBe('green');
    expect(quoteTone('declined')).toBe('red');
    expect(quoteTone('whatever')).toBe('gray');
  });

  it('does not edit an accepted or invoiced quote, nor invoice a declined or expired one', () => {
    expect(canEditQuote({ status: 'sent' })).toBe(true);
    expect(canEditQuote({ status: 'accepted' })).toBe(false);
    expect(canEditQuote({ status: 'invoiced' })).toBe(false);
    expect(canInvoiceQuote({ status: 'accepted' })).toBe(true);
    expect(canInvoiceQuote({ status: 'declined' })).toBe(false);
    expect(canInvoiceQuote({ status: 'expired' })).toBe(false);
  });

  it('works out the share still to invoice from the invoices already made', () => {
    const invoice = (subtotal: string, status = 'sent', type = 'invoice') => ({
      id: 'i', invoiceNumber: null, status, type, total: subtotal, subtotal, currency: 'EUR', issueDate: null, entityId: null,
    });
    expect(shareLeft({ subtotal: '1000.00', invoices: [] })).toBe(100);
    expect(shareLeft({ subtotal: '1000.00', invoices: [invoice('300.00')] })).toBe(70);
    expect(shareLeft({ subtotal: '1000.00', invoices: [invoice('300.00'), invoice('200.00', 'cancelled')] })).toBe(70);
    expect(shareLeft({ subtotal: '1000.00', invoices: [invoice('1000.00')] })).toBe(0);
  });
});
