/**
 * Azure DevOps provider: connection (connection.ts, webhooks.ts), OAuth through
 * Entra ID (oauth.ts) and review (review.ts). Azure DevOps has no issue sync.
 */

import type { ProviderModule } from '../types';
import { azureConnection } from './connection';
import { azureOAuth } from './oauth';
import { azureDevopsReview } from './review';

export const azureDevopsProvider: ProviderModule = {
  connection: azureConnection,
  oauth: azureOAuth,
  review: azureDevopsReview,
};
