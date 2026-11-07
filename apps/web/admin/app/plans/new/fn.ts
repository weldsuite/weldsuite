import { createServerFn } from '@tanstack/react-start';
import { loadNewPlanPage } from './data';
import { globalOnly } from '@/lib/edition';

/** The new plan page's data, on the server. */
export const getNewPlanPage = createServerFn({ method: 'GET' }).middleware([globalOnly])
  .handler(() => loadNewPlanPage());
