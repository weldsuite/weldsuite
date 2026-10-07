/**
 * Turn a people-search query into the fields a create-person form can edit.
 *
 * A typed email fills the email (and a guess at the name from the local part).
 * A typed name fills first and last name. "Jane Doe <jane@acme.com>" fills both.
 * Nothing is invented — a name-only query leaves email empty so the person can
 * be completed in the form.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface PersonSeed {
  firstName: string;
  lastName: string;
  email: string;
}

function titleCaseToken(token: string): string {
  if (!token) return '';
  return token.charAt(0).toUpperCase() + token.slice(1);
}

function seedFromName(name: string): PersonSeed {
  const [first = '', ...rest] = name.trim().split(/\s+/).filter(Boolean);
  return { firstName: first, lastName: rest.join(' '), email: '' };
}

function seedFromEmail(email: string): PersonSeed {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._-]+/).filter(Boolean).map(titleCaseToken);
  return {
    firstName: parts[0] ?? '',
    lastName: parts.slice(1).join(' '),
    email,
  };
}

export function personSeedFromQuery(query: string): PersonSeed {
  const trimmed = query.trim();
  if (!trimmed) return { firstName: '', lastName: '', email: '' };

  const angled = /^(.*?)\s*<([^<>]+)>\s*$/.exec(trimmed);
  if (angled) {
    const email = angled[2]!.trim();
    if (EMAIL_RE.test(email)) {
      const fromName = seedFromName(angled[1] ?? '');
      return {
        firstName: fromName.firstName,
        lastName: fromName.lastName,
        email,
      };
    }
  }

  if (EMAIL_RE.test(trimmed)) return seedFromEmail(trimmed);
  return seedFromName(trimmed);
}
