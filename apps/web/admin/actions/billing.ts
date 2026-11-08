/**
 * Customer billing changes from the workspace screen, as server functions. The
 * bodies are in `./billing.server.ts`; each export here keeps that function's
 * signature and runs it on the server.
 */
import { createServerFn } from '@tanstack/react-start';
import { globalOnly } from '@/lib/edition';
import {
  previewSubscriptionChange as previewSubscriptionChangeOnServer,
  changeSubscription as changeSubscriptionOnServer,
  cancelSubscription as cancelSubscriptionOnServer,
  reactivateSubscription as reactivateSubscriptionOnServer,
  setTrialEnd as setTrialEndOnServer,
  applyDiscount as applyDiscountOnServer,
  removeDiscount as removeDiscountOnServer,
  grantComp as grantCompOnServer,
  endComp as endCompOnServer,
  adjustCredits as adjustCreditsOnServer,
  refundPayment as refundPaymentOnServer,
  voidInvoice as voidInvoiceOnServer,
  grantSso as grantSsoOnServer,
  revokeSso as revokeSsoOnServer,
  disableSsoConnection as disableSsoConnectionOnServer,
} from './billing.server';

type Server = typeof import('./billing.server');

const previewSubscriptionChangeFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['previewSubscriptionChange']>) => args)
  .handler(({ data }) => previewSubscriptionChangeOnServer(...data));
export const previewSubscriptionChange = (...args: Parameters<Server['previewSubscriptionChange']>) =>
  previewSubscriptionChangeFn({ data: args });

const changeSubscriptionFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['changeSubscription']>) => args)
  .handler(({ data }) => changeSubscriptionOnServer(...data));
export const changeSubscription = (...args: Parameters<Server['changeSubscription']>) =>
  changeSubscriptionFn({ data: args });

const cancelSubscriptionFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['cancelSubscription']>) => args)
  .handler(({ data }) => cancelSubscriptionOnServer(...data));
export const cancelSubscription = (...args: Parameters<Server['cancelSubscription']>) =>
  cancelSubscriptionFn({ data: args });

const reactivateSubscriptionFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['reactivateSubscription']>) => args)
  .handler(({ data }) => reactivateSubscriptionOnServer(...data));
export const reactivateSubscription = (...args: Parameters<Server['reactivateSubscription']>) =>
  reactivateSubscriptionFn({ data: args });

const setTrialEndFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['setTrialEnd']>) => args)
  .handler(({ data }) => setTrialEndOnServer(...data));
export const setTrialEnd = (...args: Parameters<Server['setTrialEnd']>) =>
  setTrialEndFn({ data: args });

const applyDiscountFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['applyDiscount']>) => args)
  .handler(({ data }) => applyDiscountOnServer(...data));
export const applyDiscount = (...args: Parameters<Server['applyDiscount']>) =>
  applyDiscountFn({ data: args });

const removeDiscountFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['removeDiscount']>) => args)
  .handler(({ data }) => removeDiscountOnServer(...data));
export const removeDiscount = (...args: Parameters<Server['removeDiscount']>) =>
  removeDiscountFn({ data: args });

const grantCompFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['grantComp']>) => args)
  .handler(({ data }) => grantCompOnServer(...data));
export const grantComp = (...args: Parameters<Server['grantComp']>) =>
  grantCompFn({ data: args });

const endCompFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['endComp']>) => args)
  .handler(({ data }) => endCompOnServer(...data));
export const endComp = (...args: Parameters<Server['endComp']>) =>
  endCompFn({ data: args });

const adjustCreditsFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['adjustCredits']>) => args)
  .handler(({ data }) => adjustCreditsOnServer(...data));
export const adjustCredits = (...args: Parameters<Server['adjustCredits']>) =>
  adjustCreditsFn({ data: args });

const refundPaymentFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['refundPayment']>) => args)
  .handler(({ data }) => refundPaymentOnServer(...data));
export const refundPayment = (...args: Parameters<Server['refundPayment']>) =>
  refundPaymentFn({ data: args });

const voidInvoiceFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['voidInvoice']>) => args)
  .handler(({ data }) => voidInvoiceOnServer(...data));
export const voidInvoice = (...args: Parameters<Server['voidInvoice']>) =>
  voidInvoiceFn({ data: args });

const grantSsoFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['grantSso']>) => args)
  .handler(({ data }) => grantSsoOnServer(...data));
export const grantSso = (...args: Parameters<Server['grantSso']>) =>
  grantSsoFn({ data: args });

const revokeSsoFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['revokeSso']>) => args)
  .handler(({ data }) => revokeSsoOnServer(...data));
export const revokeSso = (...args: Parameters<Server['revokeSso']>) =>
  revokeSsoFn({ data: args });

const disableSsoConnectionFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['disableSsoConnection']>) => args)
  .handler(({ data }) => disableSsoConnectionOnServer(...data));
export const disableSsoConnection = (...args: Parameters<Server['disableSsoConnection']>) =>
  disableSsoConnectionFn({ data: args });
