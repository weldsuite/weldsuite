'use client';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="flex max-w-xl flex-col items-start gap-4">
      <h1 className="text-3xl font-semibold">Something went wrong</h1>
      <p>We couldn&apos;t load this page. Try again in a moment.</p>
      <button type="button" className="btn btn-primary" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
