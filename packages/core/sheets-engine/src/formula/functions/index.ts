/**
 * The built-in function library. Importing this module registers every
 * family with the registry the evaluator reads.
 */

import { datetimeFunctions } from './datetime';
import { financialFunctions } from './financial';
import { infoFunctions } from './info';
import { logicalFunctions } from './logical';
import { lookupFunctions } from './lookup';
import { mathFunctions } from './math';
import { pivotFunctions } from './pivot';
import { registerFunctions } from './registry';
import { statsFunctions } from './stats';
import { textFunctions } from './text';

registerFunctions([
  ...mathFunctions,
  ...statsFunctions,
  ...logicalFunctions,
  ...infoFunctions,
  ...textFunctions,
  ...datetimeFunctions,
  ...lookupFunctions,
  ...financialFunctions,
  ...pivotFunctions,
]);

export { functionNames, getFunction, registerFunctions } from './registry';
