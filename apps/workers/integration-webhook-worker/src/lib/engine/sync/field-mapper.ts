/**
 * CRM Sync Engine — Field Mapper
 *
 * Maps fields between WeldSuite entities and external CRM records
 * using configurable per-field mappings with transform support.
 */

import type { FieldMappingDefinition } from './types';

/**
 * Get a nested value from an object using dot-notation path.
 * e.g., getNestedValue({ a: { b: 'c' } }, 'a.b') → 'c'
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Set a nested value on an object using dot-notation path.
 * Creates intermediate objects as needed.
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Apply a transform to a value.
 */
function applyTransform(
  value: unknown,
  transformType: string,
  config?: Record<string, unknown>,
): unknown {
  switch (transformType) {
    case 'direct':
      return value;

    case 'lookup': {
      if (!config?.lookupTable || typeof config.lookupTable !== 'object') return value;
      const table = config.lookupTable as Record<string, unknown>;
      const strValue = String(value);
      return strValue in table ? table[strValue] : value;
    }

    case 'format_date': {
      if (!value) return value;
      // Normalize date strings to ISO format
      const date = new Date(String(value));
      if (isNaN(date.getTime())) return value;
      return date.toISOString();
    }

    case 'custom':
      // Custom transforms return value as-is — override in subclass if needed
      return value;

    default:
      return value;
  }
}

/**
 * Reverse a lookup transform (swap keys and values in the lookup table).
 */
function reverseTransform(
  value: unknown,
  transformType: string,
  config?: Record<string, unknown>,
): unknown {
  switch (transformType) {
    case 'lookup': {
      if (!config?.lookupTable || typeof config.lookupTable !== 'object') return value;
      const table = config.lookupTable as Record<string, unknown>;
      const reversed: Record<string, string> = {};
      for (const [k, v] of Object.entries(table)) {
        reversed[String(v)] = k;
      }
      const strValue = String(value);
      return strValue in reversed ? reversed[strValue] : value;
    }

    default:
      return applyTransform(value, transformType, config);
  }
}

export class FieldMapper {
  private inboundMappings: FieldMappingDefinition[];
  private outboundMappings: FieldMappingDefinition[];

  constructor(mappings: FieldMappingDefinition[]) {
    this.inboundMappings = mappings.filter(
      m => m.direction === 'inbound' || m.direction === 'bidirectional'
    );
    this.outboundMappings = mappings.filter(
      m => m.direction === 'outbound' || m.direction === 'bidirectional'
    );
  }

  /**
   * Map external CRM data to internal WeldSuite fields (inbound).
   */
  mapToInternal(externalData: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const mapping of this.inboundMappings) {
      const value = getNestedValue(externalData, mapping.externalFieldPath);
      if (value === undefined && !mapping.isRequired) continue;

      const transformed = applyTransform(value, mapping.transformType, mapping.transformConfig);
      setNestedValue(result, mapping.internalFieldPath, transformed);
    }

    return result;
  }

  /**
   * Map internal WeldSuite data to external CRM fields (outbound).
   */
  mapToExternal(internalData: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const mapping of this.outboundMappings) {
      const value = getNestedValue(internalData, mapping.internalFieldPath);
      if (value === undefined && !mapping.isRequired) continue;

      const transformed = reverseTransform(value, mapping.transformType, mapping.transformConfig);
      setNestedValue(result, mapping.externalFieldPath, transformed);
    }

    return result;
  }

  /**
   * Detect which fields differ between internal and external data.
   * Returns the list of internal field paths that have conflicting values.
   * Only checks bidirectional mappings.
   */
  detectConflicts(
    internalData: Record<string, unknown>,
    externalData: Record<string, unknown>,
  ): string[] {
    const conflicts: string[] = [];
    const bidirectionalMappings = this.inboundMappings.filter(
      m => m.direction === 'bidirectional'
    );

    for (const mapping of bidirectionalMappings) {
      const internalValue = getNestedValue(internalData, mapping.internalFieldPath);
      const externalValue = getNestedValue(externalData, mapping.externalFieldPath);
      const transformedExternal = applyTransform(
        externalValue,
        mapping.transformType,
        mapping.transformConfig,
      );

      // Simple equality check (stringify for deep comparison)
      if (JSON.stringify(internalValue) !== JSON.stringify(transformedExternal)) {
        conflicts.push(mapping.internalFieldPath);
      }
    }

    return conflicts;
  }
}
