import type { PaymentMethod } from '@/lib/api/domains/weldbooks';

/** Every value of `payments.payment_method`, in display order. */
export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  'bank_transfer',
  'ach',
  'check',
  'wire',
  'direct_debit',
  'ideal',
  'credit_card',
  'debit_card',
  'cash',
  'third_party_network',
  'other',
];

/** Methods that only make sense in one country. */
const COUNTRY_ONLY: Partial<Record<PaymentMethod, string>> = {
  ideal: 'NL',
  check: 'US',
  ach: 'US',
};

/**
 * The payment methods to offer for an entity's jurisdiction: iDEAL only for
 * Dutch entities, check and ACH only for US entities, everything else always.
 * `current` stays in the list so an existing value is never hidden.
 */
export function paymentMethodsFor(
  jurisdictionCode: string | null | undefined,
  current?: string | null,
): PaymentMethod[] {
  const code = jurisdictionCode?.toUpperCase() ?? null;
  return PAYMENT_METHODS.filter((method) => {
    const only = COUNTRY_ONLY[method];
    return !only || only === code || method === current;
  });
}

/** The method a new payment starts with. */
export function defaultPaymentMethod(jurisdictionCode: string | null | undefined): PaymentMethod {
  return jurisdictionCode?.toUpperCase() === 'US' ? 'ach' : 'bank_transfer';
}

export function isPaymentMethod(value: string): value is PaymentMethod {
  return (PAYMENT_METHODS as readonly string[]).includes(value);
}
