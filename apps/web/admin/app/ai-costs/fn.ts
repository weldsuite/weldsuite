import { createServerFn } from '@tanstack/react-start';
import { loadAiCostsPage } from './data';
import { globalOnly } from '@/lib/edition';

/** The AI costs page's data, on the server. */
export const getAiCostsPage = createServerFn({ method: 'GET' }).middleware([globalOnly])
  .handler(() => loadAiCostsPage());
