/** Entry of `dist/panel-vitals.global.js`, served by the collector as `/v.js`: hands the core the web vitals factory. */

import { watchVitals } from './vitals';
import { VITALS_GLOBAL, type VitalsFactory } from './vitals-api';

(window as unknown as Record<string, VitalsFactory>)[VITALS_GLOBAL] = watchVitals;
