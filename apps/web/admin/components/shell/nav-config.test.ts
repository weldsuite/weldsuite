import { describe, expect, it, vi } from 'vitest';

const edition = vi.hoisted(() => ({ GLOBAL: true }));
vi.mock('@/lib/edition', () => edition);

import { getNavAreas } from './nav-config';

/** Every href the navigation offers: area links and the items in their groups. */
function hrefs(): string[] {
  return getNavAreas().flatMap((area) => [area.href, ...area.groups.flatMap((group) => group.items.map((item) => item.href))]);
}

/** Pages that call a Global service (Stripe, Neon, Telnyx, …) and answer 404 on Kubernetes. */
const GLOBAL_ONLY = [
  '/support',
  '/databases',
  '/partners',
  '/partners/new',
  '/ai-costs',
  '/plan-pricing',
  '/domain-pricing',
  '/phone-pricing',
  '/weldmeet-ai-pricing',
];

/** Pages only the Kubernetes editions have: Global keeps staff in Clerk and flags in Flagship. */
const KUBERNETES_ONLY = ['/staff', '/flags'];

describe('getNavAreas', () => {
  it('offers every Global page on Global, and none of the Kubernetes ones', () => {
    edition.GLOBAL = true;
    expect(hrefs()).toEqual(expect.arrayContaining(GLOBAL_ONLY));
    for (const href of KUBERNETES_ONLY) expect(hrefs()).not.toContain(href);
  });

  it('leaves out Global-only pages on Kubernetes, and no area ends up empty', () => {
    edition.GLOBAL = false;
    const offered = hrefs();
    for (const href of GLOBAL_ONLY) expect(offered).not.toContain(href);
    expect(offered).toEqual(
      expect.arrayContaining(['/', '/apps', '/access-requests', '/warmup', '/outbound-mail', '/workspaces', '/plans', '/plans/new', '/activity', ...KUBERNETES_ONLY]),
    );
    for (const area of getNavAreas()) {
      expect(area.groups.flatMap((group) => group.items).length).toBeGreaterThan(0);
    }
  });
});
