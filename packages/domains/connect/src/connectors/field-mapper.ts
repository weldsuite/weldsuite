/**
 * Lightweight field mapper for connector custom mappings.
 * Mirrors the CRM FieldMapper: inbound overlays onto mapped.values.
 */

export interface ConnectorFieldMappingRow {
  externalFieldPath: string;
  internalFieldPath: string;
  direction: 'inbound' | 'outbound' | 'bidirectional';
  transformType: string;
  transformConfig?: Record<string, unknown> | null;
  isRequired?: boolean;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function applyTransform(
  value: unknown,
  transformType: string,
  config?: Record<string, unknown> | null,
): unknown {
  switch (transformType) {
    case 'lookup': {
      if (!config?.lookupTable || typeof config.lookupTable !== 'object') return value;
      const table = config.lookupTable as Record<string, unknown>;
      const strValue = String(value);
      return strValue in table ? table[strValue] : value;
    }
    case 'format_date': {
      if (!value) return value;
      const date = new Date(String(value));
      if (Number.isNaN(date.getTime())) return value;
      return date.toISOString();
    }
    default:
      return value;
  }
}

/**
 * Overlay inbound/bidirectional custom mappings onto the built-in mapped values.
 * Built-in mapper still owns identity (externalId, line items, etc.).
 */
export function applyInboundFieldMappings(
  externalRecord: Record<string, unknown>,
  mappedValues: Record<string, unknown>,
  mappings: ConnectorFieldMappingRow[],
): Record<string, unknown> {
  const inbound = mappings.filter(
    (m) => m.direction === 'inbound' || m.direction === 'bidirectional',
  );
  if (inbound.length === 0) return mappedValues;

  const result = { ...mappedValues };
  for (const mapping of inbound) {
    const value = getNestedValue(externalRecord, mapping.externalFieldPath);
    if (value === undefined || value === null) {
      if (mapping.isRequired) continue;
      continue;
    }
    const transformed = applyTransform(value, mapping.transformType, mapping.transformConfig);
    if (transformed === undefined || transformed === null || transformed === '') continue;
    setNestedValue(result, mapping.internalFieldPath, transformed);
  }
  return result;
}
