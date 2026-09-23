function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

const TONE_CLASSES: Record<'neutral' | 'positive' | 'warning' | 'negative' | 'info', string> = {
  neutral: 'bg-gray-100 text-gray-700',
  positive: 'bg-emerald-100 text-emerald-800',
  warning: 'bg-amber-100 text-amber-800',
  negative: 'bg-red-100 text-red-800',
  info: 'bg-blue-100 text-blue-800',
};

export function Badge({ tone = 'neutral', className, children }: { tone?: keyof typeof TONE_CLASSES; className?: string; children: React.ReactNode }) {
  return (
    <span className={cx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', TONE_CLASSES[tone], className)}>
      {children}
    </span>
  );
}
