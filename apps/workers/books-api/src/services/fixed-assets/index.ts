/**
 * Fixed assets and depreciation (WeldBooks US phase 8).
 *
 * The daily cron posts due depreciation with `runMonthlyDepreciation`:
 *
 *   import { runMonthlyDepreciation, lastCompletedMonthEnd } from '../services/fixed-assets';
 *   const runs = await runMonthlyDepreciation(db, { through: lastCompletedMonthEnd(today) });
 */

export * from './assets';
export * from './books';
export * from './depreciation-run';
export * from './disposal';
export * from './reports';
export { FixedAssetError, isLedgerError } from './shared';
