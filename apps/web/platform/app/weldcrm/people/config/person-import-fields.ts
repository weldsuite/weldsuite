/**
 * Mappable columns for the person importer. `accessorKey` matches the server
 * import record (createPersonSchema minus company linking, plus partyCode);
 * `header` is the localized label shown in the mapping UI and the template.
 */

import type { ImportFieldDef } from '@/app/weldcrm/components/import-entities-dialog';

type Tfn = (path: string, params?: Record<string, unknown>) => string;

/** A row is importable if at least one of these mapped columns has a value. */
export const PERSON_IMPORT_REQUIRE_ONE_OF = [
  'partyCode',
  'email',
  'firstName',
  'lastName',
  'fullName',
];

export function getPersonImportFields(t: Tfn): ImportFieldDef[] {
  const f = (key: string) => t(`crm.importExport.fields.person.${key}`);
  return [
    { header: f('partyCode'), accessorKey: 'partyCode' },
    { header: f('firstName'), accessorKey: 'firstName' },
    { header: f('lastName'), accessorKey: 'lastName' },
    { header: f('fullName'), accessorKey: 'fullName' },
    { header: f('dateOfBirth'), accessorKey: 'dateOfBirth' },
    { header: f('gender'), accessorKey: 'gender' },
    { header: f('email'), accessorKey: 'email' },
    { header: f('alternateEmails'), accessorKey: 'alternateEmails', multiValue: true },
    { header: f('directPhone'), accessorKey: 'directPhone' },
    { header: f('mobilePhone'), accessorKey: 'mobilePhone' },
    { header: f('extension'), accessorKey: 'extension' },
    { header: f('title'), accessorKey: 'title' },
    { header: f('department'), accessorKey: 'department' },
    { header: f('role'), accessorKey: 'role' },
    { header: f('status'), accessorKey: 'status' },
    { header: f('lifecycleStage'), accessorKey: 'lifecycleStage' },
    { header: f('rating'), accessorKey: 'rating' },
    { header: f('influenceLevel'), accessorKey: 'influenceLevel' },
    { header: f('source'), accessorKey: 'source' },
    { header: f('linkedinUrl'), accessorKey: 'linkedinUrl' },
    { header: f('twitterHandle'), accessorKey: 'twitterHandle' },
    { header: f('preferredContactMethod'), accessorKey: 'preferredContactMethod' },
    { header: f('preferredLanguage'), accessorKey: 'preferredLanguage' },
    { header: f('bestTimeToContact'), accessorKey: 'bestTimeToContact' },
    { header: f('tags'), accessorKey: 'tags', multiValue: true },
    { header: f('interests'), accessorKey: 'interests', multiValue: true },
    { header: f('notes'), accessorKey: 'notes' },
    { header: f('internalNotes'), accessorKey: 'internalNotes' },
  ];
}

export const PERSON_IMPORT_TEMPLATE_EXAMPLE: Record<string, string> = {
  partyCode: 'JDOE-1',
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@acme.example',
  mobilePhone: '+31 6 1234 5678',
  title: 'VP of Engineering',
  status: 'active',
  tags: 'champion',
  interests: 'cloud,ai',
};
