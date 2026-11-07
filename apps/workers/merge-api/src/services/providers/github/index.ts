/**
 * GitHub provider. `connection` wraps the App's REST client (connection.ts).
 * Area A adds `issues` (issues.ts, the two-way sync adapter); area B adds
 * `oauth` (oauth.ts, the App's user authorization); area C adds `review`
 * (review.ts).
 */

import type { ProviderModule } from '../types';
import { githubConnection } from './connection';
import { githubIssues } from './issues';
import { githubOAuth } from './oauth';
import { githubReview } from './review';

export const githubProvider: ProviderModule = {
  connection: githubConnection,
  issues: githubIssues,
  oauth: githubOAuth,
  review: githubReview,
};
