/**
 * Small rules for the roles of a template: names are unique without regard to
 * case (the server refuses a duplicate), and the default email is optional.
 */

import { z } from 'zod';
import type { SignRecipientDto } from '@weldsuite/app-api-client/schemas/weldsign';

const emailSchema = z.string().trim().email();

/** Whether another role of the template already has this name (ignoring case). */
export function roleNameTaken(roles: Pick<SignRecipientDto, 'id' | 'roleName'>[], name: string, exceptId?: string): boolean {
  const wanted = name.trim().toLowerCase();
  return roles.some((role) => role.id !== exceptId && (role.roleName ?? '').trim().toLowerCase() === wanted);
}

/**
 * Reads an optional email field: blank means "no default" (`null`), a valid
 * address is returned lower-cased, anything else is `undefined`.
 */
export function parseOptionalEmail(raw: string): string | null | undefined {
  const text = raw.trim();
  if (text === '') return null;
  const parsed = emailSchema.safeParse(text);
  return parsed.success ? parsed.data.toLowerCase() : undefined;
}

/** The roles in the order they are asked for: routing order first, then as the server lists them. */
export function rolesInOrder<T extends Pick<SignRecipientDto, 'routingOrder'>>(roles: readonly T[]): T[] {
  return roles
    .map((role, index) => ({ role, index }))
    .sort((a, b) => a.role.routingOrder - b.role.routingOrder || a.index - b.index)
    .map(({ role }) => role);
}
