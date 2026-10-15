/**
 * Brazil's 27 federative units (UF) with their IBGE code (the first two digits
 * of a municipality code). Names are proper nouns and are not translated.
 *
 * Mirrors `BR_STATES` in `@weldsuite/books-domain/jurisdictions/br/states` (the
 * platform doesn't import the domain package); `br-states.test.ts` fails when
 * the two drift apart. A Brazilian address stores the two-letter UF.
 */
export interface BrState {
  uf: string;
  name: string;
  /** IBGE state code (2 digits). */
  ibge: string;
}

export const BR_STATES: ReadonlyArray<BrState> = [
  { uf: 'AC', name: 'Acre', ibge: '12' },
  { uf: 'AL', name: 'Alagoas', ibge: '27' },
  { uf: 'AP', name: 'Amapá', ibge: '16' },
  { uf: 'AM', name: 'Amazonas', ibge: '13' },
  { uf: 'BA', name: 'Bahia', ibge: '29' },
  { uf: 'CE', name: 'Ceará', ibge: '23' },
  { uf: 'DF', name: 'Distrito Federal', ibge: '53' },
  { uf: 'ES', name: 'Espírito Santo', ibge: '32' },
  { uf: 'GO', name: 'Goiás', ibge: '52' },
  { uf: 'MA', name: 'Maranhão', ibge: '21' },
  { uf: 'MT', name: 'Mato Grosso', ibge: '51' },
  { uf: 'MS', name: 'Mato Grosso do Sul', ibge: '50' },
  { uf: 'MG', name: 'Minas Gerais', ibge: '31' },
  { uf: 'PA', name: 'Pará', ibge: '15' },
  { uf: 'PB', name: 'Paraíba', ibge: '25' },
  { uf: 'PR', name: 'Paraná', ibge: '41' },
  { uf: 'PE', name: 'Pernambuco', ibge: '26' },
  { uf: 'PI', name: 'Piauí', ibge: '22' },
  { uf: 'RJ', name: 'Rio de Janeiro', ibge: '33' },
  { uf: 'RN', name: 'Rio Grande do Norte', ibge: '24' },
  { uf: 'RS', name: 'Rio Grande do Sul', ibge: '43' },
  { uf: 'RO', name: 'Rondônia', ibge: '11' },
  { uf: 'RR', name: 'Roraima', ibge: '14' },
  { uf: 'SC', name: 'Santa Catarina', ibge: '42' },
  { uf: 'SP', name: 'São Paulo', ibge: '35' },
  { uf: 'SE', name: 'Sergipe', ibge: '28' },
  { uf: 'TO', name: 'Tocantins', ibge: '17' },
];

function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The state for a UF or a name ("SP", "São Paulo", "sao paulo"); undefined when nothing matches. */
export function findBrState(value: string | null | undefined): BrState | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const upper = text.toUpperCase().replace(/^BR[-\s]/, '');
  const byUf = BR_STATES.find((s) => s.uf === upper);
  if (byUf) return byUf;
  const folded = fold(text);
  return BR_STATES.find((s) => fold(s.name) === folded);
}

/** The UF an address should store for what the user typed or an older record holds, else the value as it is. */
export function toBrUf(value: string | null | undefined): string {
  return findBrState(value)?.uf ?? value?.trim() ?? '';
}
