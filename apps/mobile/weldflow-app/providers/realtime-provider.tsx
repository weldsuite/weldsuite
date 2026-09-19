import React from 'react';
import { MobileRealtimeProvider } from '@weldsuite/mobile-realtime';

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  return <MobileRealtimeProvider>{children}</MobileRealtimeProvider>;
}
