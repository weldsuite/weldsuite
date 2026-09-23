import type { PortalConfig } from '@/lib/types';

/* eslint-disable @next/next/no-img-element -- logo URL is workspace-controlled and not in next.config's image domains allowlist */
export function PortalLogo({ config, size = 40 }: { config: PortalConfig; size?: number }) {
  if (config.logoUrl) {
    return (
      <img
        src={config.logoUrl}
        alt={config.displayName ?? ''}
        width={size}
        height={size}
        className="rounded object-contain"
        style={{ width: size, height: size }}
      />
    );
  }
  const initial = config.displayName?.trim()?.[0]?.toUpperCase() || 'W';
  return (
    <div
      className="portal-btn-primary flex items-center justify-center rounded text-white font-semibold"
      style={{ width: size, height: size, fontSize: size * 0.45 }}
      aria-hidden="true"
    >
      {initial}
    </div>
  );
}
