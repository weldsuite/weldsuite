import { ButtonLink } from '../components/button-link';
import { Heading } from '../components/heading';
import { ThemeImage } from '../components/theme-image';
import { safeImageSrc } from '../links';
import { sectionSettings } from '../settings';
import { headingId, type SectionProps } from './types';

const HEIGHTS = { small: 'aspect-[3/1]', medium: 'aspect-[2/1]', large: 'aspect-[3/2]' } as const;

/** A wide image, with an optional heading, text and button in a panel below it on phones and on it on wide screens. */
export function ImageBanner({ section, attributes, headingLevel, priority, list }: Readonly<SectionProps>) {
  const settings = sectionSettings(section.type, section.settings);
  const image = settings.text('image');
  const heading = settings.text('heading').trim();
  const text = settings.text('text').trim();
  const label = settings.text('buttonLabel');
  const labelId = headingId({ list, section });
  const hasContent = heading !== '' || text !== '' || label.trim() !== '';
  if (!safeImageSrc(image) && !hasContent) return null;
  return (
    <section {...attributes} aria-labelledby={heading ? labelId : undefined} className="shop-container shop-section">
      <div className="relative overflow-hidden rounded-shop bg-shop-muted">
        <div className={HEIGHTS[settings.choice('height', ['small', 'medium', 'large'] as const)]}>
          <ThemeImage src={image} alt={settings.text('imageAlt')} priority={priority} className="size-full object-cover" sizes="(min-width: 1280px) 1280px, 100vw" />
        </div>
        {hasContent ? (
          <div className="flex flex-col items-start gap-3 bg-shop-bg p-6 text-shop-fg md:absolute md:bottom-6 md:start-6 md:max-w-md md:rounded-shop md:shadow-lg">
            {heading ? (
              <Heading level={headingLevel} id={labelId} className="text-2xl font-semibold md:text-3xl">
                {heading}
              </Heading>
            ) : null}
            {text ? <p>{text}</p> : null}
            <ButtonLink label={label} href={settings.text('buttonLink')} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
