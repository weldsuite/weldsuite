/**
 * The image of the record each note is attached to.
 *
 * The notes list (`GET /api/activities`) carries only the record's id and
 * name, so the Notes page has to look the image up itself: a company's own
 * avatar or else the logo of its website, a person's photo. Most records come
 * with the first page of companies / people; the ones that do not are fetched
 * one by one. The page shows at most 100 notes, which bounds those lookups.
 *
 * The real fix is for the activities list to return the record's image, the
 * way the page already expects (`customerAvatarUrl` / `contactAvatarUrl`).
 */

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { normalizeLogoDomain } from '@weldsuite/app-api-client/schemas/company-logos';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { logoDomainForCompany, useCompanyLogos } from '@/lib/crm/company-logo';
import { companyKeys, useCompanies, type Company } from '@/components/objects/company/use-company-data';
import { personKeys, usePeople, type Person } from '@/components/objects/person/use-person-data';

export interface NoteRecordRef {
  recordKind?: 'company' | 'person';
  recordId?: string;
}

/** Records looked up individually when the first list page does not hold them:
 *  as many as the Notes page shows notes, so none is left without its image. */
const MAX_SINGLE_LOOKUPS = 100;
const LIST_PAGE = { limit: 100 };
const STALE_MS = 5 * 60 * 1000;

export function noteRecordKey(ref: NoteRecordRef): string | undefined {
  return ref.recordKind && ref.recordId ? `${ref.recordKind}:${ref.recordId}` : undefined;
}

function distinctIds(refs: readonly NoteRecordRef[], kind: 'company' | 'person'): string[] {
  const ids = new Set<string>();
  for (const ref of refs) {
    if (ref.recordKind === kind && ref.recordId) ids.add(ref.recordId);
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/** Record key (`company:<id>` / `person:<id>`) to image URL, for the records that have one. */
export function useNoteRecordAvatars(refs: readonly NoteRecordRef[]): ReadonlyMap<string, string> {
  const { getClient } = useAppApiClient();
  const companyIds = useMemo(() => distinctIds(refs, 'company'), [refs]);
  const personIds = useMemo(() => distinctIds(refs, 'person'), [refs]);

  const { data: companyPage, isPending: companiesPending } = useCompanies(LIST_PAGE);
  const { data: peoplePage, isPending: peoplePending } = usePeople(LIST_PAGE);

  const listedCompanies = useMemo(
    () => new Map((companyPage?.data ?? []).map((c) => [c.id, c])),
    [companyPage],
  );
  const listedPeople = useMemo(() => new Map((peoplePage?.data ?? []).map((p) => [p.id, p])), [peoplePage]);

  const missingCompanyIds = useMemo(
    () => (companiesPending ? [] : companyIds.filter((id) => !listedCompanies.has(id)).slice(0, MAX_SINGLE_LOOKUPS)),
    [companiesPending, companyIds, listedCompanies],
  );
  const missingPersonIds = useMemo(
    () => (peoplePending ? [] : personIds.filter((id) => !listedPeople.has(id)).slice(0, MAX_SINGLE_LOOKUPS)),
    [peoplePending, personIds, listedPeople],
  );

  const singleCompanies = useQueries({
    queries: missingCompanyIds.map((id) => ({
      queryKey: companyKeys.detail(id),
      queryFn: async () => (await getClient()).get<{ data: Company }>(`/companies/${id}`),
      staleTime: STALE_MS,
    })),
    combine: (results) => results.map((r) => r.data?.data).filter((c): c is Company => !!c),
  });
  const singlePeople = useQueries({
    queries: missingPersonIds.map((id) => ({
      queryKey: personKeys.detail(id),
      queryFn: async () => (await getClient()).get<{ data: Person }>(`/people/${id}`),
      staleTime: STALE_MS,
    })),
    combine: (results) => results.map((r) => r.data?.data).filter((p): p is Person => !!p),
  });

  const companies = useMemo(() => {
    const wanted = new Set(companyIds);
    return [...listedCompanies.values(), ...singleCompanies].filter((c) => wanted.has(c.id));
  }, [companyIds, listedCompanies, singleCompanies]);

  // A company without an image of its own shows the logo of its website.
  const logoDomains = useMemo(() => companies.map((c) => logoDomainForCompany(c)), [companies]);
  const logos = useCompanyLogos(logoDomains);

  return useMemo(() => {
    const avatars = new Map<string, string>();
    for (const company of companies) {
      const domain = normalizeLogoDomain(logoDomainForCompany(company));
      const url = company.avatarUrl || (domain ? logos.get(domain) : undefined);
      if (url) avatars.set(`company:${company.id}`, url);
    }
    const wantedPeople = new Set(personIds);
    for (const person of [...listedPeople.values(), ...singlePeople]) {
      if (wantedPeople.has(person.id) && person.avatarUrl) avatars.set(`person:${person.id}`, person.avatarUrl);
    }
    return avatars;
  }, [companies, logos, personIds, listedPeople, singlePeople]);
}
