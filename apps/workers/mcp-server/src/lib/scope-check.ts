import type { ApiKeySession } from './api-types';

/**
 * Check if API key has required scope
 * Supports wildcards: '*' grants all, 'crm:*' grants all crm scopes
 */
export function hasScope(session: ApiKeySession, requiredScope: string): boolean {
  // Empty scopes array means no restrictions (backward compatibility)
  if (!session.scopes || session.scopes.length === 0) {
    return true;
  }

  // Wildcard scope grants all permissions
  if (session.scopes.includes('*')) {
    return true;
  }

  // Check for exact match
  if (session.scopes.includes(requiredScope)) {
    return true;
  }

  // Check for parent scope with wildcard
  // e.g., 'crm:read' matches 'crm:*'
  const parts = requiredScope.split(':');
  for (let i = parts.length - 1; i > 0; i--) {
    const parentScope = parts.slice(0, i).join(':') + ':*';
    if (session.scopes.includes(parentScope)) {
      return true;
    }
  }

  return false;
}
