/**
 * Auth utility functions for handling redirects safely
 */

/**
 * Check if a URL path points to an auth page that would cause a redirect loop
 */
export function isAuthPage(url: string): boolean {
  const authPaths = ['/auth/login', '/auth/register', '/auth/sso-callback', '/onboarding'];
  try {
    // Parse URL to extract just the pathname (handles both relative and absolute URLs)
    const parsed = new URL(url, 'http://localhost');
    return authPaths.some(path => parsed.pathname.startsWith(path));
  } catch {
    // If URL parsing fails, check if it starts with /auth/ or /onboarding
    return url.startsWith('/auth/') || url.startsWith('/onboarding');
  }
}

/**
 * Get a safe callback URL from search params, preventing redirect loops.
 * If the callback URL points to an auth page, returns '/' (dashboard) instead.
 */
export function getSafeCallbackUrl(searchParams: URLSearchParams): string {
  const callbackUrl = searchParams.get('callbackUrl') || searchParams.get('redirect_url') || '/';

  // Prevent redirect loops - if callback points to auth page, go to dashboard
  if (isAuthPage(callbackUrl)) {
    return '/';
  }

  return callbackUrl;
}
