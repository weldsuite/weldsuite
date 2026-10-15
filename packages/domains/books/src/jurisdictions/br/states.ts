/**
 * Brazilian states (UF) with their IBGE code, region and modal internal ICMS
 * rate. The modal rate is the general rate of the state's RICMS; many goods
 * have their own rate, which a line can override (fiscalData.icmsRate).
 * `fcp` is the poverty-fund surcharge (FCP / FECP / FECOEP) some states add on
 * top of the modal rate; it is listed separately because the NF-e reports it
 * in its own fields.
 *
 * Rates as of October 2026; see docs/plans/weldbooks-br.md for sources.
 */

export type BrRegion = 'N' | 'NE' | 'CO' | 'SE' | 'S';

export interface BrState {
  uf: string;
  name: string;
  ibge: string;
  region: BrRegion;
  /** Modal internal ICMS rate, percent. */
  icmsInternal: number;
  /** Poverty-fund surcharge on the general rate, percent (0 when none). */
  fcp: number;
}

export const BR_STATES: readonly BrState[] = [
  { uf: 'AC', name: 'Acre', ibge: '12', region: 'N', icmsInternal: 19, fcp: 0 },
  // 20.5% from 1 April 2026 (19% before); whether the 1% FECOEP comes on top is unconfirmed, so none is added.
  { uf: 'AL', name: 'Alagoas', ibge: '27', region: 'NE', icmsInternal: 20.5, fcp: 0 },
  { uf: 'AP', name: 'Amapá', ibge: '16', region: 'N', icmsInternal: 18, fcp: 0 },
  { uf: 'AM', name: 'Amazonas', ibge: '13', region: 'N', icmsInternal: 20, fcp: 0 },
  { uf: 'BA', name: 'Bahia', ibge: '29', region: 'NE', icmsInternal: 20.5, fcp: 0 },
  { uf: 'CE', name: 'Ceará', ibge: '23', region: 'NE', icmsInternal: 20, fcp: 0 },
  { uf: 'DF', name: 'Distrito Federal', ibge: '53', region: 'CO', icmsInternal: 20, fcp: 0 },
  { uf: 'ES', name: 'Espírito Santo', ibge: '32', region: 'SE', icmsInternal: 17, fcp: 0 },
  { uf: 'GO', name: 'Goiás', ibge: '52', region: 'CO', icmsInternal: 19, fcp: 0 },
  { uf: 'MA', name: 'Maranhão', ibge: '21', region: 'NE', icmsInternal: 23, fcp: 0 },
  { uf: 'MT', name: 'Mato Grosso', ibge: '51', region: 'CO', icmsInternal: 17, fcp: 0 },
  { uf: 'MS', name: 'Mato Grosso do Sul', ibge: '50', region: 'CO', icmsInternal: 17, fcp: 0 },
  { uf: 'MG', name: 'Minas Gerais', ibge: '31', region: 'SE', icmsInternal: 18, fcp: 0 },
  { uf: 'PA', name: 'Pará', ibge: '15', region: 'N', icmsInternal: 19, fcp: 0 },
  { uf: 'PB', name: 'Paraíba', ibge: '25', region: 'NE', icmsInternal: 20, fcp: 0 },
  { uf: 'PR', name: 'Paraná', ibge: '41', region: 'S', icmsInternal: 19.5, fcp: 0 },
  { uf: 'PE', name: 'Pernambuco', ibge: '26', region: 'NE', icmsInternal: 20.5, fcp: 0 },
  { uf: 'PI', name: 'Piauí', ibge: '22', region: 'NE', icmsInternal: 22.5, fcp: 0 },
  { uf: 'RJ', name: 'Rio de Janeiro', ibge: '33', region: 'SE', icmsInternal: 20, fcp: 2 },
  { uf: 'RN', name: 'Rio Grande do Norte', ibge: '24', region: 'NE', icmsInternal: 20, fcp: 0 },
  { uf: 'RS', name: 'Rio Grande do Sul', ibge: '43', region: 'S', icmsInternal: 17, fcp: 0 },
  { uf: 'RO', name: 'Rondônia', ibge: '11', region: 'N', icmsInternal: 19.5, fcp: 0 },
  { uf: 'RR', name: 'Roraima', ibge: '14', region: 'N', icmsInternal: 20, fcp: 0 },
  { uf: 'SC', name: 'Santa Catarina', ibge: '42', region: 'S', icmsInternal: 17, fcp: 0 },
  { uf: 'SP', name: 'São Paulo', ibge: '35', region: 'SE', icmsInternal: 18, fcp: 0 },
  { uf: 'SE', name: 'Sergipe', ibge: '28', region: 'NE', icmsInternal: 19, fcp: 1 },
  { uf: 'TO', name: 'Tocantins', ibge: '17', region: 'N', icmsInternal: 20, fcp: 0 },
];

