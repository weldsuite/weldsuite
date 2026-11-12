/**
 * From OIDC claims to the facade's person and workspaces (ADR SEC-012). The
 * rules live in `@weldsuite/app-api-client/auth/oidc-claims`, shared with the
 * mobile apps; this file keeps the platform's import path.
 */

export * from '@weldsuite/app-api-client/auth/oidc-claims';
