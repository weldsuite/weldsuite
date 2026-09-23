/**
 * Workforce portal URL — mirrors the hosted-app-api host detection in
 * `lib/api/public-env.ts` but for the team.weldsuite.org portal domain.
 */

function isTestSpaHost(host: string): boolean {
  return (
    host === 'app-test.weldsuite.org' ||
    host === 'app-tst.weldsuite.org' ||
    host === 'app-preview.weldsuite.org' ||
    host === 'weldsuite-test.pages.dev' ||
    host.endsWith('.weldsuite-test.pages.dev') ||
    host === 'localhost' ||
    host === '127.0.0.1'
  );
}

function portalBaseHost(): string {
  const host = typeof window === 'undefined' ? undefined : window.location.hostname;
  return host && isTestSpaHost(host) ? 'team-test.weldsuite.org' : 'team.weldsuite.org';
}

/** `customDomain` wins; otherwise the shared `team[.-test].weldsuite.org/<slug>` host. */
export function hrPortalUrl(customDomain: string | null | undefined, workspaceSlug: string | null | undefined): string | null {
  if (customDomain) return `https://${customDomain}`;
  if (!workspaceSlug) return null;
  return `https://${portalBaseHost()}/${workspaceSlug}`;
}
