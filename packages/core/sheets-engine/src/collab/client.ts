/**
 * The browser half of co-editing for a spreadsheet. The protocol logic is
 * @weldsuite/collab's `CollabClient`; this class runs it on a sheets engine
 * and keeps the options the platform passes.
 */

import * as collab from '@weldsuite/collab';
import type { Engine, EngineOptions } from '../calc/engine';
import type { WorkbookSnapshot } from '../model/workbook';
import type { Op } from '../ops/types';
import { sheetsAdapter, type Presence } from './adapter';

export interface CollabClientOptions extends collab.CollabClientOptions<Engine, Op, Presence> {
  engine?: EngineOptions;
}

export class CollabClient extends collab.CollabClient<Engine, Op, WorkbookSnapshot, Presence> {
  constructor(options: CollabClientOptions) {
    super(sheetsAdapter(options.engine), options);
  }

  /** The local workbook, null until the room's welcome arrives. */
  get engine(): Engine | null {
    return this.state;
  }
}