const BY_UF = new Map(BR_STATES.map((s) => [s.uf, s]));
const BY_IBGE = new Map(BR_STATES.map((s) => [s.ibge, s]));

function plainName(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

const BY_NAME = new Map(BR_STATES.map((s) => [plainName(s.name), s]));

/** A state by UF ("SP"), IBGE code ("35") or name ("São Paulo", accents optional); undefined for anything else. */
export function brState(code: string | null | undefined): BrState | undefined {
  if (!code) return undefined;
  const trimmed = code.trim().toUpperCase();
  return BY_UF.get(trimmed) ?? BY_IBGE.get(trimmed) ?? BY_NAME.get(plainName(code));
}

export function isValidUf(code: string | null | undefined): boolean {
  return Boolean(code && BY_UF.has(code.trim().toUpperCase()));
}

/** The UF of an IBGE municipality code (7 digits; the first two are the state). */
export function ufOfMunicipality(ibgeMunicipality: string | null | undefined): string | undefined {
  if (!ibgeMunicipality || !/^\d{7}$/.test(ibgeMunicipality)) return undefined;
  return BY_IBGE.get(ibgeMunicipality.slice(0, 2))?.uf;
}

/**
 * NF-e product origin codes (tabela A do CST ICMS). 1, 2, 3 and 8 are foreign
 * goods or goods with more than 40% imported content: interstate sales of them
 * pay 4% (Resolução do Senado 13/2012). 6 and 7 are foreign goods without a
 * national similar (CAMEX list), which keep the normal interstate rate.
 */
export const IMPORTED_ORIGINS = new Set(['1', '2', '3', '8']);

/**
 * The interstate ICMS rate (Resolução do Senado 22/1989): 7% from the South
 * and Southeast (except Espírito Santo) to the North, Northeast, Center-West
 * and Espírito Santo; 12% on every other interstate operation; 4% on imported
 * goods (Resolução do Senado 13/2012).
 */
export function interstateIcmsRate(originUf: string, destinationUf: string, origin?: string | null): number {
  if (origin && IMPORTED_ORIGINS.has(origin)) return 4;
  const from = brState(originUf);
  const to = brState(destinationUf);
  if (!from || !to) return 12;
  const southSoutheast = (from.region === 'S' || from.region === 'SE') && from.uf !== 'ES';
  const lowerDestination = to.region === 'N' || to.region === 'NE' || to.region === 'CO' || to.uf === 'ES';
  return southSoutheast && lowerDestination ? 7 : 12;
}

/**
 * The ICMS rate of a sale of goods from `originUf` to `destinationUf`:
 * internal when both are the same state; interstate to an ICMS taxpayer; and
 * internal of the origin state to a final consumer who is not an ICMS
 * taxpayer only before EC 87/2015 — since 2016 that sale also uses the
 * interstate rate, with the difference (DIFAL) owed to the destination state.
 */
export function icmsRateForSale(args: {
  originUf: string;
  destinationUf?: string | null;
  origin?: string | null;
}): { rate: number; interstate: boolean; fcp: number } {
  const from = brState(args.originUf);
  const to = brState(args.destinationUf ?? args.originUf) ?? from;
  if (!from || !to || from.uf === to.uf) {
    return { rate: from?.icmsInternal ?? 0, interstate: false, fcp: from?.fcp ?? 0 };
  }
  return { rate: interstateIcmsRate(from.uf, to.uf, args.origin), interstate: true, fcp: 0 };
}
