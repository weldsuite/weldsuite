import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { loadWeldFormsPage } from './data';

/** The WeldForms moderation page for the filter in the search params, on the server. */
export const getWeldFormsPage = createServerFn({ method: 'GET' })
  .validator(z.object({ status: z.string() }).partial())
  .handler(({ data }) => loadWeldFormsPage(data));
