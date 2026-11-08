/**
 * Staff actions on the outbound mail guard, as server functions. The bodies are
 * in `./outbound-mail.server.ts`; each export here keeps that function's
 * signature and runs it on the server.
 */
import { createServerFn } from '@tanstack/react-start';
import {
  updateOutboundPolicy as updateOutboundPolicyOnServer,
  reviewOutboundCase as reviewOutboundCaseOnServer,
  revealOutboundSnippet as revealOutboundSnippetOnServer,
  requestOutboundReview as requestOutboundReviewOnServer,
} from './outbound-mail.server';

type Server = typeof import('./outbound-mail.server');

const updateOutboundPolicyFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['updateOutboundPolicy']>) => args)
  .handler(({ data }) => updateOutboundPolicyOnServer(...data));
export const updateOutboundPolicy = (...args: Parameters<Server['updateOutboundPolicy']>) =>
  updateOutboundPolicyFn({ data: args });

const reviewOutboundCaseFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['reviewOutboundCase']>) => args)
  .handler(({ data }) => reviewOutboundCaseOnServer(...data));
export const reviewOutboundCase = (...args: Parameters<Server['reviewOutboundCase']>) =>
  reviewOutboundCaseFn({ data: args });

const revealOutboundSnippetFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['revealOutboundSnippet']>) => args)
  .handler(({ data }) => revealOutboundSnippetOnServer(...data));
export const revealOutboundSnippet = (...args: Parameters<Server['revealOutboundSnippet']>) =>
  revealOutboundSnippetFn({ data: args });

const requestOutboundReviewFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['requestOutboundReview']>) => args)
  .handler(({ data }) => requestOutboundReviewOnServer(...data));
export const requestOutboundReview = (...args: Parameters<Server['requestOutboundReview']>) =>
  requestOutboundReviewFn({ data: args });
