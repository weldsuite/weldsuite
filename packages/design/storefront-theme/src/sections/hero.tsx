import { ButtonLink } from '../components/button-link';
import { Heading } from '../components/heading';
import { ThemeImage } from '../components/theme-image';
import { safeImageSrc } from '../links';
import { sectionSettings } from '../settings';
import { headingId, type SectionProps } from './types';

const HEIGHTS = { small: 'min-h-[18rem]', medium: 'min-h-[26rem]', large: 'min-h-[34rem] md:min-h-[40rem]' } as const;

/**
 * A large image with a heading, text and a button over it. The text is
 * white on the darkened image; the darkening never drops below 25% so it
 * stays readable on light photos.
 */
export function Hero({ section, attributes, headingLevel, priority, list }: Readonly<SectionProps>) {
  const settings = sectionSettings(section.type, section.settings);
  const image = settings.text('image');
  const hasImage = safeImageSrc(image) !== null;
  const heading = settings.text('heading').trim();
  const text = settings.text('text').trim();
  const center = settings.choice('align', ['left', 'center'] as const) === 'center';
  const overlay = Math.max(25, settings.number('overlay')) / 100;
  const height = HEIGHTS[settings.choice('height', ['small', 'medium', 'large'] as const)];
  const labelId = headingId({ list, section });
  return (
    <section
      {...attributes}
      aria-labelledby={heading ? labelId : undefined}
      className={`relative isolate flex items-end overflow-hidden ${height} ${hasImage ? 'text-white' : 'scheme-primary bg-shop-primary text-shop-on-primary'}`}
    >
      {hasImage ? (
        <>
          <ThemeImage src={image} alt={settings.text('imageAlt')} priority={priority} className="absolute inset-0 -z-20 size-full object-cover" sizes="100vw" />
          <div aria-hidden="true" className="absolute inset-0 -z-10 bg-black" style={{ opacity: overlay }} />
        </>
      ) : null}
      <div className={`shop-container flex flex-col gap-5 py-12 md:py-16 ${center ? 'items-center text-center' : 'items-start'}`}>
        {heading ? (
          <Heading level={headingLevel} id={labelId} className="max-w-3xl text-4xl font-semibold text-balance md:text-6xl">
            {heading}
          </Heading>
        ) : null}
        {text ? <p className="max-w-2xl text-lg md:text-xl">{text}</p> : null}
        <div className={hasImage ? 'scheme-on-image' : undefined}>
          <ButtonLink label={settings.text('buttonLabel')} href={settings.text('buttonLink')} />
        </div>
      </div>
    </section>
  );
}
