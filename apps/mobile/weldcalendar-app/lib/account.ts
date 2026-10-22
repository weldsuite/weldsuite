/**
 * The two lines of the account card on More: who is signed in, and where.
 *
 * Without a name the email becomes the title, so it must not repeat in the
 * subtitle.
 */

export interface AccountLinesInput {
  fullName?: string | null;
  email?: string | null;
  workspaceName?: string | null;
}

export function accountLines(
  { fullName, email, workspaceName }: AccountLinesInput,
  fallback: string,
): { title: string; subtitle: string } {
  const name = fullName?.trim() || null;
  const address = email?.trim() || null;
  return {
    title: name ?? address ?? fallback,
    subtitle: [name ? address : null, workspaceName].filter(Boolean).join(' · '),
  };
}
