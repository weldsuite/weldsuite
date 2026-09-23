'use client';

import { useI18n } from '@/lib/i18n';

export function PortalNotAvailable() {
  const { dict } = useI18n();
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-sm text-center space-y-2">
        <h1 className="text-xl font-semibold text-gray-900">{dict.common.notAvailableTitle}</h1>
        <p className="text-sm text-gray-500">{dict.common.notAvailableBody}</p>
      </div>
    </main>
  );
}
