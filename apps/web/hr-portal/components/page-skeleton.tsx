/** Content-area skeleton shown while a portal page's data streams in. */
export function PageSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-live="polite">
      <div className="h-7 w-48 rounded-md bg-gray-200" />
      <div className="h-24 rounded-lg border border-gray-200 bg-white" />
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-32 rounded-lg border border-gray-200 bg-white p-4">
            <div className="h-4 w-1/3 rounded bg-gray-200" />
            <div className="mt-4 h-3 w-2/3 rounded bg-gray-100" />
            <div className="mt-2 h-3 w-1/2 rounded bg-gray-100" />
          </div>
        ))}
      </div>
    </div>
  );
}
