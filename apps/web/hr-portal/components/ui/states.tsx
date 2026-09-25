'use client';

import { useI18n } from '@/lib/i18n';

export function Spinner({ className }: Readonly<{ className?: string }>) {
  return (
    <svg
      className={`animate-spin ${className ?? 'h-5 w-5'}`}
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label="Loading"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export function LoadingState() {
  const { dict } = useI18n();
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-gray-500">
      <Spinner className="h-5 w-5" />
      <span className="text-sm">{dict.common.loading}</span>
    </div>
  );
}

export function ErrorState({ message, onRetry }: Readonly<{ message?: string; onRetry?: () => void }>) {
  const { dict } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <p className="text-sm text-gray-700">{message || dict.common.error}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="text-sm font-medium portal-link underline underline-offset-2"
        >
          {dict.common.retry}
        </button>
      )}
    </div>
  );
}

export function EmptyState({ message }: Readonly<{ message: string }>) {
  return <p className="py-8 text-center text-sm text-gray-500">{message}</p>;
}
