import { atom } from 'jotai';

/** What the quick add dialog had typed when "More details…" opened the full contact form. */
export interface ContactPrefill {
  kind: 'company' | 'person';
  companyName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  vatNumber?: string;
}

/**
 * Handed from the quick add dialog to the full form, in memory (not in the URL: it can hold a name
 * and an email address). The form takes it once and clears it.
 */
export const contactPrefillAtom = atom<ContactPrefill | null>(null);

/** The prefill without the empty fields, so the form keeps its own defaults for those. */
export function contactPrefillOf(values: ContactPrefill): ContactPrefill {
  const filled = Object.entries(values).filter(([, value]) => typeof value === 'string' && value.trim() !== '');
  return { ...(Object.fromEntries(filled) as Partial<ContactPrefill>), kind: values.kind };
}
