/**
 * Bitbucket Cloud provider: connection (connection.ts, webhooks.ts), OAuth
 * (oauth.ts) and review (review.ts). Bitbucket has no issue sync.
 */

import type { ProviderModule } from '../types';
import { bitbucketConnection } from './connection';
import { bitbucketOAuth } from './oauth';
import { bitbucketReview } from './review';

export const bitbucketProvider: ProviderModule = {
  connection: bitbucketConnection,
  oauth: bitbucketOAuth,
  review: bitbucketReview,
};
