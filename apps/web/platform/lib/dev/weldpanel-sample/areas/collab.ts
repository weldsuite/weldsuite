/**
 * WeldPanel sample data for definitions, collaboration, sharing, monitoring
 * and data out. The work is split over `collab-definitions.ts` (custom events,
 * computed properties, path rules, annotations, comments, report versions,
 * metric trees, share links) and `collab-monitor.ts` (alerts, subscriptions,
 * exports, collector domains).
 */

import { UNHANDLED, type SampleAreaHandler } from '../request';
import { handleDefinitions } from './collab-definitions';
import { handleMonitor } from './collab-monitor';

export const handleCollab: SampleAreaHandler = (request) => {
  const definitions = handleDefinitions(request);
  if (definitions !== UNHANDLED) return definitions;
  return handleMonitor(request);
};
