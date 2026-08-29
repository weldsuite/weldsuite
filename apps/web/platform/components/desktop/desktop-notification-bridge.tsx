'use client';

import { useEffect } from 'react';
import { useRouter } from '@/lib/router';
import { onOsNotificationClick } from '@/lib/desktop-notifications';
import { isDesktop } from '@/lib/desktop';

/**
 * Desktop-only bridge: navigate on OS toast click.
 * Focus / flash clearing lives in UnifiedNotificationProvider next to badge sync.
 */
export function DesktopNotificationBridge() {
  const router = useRouter();

  useEffect(() => {
    if (!isDesktop()) return;

    return onOsNotificationClick((payload) => {
      const actionUrl = payload.actionUrl?.trim();
      if (!actionUrl) return;
      // Only allow in-app paths — never open arbitrary URLs from a toast.
      if (!actionUrl.startsWith('/') || actionUrl.startsWith('//')) return;
      router.push(actionUrl);
    });
  }, [router]);

  return null;
}
