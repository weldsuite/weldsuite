/**
 * Human-readable label for a workspace role.
 *
 * Lives in its own module rather than in team-member-details-panel.tsx so the
 * profile tabs can use it too: that panel imports the tabs, so a tab importing
 * back from the panel would close an import cycle.
 */
export function getRoleLabel(role: string): string {
  switch (role) {
    case 'OWNER': return 'Owner';
    case 'ADMIN': return 'Admin';
    case 'MEMBER': return 'Member';
    case 'VIEWER': return 'Viewer';
    default:
      // A custom-role id (e.g. `role_…`) whose name hasn't resolved from the
      // workspace-roles list yet. Don't masquerade it as "Member" — that made an
      // assigned custom role look like it had silently fallen back to Member.
      return role.startsWith('role_') ? 'Custom role' : 'Member';
  }
}
