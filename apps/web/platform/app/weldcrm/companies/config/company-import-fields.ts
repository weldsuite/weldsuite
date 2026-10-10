/**
 * Mappable columns for the company importer. `accessorKey` matches the server
 * import record (createCompanySchema + partyCode); `header` is the localized
 * label shown in the mapping UI and the downloadable template.
 */

import type { ImportFieldDef } from '@/app/weldcrm/components/import-entities-dialog';
import { companyColumns } from './company-grid-config';

type Tfn = (path: string, params?: Record<string, unknown>) => string;

/** A row is importable if at least one of these mapped columns has a value. */
export const COMPANY_IMPORT_REQUIRE_ONE_OF = ['partyCode', 'name', 'email'];

/**
 * The grid column's own display name as an alias, when the export writes a
 * different header than the import field's label (e.g. the grid's "Company"
 * column vs. the import field's "Name"). Keeps the app's own CSV/Excel
 * export auto-mappable on re-import without hand-maintaining a second list.
 */
function gridAlias(accessorKey: string): string[] {
  const column = companyColumns.find((c) => c.id === accessorKey);
  return column ? [column.name] : [];
}

export function getCompanyImportFields(t: Tfn): ImportFieldDef[] {
  const f = (key: string) => t(`crm.importExport.fields.company.${key}`);
  return [
    { header: f('partyCode'), accessorKey: 'partyCode' },
    { header: f('name'), accessorKey: 'name', aliases: gridAlias('name') },
    { header: f('tradingName'), accessorKey: 'tradingName' },
    { header: f('email'), accessorKey: 'email' },
    { header: f('alternateEmails'), accessorKey: 'alternateEmails', multiValue: true },
    { header: f('phone'), accessorKey: 'phone' },
    { header: f('mobile'), accessorKey: 'mobile' },
    { header: f('fax'), accessorKey: 'fax' },
    { header: f('website'), accessorKey: 'website' },
    // The grid's "Primary Address" column exports as a JSON object, so this
    // field reads it back and the app's own export re-imports with the column
    // mapped. The grid column id is `location`, hence the alias lookup.
    {
      header: f('primaryAddress'),
      accessorKey: 'primaryAddress',
      valueType: 'address',
      aliases: gridAlias('location'),
    },
    { header: f('vatNumber'), accessorKey: 'vatNumber' },
    { header: f('registrationNumber'), accessorKey: 'registrationNumber' },
    { header: f('industry'), accessorKey: 'industry' },
    { header: f('employeeCount'), accessorKey: 'employeeCount', aliases: gridAlias('employeeCount') },
    { header: f('status'), accessorKey: 'status' },
    { header: f('lifecycleStage'), accessorKey: 'lifecycleStage' },
    { header: f('segment'), accessorKey: 'segment' },
    { header: f('rating'), accessorKey: 'rating' },
    { header: f('source'), accessorKey: 'source' },
    { header: f('linkedinUrl'), accessorKey: 'linkedinUrl' },
    { header: f('twitterHandle'), accessorKey: 'twitterHandle' },
    { header: f('facebookUrl'), accessorKey: 'facebookUrl' },
    { header: f('preferredContactMethod'), accessorKey: 'preferredContactMethod' },
    { header: f('preferredLanguage'), accessorKey: 'preferredLanguage' },
    { header: f('timezone'), accessorKey: 'timezone' },
    { header: f('tags'), accessorKey: 'tags', multiValue: true },
    { header: f('notes'), accessorKey: 'notes' },
    { header: f('internalNotes'), accessorKey: 'internalNotes' },
    {
      header: f('isSupplier'),
      accessorKey: 'isSupplier',
      valueType: 'boolean',
      aliases: gridAlias('isSupplier'),
    },
    {
      header: f('isLead'),
      accessorKey: 'isLead',
      valueType: 'boolean',
      aliases: gridAlias('isLead'),
    },
  ];
}

export const COMPANY_IMPORT_TEMPLATE_EXAMPLE: Record<string, string> = {
  partyCode: 'ACME-001',
  name: 'Acme Industries',
  tradingName: 'Acme',
  email: 'info@acme.example',
  phone: '+31 20 123 4567',
  website: 'https://acme.example',
  vatNumber: 'NL123456789B01',
  industry: 'Manufacturing',
  status: 'prospect',
  tags: 'key-account,manufacturing',
};
