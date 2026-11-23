import { Heading } from '../components/heading';
import { COLOR_SCHEMES, schemeClass } from '../components/scheme';
import { blockSettings, sectionSettings } from '../settings';
import { headingId, type SectionProps } from './types';

/** Quotes from customers (one block each). */
export function Testimonials({ section, attributes, headingLevel, list }: Readonly<SectionProps>) {
  const settings = sectionSettings(section.type, section.settings);
  const quotes = (section.blocks ?? [])
    .filter((block) => block.type === 'quote')
    .map((block) => ({ id: block.id, values: blockSettings(section.type, block.type, block.settings) }))
    .filter(({ values }) => values.text('quote').trim() !== '');
  if (quotes.length === 0) return null;
  const heading = settings.text('heading').trim();
  const labelId = headingId({ list, section });
  return (
    <section {...attributes} aria-labelledby={heading ? labelId : undefined} className={schemeClass(settings.choice('colorScheme', COLOR_SCHEMES))}>
      <div className="shop-container shop-section flex flex-col gap-10">
        {heading ? (
          <Heading level={headingLevel} id={labelId} className="text-3xl font-semibold md:text-4xl">
            {heading}
          </Heading>
        ) : null}
        <ul className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {quotes.map(({ id, values }) => {
            const detail = values.text('detail').trim();
            const author = values.text('author').trim();
            return (
              <li key={id}>
                <figure className="flex h-full flex-col gap-4 rounded-shop border border-current/20 p-6">
                  <blockquote className="text-lg">
                    <p>{values.text('quote')}</p>
                  </blockquote>
                  {author ? (
                    <figcaption className="mt-auto">
                      <span className="block font-semibold">{author}</span>
                      {detail ? <span className="block text-sm opacity-90">{detail}</span> : null}
                    </figcaption>
                  ) : null}
                </figure>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
