import { createFileRoute, Link } from '@tanstack/react-router';

export const Route = createFileRoute('/$')({
  component: NotFoundPage,
});

function NotFoundPage() {
  return (
    <div className="flex flex-1 w-full h-full min-h-full items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold">404</h1>
        <p className="mt-2 text-muted-foreground">Page not found</p>
        <Link to="/" className="mt-4 inline-block text-primary underline">
          Go home
        </Link>
      </div>
    </div>
  );
}
