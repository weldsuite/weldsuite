import { useMenu } from '../components/menu';
import { ShopLink } from '../components/shop-link';
import { useShop } from '../context';
import { safeLink } from '../links';
import { RichText } from '../markdown';
import { sectionSettings } from '../settings';
import type { SocialLinks } from '../types';
import type { SectionProps } from './types';

const NETWORKS: Array<keyof SocialLinks> = ['instagram', 'facebook', 'x', 'linkedin', 'tiktok', 'youtube', 'pinterest'];

function SocialList() {
  const { shop } = useShop();
  const links = NETWORKS.flatMap((network) => {
    const link = safeLink(shop.theme.social?.[network]);
    return link?.external ? [{ network, href: link.href }] : [];
  });
  if (links.length === 0) return null;
  const s = shop.strings.nav;
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">{s.social}</h2>
      <ul className="flex flex-wrap gap-x-4 gap-y-2">
        {links.map(({ network, href }) => (
          <li key={network}>
            <a href={href} rel="noopener noreferrer" className="underline-offset-4 hover:underline">
              {s.socialNetworks[network]}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The shop's footer: menu, text, social links, the price note and the copyright line. */
export function Footer({ section, attributes }: Readonly<SectionProps>) {
  const { shop } = useShop();
  const settings = sectionSettings(section.type, section.settings);
  const items = useMenu(settings.text('menu') || 'footer');
  const year = new Date().getFullYear();
  return (
    <footer {...attributes} className="mt-auto border-t border-shop-border bg-shop-muted text-shop-on-muted">
      <div className="shop-container grid gap-10 py-12 md:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-6">
          <RichText source={settings.text('text')} baseLevel={3} />
          {items.length > 0 ? (
            <nav aria-label={shop.strings.nav.footer}>
              <ul className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
                {items.map((item) => (
                  <li key={item.id}>
                    <ShopLink href={item.href} className="underline-offset-4 hover:underline">
                      {item.label}
                    </ShopLink>
                    {item.children.length > 0 ? (
                      <ul className="mt-2 flex flex-col gap-2 ps-4">
                        {item.children.map((child) => (
                          <li key={child.id}>
                            <ShopLink href={child.href} className="underline-offset-4 hover:underline">
                              {child.label}
                            </ShopLink>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
        </div>
        {settings.bool('showSocial') ? <SocialList /> : null}
      </div>
      <div className="shop-container flex flex-col gap-2 border-t border-shop-border py-6 text-sm sm:flex-row sm:justify-between">
        <p>
          © {year} {shop.name}
        </p>
        {settings.bool('showLocaleNote') && shop.showPrices ? (
          <p>{shop.channel.pricesIncludeTax ? shop.strings.price.noteInclVat : shop.strings.price.noteExclVat}</p>
        ) : null}
      </div>
    </footer>
  );
}
