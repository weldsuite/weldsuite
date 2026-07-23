import { atom } from 'jotai';
import type {
  LemlistSearchRow,
  WelddataLead,
} from '@weldsuite/app-api-client/schemas/welddata';

/**
 * Normalised shape the WeldData lead panel renders. WeldData leads are not
 * fetchable by id (search rows are ephemeral Lemlist results; saved leads carry
 * their full payload in the list response), so the grid stashes the clicked
 * row here and the panel reads it back by id — no network round-trip.
 */
export interface WelddataLeadPanelData {
  id: string;
  kind: 'person' | 'company';
  name?: string | null;
  email?: string | null;
  title?: string | null;
  companyName?: string | null;
  domain?: string | null;
  industry?: string | null;
  location?: string | null;
  country?: string | null;
  companySize?: string | null;
  linkedinUrl?: string | null;
  avatarUrl?: string | null;
  raw?: Record<string, unknown> | null;
}

/**
 * In-memory cache of leads the user has clicked, keyed by the same id passed to
 * `useObjectPanel().open({ type: 'welddata-lead', id })`. Module-level atom on
 * jotai's default store, so the grid (writer) and the globally-mounted panel
 * host (reader) share it without a Provider.
 */
export const welddataLeadCacheAtom = atom<Record<string, WelddataLeadPanelData>>({});

/** Map a Lemlist search result row to the panel shape. */
export function welddataLeadFromSearchRow(row: LemlistSearchRow): WelddataLeadPanelData {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    email: row.email,
    title: row.title,
    companyName: row.companyName,
    domain: row.domain,
    industry: row.industry,
    location: row.location,
    country: row.country,
    companySize: row.companySize,
    linkedinUrl: row.linkedinUrl,
    avatarUrl: row.avatarUrl,
    raw: row.raw,
  };
}

/** Map a saved WeldData list lead to the panel shape. */
export function welddataLeadFromSavedLead(lead: WelddataLead): WelddataLeadPanelData {
  return {
    id: lead.id,
    kind: lead.kind,
    name: lead.name,
    email: lead.email,
    title: lead.title,
    companyName: lead.companyName,
    domain: lead.domain,
    industry: lead.industry,
    location: lead.location,
    country: lead.country,
    companySize: lead.companySize,
    linkedinUrl: lead.linkedinUrl,
    avatarUrl: null,
    raw: lead.data ?? null,
  };
}
