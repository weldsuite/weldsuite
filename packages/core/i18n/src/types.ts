/**
 * Auto-inferred translation types with full type safety
 *
 * Types are automatically inferred from the actual translation objects.
 * No build step required - TypeScript infers types directly from the source files!
 *
 * How it works:
 * 1. Import the EN locale as the reference (typeof en)
 * 2. TypeScript automatically infers all nested keys and types
 * 3. All translation keys are fully type-safe with autocomplete
 * 4. Changes to translations automatically update types - no manual maintenance!
 */

// Import the actual translation object to infer types from
import type { en } from './locales/en';

// Import Language from the central registry (single source of truth)
export type { Language } from './locales/index';

// Automatically infer the complete type from EN translations
export type TranslationsType = typeof en;

// Namespace mapping for type-safe access (inferred from en)
export type TranslationNamespaces = typeof en;

// Whole-translations alias — kept under the historical "CommonTranslations" name for
// back-compat with sidebar.tsx / user-menu.tsx, which index into it via ['navigation'].
// Equivalent to TranslationsType / TranslationNamespaces.
export type CommonTranslations = typeof en;

// Utility types for type-safe translations
export type TranslationKey<T extends keyof TranslationNamespaces> = keyof TranslationNamespaces[T];

// Helper to get deeply nested keys as dot-notation paths with depth limit
type PathsToStringProps<T, Depth extends number = 7> = [Depth] extends [never]
  ? []
  : T extends string
  ? []
  : {
      [K in Extract<keyof T, string>]: [K, ...PathsToStringProps<T[K], Prev[Depth]>];
    }[Extract<keyof T, string>];

// Depth counter for recursion limit
type Prev = [never, 0, 1, 2, 3, 4, 5, 6, 7, ...0[]];

type Join<T extends string[], D extends string = '.'> = T extends []
  ? never
  : T extends [infer F]
  ? F
  : T extends [infer F, ...infer R]
  ? F extends string
    ? R extends string[]
      ? `${F}${D}${Join<R, D>}`
      : never
    : never
  : string;

// Generate all possible translation paths (e.g., "wms.orders.title")
export type TranslationPath = {
  [NS in keyof TranslationNamespaces]: Join<PathsToStringProps<TranslationNamespaces[NS]>> extends never
    ? never
    : `${NS & string}.${Join<PathsToStringProps<TranslationNamespaces[NS]>>}`;
}[keyof TranslationNamespaces];

// Get the value type for a specific namespace and key
export type GetTranslationValue<
  NS extends keyof TranslationNamespaces,
  K extends keyof TranslationNamespaces[NS]
> = TranslationNamespaces[NS][K];

// Helper type to extract parameters from translation functions
export type TranslationParams<T> = T extends (params: infer P) => string ? P : never;

// ============================================================================
// Server-Side Prop Passing Types
// ============================================================================

/**
 * Type for complete translations object (all namespaces)
 * Use when passing full translations from server to client component
 *
 * @example
 * // Server component
 * const translations = await getTranslations('wms');
 *
 * // Client component props
 * interface Props {
 *   translations: NamespaceTranslations<'wms'>;
 * }
 */
export type NamespaceTranslations<T extends keyof TranslationNamespaces> = TranslationNamespaces[T];

/**
 * Type for multiple namespaces combined
 * Use when a component needs translations from multiple namespaces
 *
 * @example
 * interface Props {
 *   translations: MultiNamespaceTranslations<'wms' | 'common'>;
 * }
 */
export type MultiNamespaceTranslations<T extends keyof TranslationNamespaces> = {
  [K in T]: TranslationNamespaces[K];
};

/**
 * Type for translation prop with specific namespace
 * Most common pattern for component props
 *
 * @example
 * interface DataTableProps {
 *   t: TranslationProp<'wms'>;
 * }
 */
export type TranslationProp<T extends keyof TranslationNamespaces> = NamespaceTranslations<T>;

/**
 * Type for optional translation prop
 * Use when translations are optional (component has defaults)
 *
 * @example
 * interface ButtonProps {
 *   t?: OptionalTranslationProp<'common'>;
 * }
 */
export type OptionalTranslationProp<T extends keyof TranslationNamespaces> = NamespaceTranslations<T> | undefined;

/**
 * Union type of all available namespace names
 * Use for dynamic namespace selection
 */
export type NamespaceName = keyof TranslationNamespaces;

/**
 * Helper to get a specific section of translations
 * Use for deeply nested translation objects
 *
 * @example
 * type OrderTranslations = TranslationSection<'wms', 'orders'>;
 */
export type TranslationSection<
  NS extends keyof TranslationNamespaces,
  Section extends keyof TranslationNamespaces[NS]
> = TranslationNamespaces[NS][Section];

/**
 * Complete translations object (all namespaces)
 * Rarely needed - prefer specific namespace types
 */
export type AllTranslations = TranslationNamespaces;
