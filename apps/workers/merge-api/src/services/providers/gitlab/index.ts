/**
 * GitLab provider (gitlab.com and self-managed): connection (connection.ts,
 * webhooks.ts), issue sync (issues.ts), OAuth (oauth.ts) and review (review.ts).
 */

import type { ProviderModule } from '../types';
import { gitlabConnection } from './connection';
import { gitlabIssues } from './issues';
import { gitlabOAuth } from './oauth';
import { gitlabReview } from './review';

export const gitlabProvider: ProviderModule = {
  connection: gitlabConnection,
  issues: gitlabIssues,
  oauth: gitlabOAuth,
  review: gitlabReview,
};
