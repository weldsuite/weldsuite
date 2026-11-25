import { Heading } from '../components/heading';
import { COLOR_SCHEMES, schemeClass } from '../components/scheme';
import { RichText as Markdown } from '../markdown';
import { sectionSettings } from '../settings';
import { headingId, type SectionProps } from './types';

/** A heading and formatted text. */
export function RichTextSection({ section, attributes, headingLevel, list }: Readonly<SectionProps>) {
  const settings = sectionSettings(section.type, section.settings);
  const heading = settings.text('heading').trim();
  const text = settings.text('text');
  if (!heading && !text.trim()) return null;
  const labelId = headingId({ list, section });
  const center = settings.choice('align', ['left', 'center'] as const) === 'center';
  return (
    <section {...attributes} aria-labelledby={heading ? labelId : undefined} className={schemeClass(settings.choice('colorScheme', COLOR_SCHEMES))}>
      <div className={`shop-container shop-section flex flex-col gap-5 ${center ? 'items-center text-center' : ''}`}>
        {heading ? (
          <Heading level={headingLevel} id={labelId} className="max-w-3xl text-3xl font-semibold md:text-4xl">
            {heading}
          </Heading>
        ) : null}
        <Markdown source={text} baseLevel={heading ? 3 : 2} className="shop-prose max-w-prose" />
      </div>
    </section>
  );
}
