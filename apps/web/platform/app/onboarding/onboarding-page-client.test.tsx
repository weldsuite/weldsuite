/**
 * /onboarding once a workspace exists: it shows provisioning until the
 * workspace is ready. A workspace this tab just created (the wizard, or the
 * create dialog on an OIDC provider, which comes back here after the
 * activation redirect) already has provisioning running, so the screen must
 * not start it again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OnboardingPageClient } from './onboarding-page-client';

interface Membership {
  organization: { id: string; name: string; slug: string | null };
}

const state = vi.hoisted(() => ({
  orgId: null as string | null,
  memberships: [] as Membership[],
  setActive: vi.fn(),
  provisioned: false,
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ isLoaded: true, orgId: state.orgId }),
  useUser: () => ({ user: { firstName: 'Anna', lastName: 'de Vries', primaryEmailAddress: { emailAddress: 'anna@acme.test' } } }),
  useOrganizationList: () => ({
    isLoaded: true,
    setActive: state.setActive,
    userMemberships: { data: state.memberships },
  }),
}));
vi.mock('@/hooks/use-onboarding', () => ({
  useOnboardingStatus: () => ({ data: { completed: false }, isLoading: false }),
  useDatabaseStatus: () => ({ data: { provisioned: state.provisioned, migrated: state.provisioned } }),
  useUserAndOrgInfo: () => ({ data: undefined }),
  useAvailableApps: () => ({ data: [] }),
}));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('@weldsuite/ui/components/page-loader', () => ({ PageLoader: () => <p>Loading</p> }));
vi.mock('./components/onboarding-wizard', () => ({ OnboardingWizard: () => <p>Wizard</p> }));
vi.mock('./components/provisioning-screen', () => ({
  ProvisioningScreen: ({ skipRetry = false }: { skipRetry?: boolean }) => (
    <p>{skipRetry ? 'Provisioning (already started)' : 'Provisioning (start it)'}</p>
  ),
}));

const PENDING_ORG_KEY = 'weldsuite:pending-org';
const membership = (id: string): Membership => ({ organization: { id, name: id, slug: null } });

beforeEach(() => {
  window.sessionStorage.clear();
  state.orgId = null;
  state.memberships = [];
  state.provisioned = false;
  // The activation redirects (OIDC) or reloads: never settles in a test.
  state.setActive.mockReset().mockReturnValue(new Promise(() => {}));
});

afterEach(() => window.sessionStorage.clear());

describe('onboarding with a workspace', () => {
  it("doesn't start provisioning again for the workspace this tab just created", () => {
    window.sessionStorage.setItem(PENDING_ORG_KEY, 'org_new');
    state.orgId = 'org_new';
    render(<OnboardingPageClient detectedCountry="NL" />);
    expect(screen.getByText('Provisioning (already started)')).toBeInTheDocument();
  });

  it('starts it for a workspace it found unfinished (a reload of a stuck one)', () => {
    window.sessionStorage.setItem(PENDING_ORG_KEY, 'org_other');
    state.orgId = 'org_new';
    render(<OnboardingPageClient detectedCountry="NL" />);
    expect(screen.getByText('Provisioning (start it)')).toBeInTheDocument();
  });

  it('activates the workspace this tab just created rather than the first one', () => {
    window.sessionStorage.setItem(PENDING_ORG_KEY, 'org_new');
    state.memberships = [membership('org_old'), membership('org_new')];
    render(<OnboardingPageClient detectedCountry="NL" />);
    expect(state.setActive).toHaveBeenCalledWith({ organization: 'org_new' });
  });

  it('activates the first workspace when none was just created (an invitee)', () => {
    state.memberships = [membership('org_old'), membership('org_new')];
    render(<OnboardingPageClient detectedCountry="NL" />);
    expect(state.setActive).toHaveBeenCalledWith({ organization: 'org_old' });
  });
});
