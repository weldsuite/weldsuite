import { ShopLink } from '../components/shop-link';
import { useShop } from '../context';
import { RichText } from '../markdown';
import { sectionSettings } from '../settings';
import type { SectionProps } from './types';

/** The 404 page: a heading, a text (the theme's own unless the merchant wrote one) and a way on. */
export function MainNotFound({ section, attributes }: Readonly<SectionProps>) {
  const { shop } = useShop();
  const settings = sectionSettings(section.type, section.settings);
  const s = shop.strings.notFound;
  const text = settings.text('text');
  return (
    <section {...attributes} aria-labelledby="not-found-title" className="shop-container shop-section flex max-w-2xl flex-col items-start gap-5">
      <h1 id="not-found-title" className="text-3xl font-semibold md:text-4xl">
        {settings.text('heading').trim() || s.title}
      </h1>
      {text.trim() ? <RichText source={text} /> : <p>{s.text}</p>}
      <ShopLink href="/" className="shop-btn shop-btn-primary">
        {s.home}
      </ShopLink>
    </section>
  );
}
