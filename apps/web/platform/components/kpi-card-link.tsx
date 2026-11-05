import { KpiCard, type KpiCardProps } from '@weldsuite/ui/components/kpi-card';
import { Link } from '@/lib/router';

/**
 * The library's `KpiCard` as a link into the platform's router. Without an
 * `href` (for example when the user cannot open the target) it is a plain tile.
 */
export function KpiCardLink({ href, ...props }: Readonly<Omit<KpiCardProps, 'interactive'> & { href?: string }>) {
  const card = <KpiCard {...props} interactive={Boolean(href)} />;
  if (!href) return card;
  return (
    <Link
      href={href}
      className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {card}
    </Link>
  );
}
