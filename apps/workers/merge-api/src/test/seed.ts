/** Rows the route tests start from, written straight to the tenant DB. */

import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

type Tables = typeof schema;

export async function seedTeam(db: Database, key = 'PLAT', overrides: Partial<Tables['mergeTeams']['$inferInsert']> = {}) {
  const [row] = await db
    .insert(schema.mergeTeams)
    .values({ id: generateId('mtm'), key, name: `${key} team`, createdByUserId: 'user_alice', ...overrides })
    .returning();
  return row!;
}

export async function seedIssue(
  db: Database,
  teamId: string,
  number: number,
  overrides: Partial<Tables['mergeIssues']['$inferInsert']> = {},
) {
  const [row] = await db
    .insert(schema.mergeIssues)
    .values({ id: generateId('mis'), teamId, number, title: `Issue ${number}`, creatorUserId: 'user_alice', ...overrides })
    .returning();
  await db
    .update(schema.mergeTeams)
    .set({ issueCounter: number })
    .where(eq(schema.mergeTeams.id, teamId));
  return row!;
}

export async function seedConnection(db: Database, overrides: Partial<Tables['mergeConnections']['$inferInsert']> = {}) {
  const [row] = await db
    .insert(schema.mergeConnections)
    .values({
      id: generateId('mcn'),
      provider: 'github',
      externalAccountId: '4242',
      accountLogin: 'acme',
      accountType: 'organization',
      createdByUserId: 'user_alice',
      ...overrides,
    })
    .returning();
  return row!;
}

export async function seedRepository(
  db: Database,
  connectionId: string,
  overrides: Partial<Tables['mergeRepositories']['$inferInsert']> = {},
) {
  const [row] = await db
    .insert(schema.mergeRepositories)
    .values({
      id: generateId('mrp'),
      connectionId,
      provider: 'github',
      externalId: '900',
      fullName: 'acme/web',
      defaultBranch: 'main',
      private: true,
      createdByUserId: 'user_alice',
      ...overrides,
    })
    .returning();
  return row!;
}

export async function seedPullRequest(
  db: Database,
  repositoryId: string,
  number: number,
  overrides: Partial<Tables['mergePullRequests']['$inferInsert']> = {},
) {
  const [row] = await db
    .insert(schema.mergePullRequests)
    .values({
      id: generateId('mpr'),
      repositoryId,
      provider: 'github',
      externalId: String(5000 + number),
      number,
      title: `Pull request ${number}`,
      state: 'open',
      url: `https://github.com/acme/web/pull/${number}`,
      authorLogin: 'octo-dev',
      providerCreatedAt: new Date('2026-10-30T09:00:00Z'),
      providerUpdatedAt: new Date('2026-11-01T10:00:00Z'),
      ...overrides,
    })
    .returning();
  return row!;
}

export async function seedGithubInstallation(db: Database, installationId = 4242) {
  const [row] = await db
    .insert(schema.githubConnections)
    .values({
      id: generateId('ghc'),
      workspaceId: 'org_alpha',
      installationId,
      appSlug: 'weldsuite',
      ownerType: 'org',
      ownerLogin: 'acme',
      status: 'active',
    })
    .returning();
  return row!;
}
