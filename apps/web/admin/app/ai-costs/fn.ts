import { createServerFn } from '@tanstack/react-start';
import { loadAiCostsPage } from './data';

/** The AI costs page's data, on the server. */
export const getAiCostsPage = createServerFn({ method: 'GET' })
  .handler(() => loadAiCostsPage());
