import { ButtonLink } from '../components/button-link';
import { Heading } from '../components/heading';
import { COLOR_SCHEMES, schemeClass } from '../components/scheme';
import { ThemeImage } from '../components/theme-image';
import { safeImageSrc } from '../links';
import { RichText } from '../markdown';
import { sectionSettings } from '../settings';
import { headingId, type SectionProps } from './types';

/** An image beside a heading, text and a button; stacked on phones. */
export function ImageWithText({ section, attributes, headingLevel, priority, list }: Readonly<SectionProps>) {
  const settings = sectionSettings(section.type, section.settings);
  const image = settings.text('image');
  const heading = settings.text('heading').trim();
  const labelId = headingId({ list, section });
  const imageRight = settings.choice('imagePosition', ['left', 'right'] as const) === 'right';
  return (
    <section {...attributes} aria-labelledby={heading ? labelId : undefined} className={schemeClass(settings.choice('colorScheme', COLOR_SCHEMES))}>
      <div className="shop-container shop-section grid items-center gap-8 md:grid-cols-2 md:gap-12">
        <div className={`aspect-[4/3] overflow-hidden rounded-shop bg-shop-muted ${imageRight ? 'md:order-last' : ''}`}>
          {safeImageSrc(image) ? (
            <ThemeImage src={image} alt={settings.text('imageAlt')} priority={priority} className="size-full object-cover" sizes="(min-width: 768px) 50vw, 100vw" />
          ) : null}
        </div>
        <div className="flex flex-col items-start gap-5">
          {heading ? (
            <Heading level={headingLevel} id={labelId} className="text-3xl font-semibold md:text-4xl">
              {heading}
            </Heading>
          ) : null}
          <RichText source={settings.text('text')} baseLevel={3} />
          <ButtonLink label={settings.text('buttonLabel')} href={settings.text('buttonLink')} />
        </div>
      </div>
    </section>
  );
}
