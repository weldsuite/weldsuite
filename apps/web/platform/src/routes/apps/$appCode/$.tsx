import { createFileRoute } from '@tanstack/react-router';

/** Catch-all for `/apps/{code}/…` sidebar section paths. */
export const Route = createFileRoute('/apps/$appCode/$')({
  component: () => null,
});
