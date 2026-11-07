/** Bitbucket Cloud payload builders for merge-api's tests (REST 2.0 and webhooks), on top of `fake-http.ts`. */

export const BITBUCKET_API = 'api.bitbucket.org/2.0';

export const BITBUCKET_REPO = {
  uuid: '{repo-uuid-1}',
  full_name: 'acme/web',
  is_private: true,
  mainbranch: { name: 'main' },
  links: { html: { href: 'https://bitbucket.org/acme/web' } },
  workspace: { slug: 'acme' },
};

const user = (nickname: string) => ({
  uuid: `{${nickname}}`,
  nickname,
  display_name: nickname,
  links: { avatar: { href: `https://bb.example/${nickname}.png` } },
});

export interface BitbucketPrFixture {
  id: number;
  title?: string;
  state?: 'OPEN' | 'MERGED' | 'DECLINED';
  author?: string;
  updatedOn?: string;
  reviewers?: string[];
  approvedBy?: string[];
  changesRequestedBy?: string[];
  source?: string;
  sha?: string;
}

function voteState(f: BitbucketPrFixture, name: string): 'changes_requested' | 'approved' | null {
  if ((f.changesRequestedBy ?? []).includes(name)) return 'changes_requested';
  return (f.approvedBy ?? []).includes(name) ? 'approved' : null;
}

export function bitbucketPr(f: BitbucketPrFixture) {
  const reviewers = f.reviewers ?? [];
  return {
    id: f.id,
    title: f.title ?? `Pull request ${f.id}`,
    description: '',
    state: f.state ?? 'OPEN',
    draft: false,
    created_on: '2026-10-30T09:00:00.000000+00:00',
    updated_on: f.updatedOn ?? '2026-11-01T10:00:00.000000+00:00',
    author: user(f.author ?? 'Octo-Dev'),
    source: { branch: { name: f.source ?? `feature/${f.id}` }, commit: { hash: f.sha ?? `sha${f.id}` } },
    destination: { branch: { name: 'main' } },
    links: { html: { href: `https://bitbucket.org/acme/web/pull-requests/${f.id}` } },
    reviewers: reviewers.map(user),
    participants: reviewers.map((name) => ({
      user: user(name),
      role: 'REVIEWER',
      approved: (f.approvedBy ?? []).includes(name),
      state: voteState(f, name),
    })),
  };
}

/** A webhook delivery body for a pull request event. */
export function bitbucketPrHook(f: BitbucketPrFixture, repoUuid = '{repo-uuid-1}') {
  return { pullrequest: bitbucketPr(f), repository: { uuid: repoUuid, full_name: 'acme/web' }, actor: user('Octo-Dev') };
}
