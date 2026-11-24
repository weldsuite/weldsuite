import { safeLink } from '../links';
import { ShopLink } from './shop-link';

/** The button a section's `buttonLabel` and `buttonLink` describe; nothing without both. */
export function ButtonLink({
  label,
  href,
  variant = 'primary',
}: Readonly<{ label: string; href: string; variant?: 'primary' | 'secondary' }>) {
  if (label.trim() === '' || !safeLink(href)) return null;
  return (
    <ShopLink href={href} className={variant === 'primary' ? 'shop-btn shop-btn-primary' : 'shop-btn shop-btn-secondary'}>
      {label}
    </ShopLink>
  );
}
