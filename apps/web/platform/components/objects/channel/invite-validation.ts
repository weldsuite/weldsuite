/**
 * Loose, client-side email check for the guest invite form: one `@`, no
 * whitespace, and a dot in the domain part. The server stays the authority —
 * this only keeps an obviously invalid address from enabling "Send invitation".
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

export type InviteTab = 'members' | 'guest';

/** Which invite tabs the dialog actually shows, in display order. */
export function availableInviteTabs(options: { isPrivate: boolean; canInviteExternal: boolean }): InviteTab[] {
  const tabs: InviteTab[] = [];
  if (options.isPrivate) tabs.push('members');
  if (options.canInviteExternal) tabs.push('guest');
  return tabs;
}
