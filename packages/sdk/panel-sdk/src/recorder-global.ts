/** Entry of `dist/panel-recorder.global.js`, served by the collector as `/rec.js`: hands the core the recorder factory. */

import { createRecorder } from './recorder';
import { RECORDER_GLOBAL, type RecorderFactory } from './recorder-api';

(window as unknown as Record<string, RecorderFactory>)[RECORDER_GLOBAL] = createRecorder;
