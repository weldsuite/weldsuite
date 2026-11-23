import { Heading } from '../components/heading';
import { RichText } from '../markdown';
import { blockSettings, sectionSettings } from '../settings';
import { headingId, type SectionProps } from './types';

/**
 * Questions and answers as native disclosures (`details`/`summary`): keyboard
 * and screen reader support built in, answers findable with find-in-page.
 */
export function Faq({ section, attributes, headingLevel, list }: Readonly<SectionProps>) {
  const settings = sectionSettings(section.type, section.settings);
  const items = (section.blocks ?? [])
    .filter((block) => block.type === 'item')
    .map((block) => ({ id: block.id, values: blockSettings(section.type, block.type, block.settings) }))
    .filter(({ values }) => values.text('question').trim() !== '');
  if (items.length === 0) return null;
  const heading = settings.text('heading').trim();
  const labelId = headingId({ list, section });
  return (
    <section {...attributes} aria-labelledby={heading ? labelId : undefined} className="shop-container shop-section flex max-w-3xl flex-col gap-6">
      {heading ? (
        <Heading level={headingLevel} id={labelId} className="text-3xl font-semibold md:text-4xl">
          {heading}
        </Heading>
      ) : null}
      <div className="divide-y divide-shop-border border-y border-shop-border">
        {items.map(({ id, values }) => (
          <details key={id} className="shop-disclosure group py-1">
            <summary className="flex min-h-12 cursor-pointer items-center gap-3 py-3 text-lg font-medium">{values.text('question')}</summary>
            <div className="pb-5 ps-7">
              <RichText source={values.text('answer')} baseLevel={3} />
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
