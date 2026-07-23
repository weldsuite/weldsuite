// Project labels (created in project settings) store colors as Tailwind class names (e.g. "bg-blue-500"),
// while inline-created labels store hex values. Resolve to a CSS color so the badge always renders correctly.
const TAILWIND_LABEL_TO_HEX: Record<string, string> = {
  'bg-red-500': '#ef4444',
  'bg-pink-500': '#ec4899',
  'bg-purple-500': '#a855f7',
  'bg-indigo-500': '#6366f1',
  'bg-blue-500': '#3b82f6',
  'bg-cyan-500': '#06b6d4',
  'bg-teal-500': '#14b8a6',
  'bg-green-500': '#22c55e',
  'bg-yellow-500': '#eab308',
  'bg-orange-500': '#f97316',
  'bg-amber-500': '#f59e0b',
  'bg-gray-500': '#6b7280',
};

export function resolveLabelColor(color: string | null | undefined): string {
  if (!color) return '#6b7280';
  if (color.startsWith('#')) return color;
  return TAILWIND_LABEL_TO_HEX[color] ?? '#6b7280';
}
