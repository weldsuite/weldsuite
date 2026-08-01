import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldobjects/list-page';

/**
 * WeldObjects record list.
 *
 * One route file serves EVERY custom object a workspace ever creates —
 * `$slug` is resolved at request time, so adding an object needs no route,
 * no codegen and no deploy.
 */
export const Route = createFileRoute('/objects/$slug/')({
  component: PageComponent,
});
