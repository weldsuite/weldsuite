/**
 * Consumers use different Drizzle drivers (neon-http in app-api, postgres-js
 * over Hyperdrive in billing-worker) whose client types are incompatible
 * generics over the same runtime query API — the same reason
 * `@weldsuite/credits` types its handle loosely.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PartnerDb = any;
