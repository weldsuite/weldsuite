import type { CSSProperties } from 'react';
import type { TeamMember } from '@/lib/api/types';
import { cn } from '@/lib/utils/cn';

/** Black or white, whichever reads better on the brand color. */
export function readableOn(hex: string): string {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const n = Number.parseInt(full.slice(0, 6), 16);
  if (Number.isNaN(n)) return '#ffffff';
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.5 ? '#111827' : '#ffffff';
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

const AVATAR_COLORS = ['#4F46E5', '#7C3AED', '#DB2777', '#EA580C', '#16A34A', '#0891B2', '#2563EB'];

function colorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function Avatar({
  name,
  src,
  size = 32,
  className,
  style,
}: {
  name: string;
  src?: string | null;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const dimension = { width: size, height: size, ...style };
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={cn('rounded-full object-cover flex-shrink-0', className)}
        style={dimension}
      />
    );
  }
  return (
    <div
      aria-label={name}
      className={cn('rounded-full flex items-center justify-center text-white font-semibold flex-shrink-0', className)}
      style={{ ...dimension, backgroundColor: colorFor(name), fontSize: Math.round(size * 0.42) }}
    >
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

/** Overlapping teammate faces, as in the messenger header. */
export function AvatarStack({ team, size = 32, ring = '#ffffff' }: { team: TeamMember[]; size?: number; ring?: string }) {
  if (team.length === 0) return null;
  return (
    <div className="flex -space-x-2">
      {team.slice(0, 3).map((member, i) => (
        <Avatar
          key={`${member.name}-${i}`}
          name={member.name}
          src={member.avatar}
          size={size}
          style={{ boxShadow: `0 0 0 2px ${ring}`, zIndex: 3 - i }}
        />
      ))}
    </div>
  );
}

export function TypingDots({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1', className)} aria-label="Typing">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-gray-400 animate-bounce"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}

export function Branding() {
  return (
    <a
      href="https://welddesk.org"
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-center justify-center gap-1 py-2 text-[11px] text-gray-400 hover:text-gray-600 transition-colors"
    >
      Powered by
      <img
        src="/welddesk-logo.svg"
        alt="WeldDesk"
        className="h-3 grayscale opacity-60 group-hover:grayscale-0 group-hover:opacity-100 transition-all"
      />
    </a>
  );
}
