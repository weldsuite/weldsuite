import { Loader2, Signal, SignalHigh, SignalLow, SignalMedium, WifiOff } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';
import type { ConnectionLevel, ConnectionQuality } from '../hooks/use-connection-quality';

export interface ConnectionIndicatorLabels {
  /** Tooltip heading, e.g. "Connection". */
  connection: string;
  good: string;
  fair: string;
  poor: string;
  reconnecting: string;
  offline: string;
  /** Before the first score arrives, e.g. "Checking connection…". */
  unknown: string;
  /** Packet-loss line in the tooltip; `{value}` is replaced by the percentage. */
  packetLoss: string;
}

export const DEFAULT_CONNECTION_INDICATOR_LABELS: ConnectionIndicatorLabels = {
  connection: 'Connection',
  good: 'Good',
  fair: 'Unstable',
  poor: 'Poor',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
  unknown: 'Checking connection…',
  packetLoss: 'Packet loss {value}%',
};

const ICON: Record<ConnectionLevel, typeof Signal> = {
  good: SignalHigh,
  fair: SignalMedium,
  poor: SignalLow,
  reconnecting: Loader2,
  offline: WifiOff,
  unknown: Signal,
};

const TONE: Record<ConnectionLevel, string> = {
  good: 'text-green-600 dark:text-green-500',
  fair: 'text-amber-600 dark:text-amber-400',
  poor: 'text-red-600 dark:text-red-400',
  reconnecting: 'text-amber-600 dark:text-amber-400',
  offline: 'text-red-600 dark:text-red-400',
  unknown: 'text-muted-foreground',
};

export interface ConnectionIndicatorProps {
  quality: ConnectionQuality;
  labels?: Partial<ConnectionIndicatorLabels>;
  className?: string;
}

/**
 * Signal bars for the local connection, Discord-style: quiet while it is
 * good, with a short label once it is not, so a lagging voice has a visible
 * reason. Hover for the score's detail.
 */
export function ConnectionIndicator({ quality, labels, className }: Readonly<ConnectionIndicatorProps>) {
  const l = { ...DEFAULT_CONNECTION_INDICATOR_LABELS, ...labels };
  const { level, packetLossPercent } = quality;
  const Icon = ICON[level];
  const state = l[level];
  const details = [`${l.connection}: ${state}`];
  if (packetLossPercent !== null && packetLossPercent > 0) {
    details.push(l.packetLoss.replace('{value}', String(packetLossPercent)));
  }
  const showLabel = level === 'fair' || level === 'poor' || level === 'reconnecting' || level === 'offline';

  return (
    <output
      aria-live="polite"
      aria-label={details.join(', ')}
      title={details.join(' · ')}
      data-level={level}
      className={cn('flex items-center gap-1 text-[11px] font-medium flex-shrink-0', TONE[level], className)}
    >
      <Icon className={cn('h-4 w-4', level === 'reconnecting' && 'animate-spin')} aria-hidden />
      {showLabel && <span>{state}</span>}
    </output>
  );
}
