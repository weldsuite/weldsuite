/**
 * Typed catalog of every feature flag in WeldSuite.
 *
 * Adding a flag is a two-step process:
 *   1. Declare it here with its type + default.
 *   2. Create the matching flag in the Cloudflare Flagship dashboard
 *      (https://developers.cloudflare.com/flagship/) — same key, same type.
 *
 * Referencing a typo'd key becomes a TypeScript error, and the server-side
 * evaluator falls back to the `default` declared here whenever Flagship can't
 * resolve the flag (binding absent in local dev, brand-new flag not yet
 * created in the dashboard, evaluation error, etc.).
 */

export const FLAGS = {
  // Demo flag — kept until at least one real flag exists. Safe to remove
  // once the first production flag lands.
  'hello-world': { type: 'boolean', default: false },
  // RNNoise noise suppression in WeldMeet web.
  'weldmeet-noise-suppression': { type: 'boolean', default: true },
  // Sidebar "Upgrade" button in the platform module sidebar. Hidden by
  // default — turned on per-segment (plan / role / %-rollout) in Flagship.
  'upgrade-button': { type: 'boolean', default: false },
  // WeldFlow "Move to project" action (task list row + detail panel). Hidden
  // by default — rolled out gradually per user / %-rollout in Flagship.
  'weldflow-move-task': { type: 'boolean', default: false },
} as const satisfies Record<string, FlagDefinition>;

export type FlagDefinition =
  | { type: 'boolean'; default: boolean }
  | { type: 'string'; default: string }
  | { type: 'number'; default: number }
  | { type: 'json'; default: unknown };

export type FlagKey = keyof typeof FLAGS;

export type FlagValue<K extends FlagKey> = (typeof FLAGS)[K] extends {
  default: infer D;
}
  ? D
  : never;

export function getFlagDefault<K extends FlagKey>(key: K): FlagValue<K> {
  return FLAGS[key].default as FlagValue<K>;
}
