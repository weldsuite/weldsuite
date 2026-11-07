import { createServerFn } from '@tanstack/react-start';
import { loadNewPlanPage } from './data';

/** The new plan page's data, on the server. */
export const getNewPlanPage = createServerFn({ method: 'GET' })
  .handler(() => loadNewPlanPage());
