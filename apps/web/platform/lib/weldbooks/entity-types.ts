/** Every legal entity type WeldBooks knows (values of `entities.entity_type`). */
export const ENTITY_TYPES = [
  'bv',
  'nv',
  'vof',
  'sole',
  'pvt_ltd',
  'llp',
  'llc',
  's_corp',
  'c_corp',
  'partnership',
  'gmbh',
  'ag',
  'ltd',
  'inc',
  'sarl',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

const BY_JURISDICTION: Record<string, readonly EntityType[]> = {
  NL: ['bv', 'nv', 'vof', 'sole'],
  IN: ['pvt_ltd', 'llp', 'sole'],
  US: ['llc', 's_corp', 'c_corp', 'partnership', 'sole'],
};

export function isEntityType(value: string | null | undefined): value is EntityType {
  return !!value && (ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * Entity types to offer for a jurisdiction; every type for one WeldBooks has
 * no list for. The current value is always included so it never disappears.
 */
export function entityTypesFor(jurisdictionCode: string | null | undefined, current?: string | null): EntityType[] {
  const list = BY_JURISDICTION[jurisdictionCode?.toUpperCase() ?? ''] ?? ENTITY_TYPES;
  const result: EntityType[] = [...list];
  if (isEntityType(current) && !result.includes(current)) result.push(current);
  return result;
}
