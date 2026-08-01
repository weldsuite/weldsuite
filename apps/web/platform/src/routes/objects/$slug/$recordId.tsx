import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldobjects/record-page';

/** WeldObjects record detail — generic over every custom object. */
export const Route = createFileRoute('/objects/$slug/$recordId')({
  component: PageComponent,
});
