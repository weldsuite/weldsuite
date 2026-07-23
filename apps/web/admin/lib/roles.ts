// Client-safe admin role constants. Kept free of `server-only` and any
// database imports so both client components and server code can use them.
// Mirrors the `admin_role` enum + `AdminRole` type in @weldsuite/db/schema/master.

export type AdminRole = 'superadmin' | 'admin' | 'viewer';

export const ADMIN_ROLES: readonly AdminRole[] = ['superadmin', 'admin', 'viewer'];

export const ROLE_LABELS: Record<AdminRole, string> = {
  superadmin: 'Superadmin',
  admin: 'Admin',
  viewer: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Record<AdminRole, string> = {
  superadmin: 'Full access, and can invite or remove other admins.',
  admin: 'Full operational access. Cannot manage members.',
  viewer: 'Read-only access to every screen.',
};
