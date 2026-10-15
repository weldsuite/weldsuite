/**
 * Brazilian fiscal details of a contact (`brFiscal` on `/api/accounting-contacts`):
 * municipal registration, IBGE municipality, whether the party is an ICMS
 * taxpayer and whether it is in the Simples Nacional. The CNPJ is the
 * contact's `vatNumber` (a CPF typed there is moved server-side to
 * `brFiscal.taxId`), the Inscrição Estadual its `registrationNumber`.
 */
import { isValidMunicipalityCode } from './identifiers';

/** `auto` leaves the flag unset: the tax engine reads it from the tax id (a CNPJ is a taxpayer). */
export type BrIcmsChoice = 'auto' | 'yes' | 'no';

export interface BrContactValues {
  inscricaoMunicipal: string;
  municipalityCode: string;
  icmsContributor: BrIcmsChoice;
  simplesNacional: boolean;
}

export const DEFAULT_BR_CONTACT: BrContactValues = {
  inscricaoMunicipal: '',
  municipalityCode: '',
  icmsContributor: 'auto',
  simplesNacional: false,
};

/** What a contact carries under `brFiscal`. */
export interface BrFiscalView {
  inscricaoMunicipal?: string;
  icmsContributor?: boolean;
  simplesNacional?: boolean;
  municipalityCode?: string;
  /** CPF of a person. */
  taxId?: string;
}

export function brContactValues(brFiscal: BrFiscalView | null | undefined): BrContactValues {
  if (!brFiscal) return DEFAULT_BR_CONTACT;
  return {
    inscricaoMunicipal: brFiscal.inscricaoMunicipal ?? '',
    municipalityCode: brFiscal.municipalityCode ?? '',
    icmsContributor: brFiscal.icmsContributor === undefined ? 'auto' : brFiscal.icmsContributor ? 'yes' : 'no',
    simplesNacional: brFiscal.simplesNacional === true,
  };
}

/**
 * The `brFiscal` body of a create / update: the whole object, so a field the
 * user emptied is dropped from what is stored. `null` clears it when nothing is set.
 */
export function brFiscalPayload(values: BrContactValues): Omit<BrFiscalView, 'taxId'> | null {
  const out: Omit<BrFiscalView, 'taxId'> = {};
  if (values.inscricaoMunicipal.trim()) out.inscricaoMunicipal = values.inscricaoMunicipal.trim();
  if (values.municipalityCode.trim()) out.municipalityCode = values.municipalityCode.trim();
  if (values.icmsContributor !== 'auto') out.icmsContributor = values.icmsContributor === 'yes';
  if (values.simplesNacional) out.simplesNacional = true;
  return Object.keys(out).length > 0 ? out : null;
}

export function brContactMunicipalityError(value: string): boolean {
  return value.trim() !== '' && !isValidMunicipalityCode(value);
}
