import { useEffect, useRef, useState } from 'react';
import { Heading } from '../components/heading';
import { PlayIcon } from '../components/icons';
import { useShop } from '../context';
import { sectionSettings } from '../settings';
import { format } from '../strings';
import { videoEmbed } from '../video-url';
import { headingId, type SectionProps } from './types';

/**
 * A YouTube or Vimeo video behind a play button: nothing is loaded from the
 * video site until the visitor presses it (no thumbnail either), then the
 * privacy-enhanced player (youtube-nocookie, Vimeo with dnt) replaces it.
 */
export function Video({ section, attributes, headingLevel, list }: Readonly<SectionProps>) {
  const { shop } = useShop();
  const settings = sectionSettings(section.type, section.settings);
  const [playing, setPlaying] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const embed = videoEmbed(settings.text('url'));
  useEffect(() => {
    // The button the visitor pressed is gone: keep their focus on the player.
    if (playing) frame.current?.focus();
  }, [playing]);
  const heading = settings.text('heading').trim();
  const caption = settings.text('caption').trim();
  const s = shop.strings.video;
  if (!embed) {
    return shop.preview ? (
      <section {...attributes} className="shop-container shop-section">
        <p className="shop-hint">{shop.strings.preview.emptySection}</p>
      </section>
    ) : null;
  }
  const title = caption || heading;
  const labelId = headingId({ list, section });
  return (
    <section {...attributes} aria-labelledby={heading ? labelId : undefined} className="shop-container shop-section flex flex-col gap-6">
      {heading ? (
        <Heading level={headingLevel} id={labelId} className="text-3xl font-semibold md:text-4xl">
          {heading}
        </Heading>
      ) : null}
      <figure className="flex flex-col gap-3">
        <div className="relative aspect-video overflow-hidden rounded-shop bg-shop-muted text-shop-on-muted">
          {playing ? (
            <iframe
              ref={frame}
              src={embed.embedUrl}
              title={format(s.frameTitle, { title: title || embed.site })}
              allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
              referrerPolicy="strict-origin-when-cross-origin"
              className="absolute inset-0 size-full border-0"
            />
          ) : (
            <button
              type="button"
              onClick={() => setPlaying(true)}
              className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center"
            >
              <span className="flex size-16 items-center justify-center rounded-full bg-shop-primary text-shop-on-primary shadow-lg">
                <PlayIcon className="size-8" />
              </span>
              <span className="font-medium">{title ? format(s.play, { title }) : s.playUntitled}</span>
              <span className="text-sm">{format(s.notice, { site: embed.site })}</span>
            </button>
          )}
        </div>
        <figcaption className="flex flex-wrap justify-between gap-2 text-sm">
          {caption ? <span>{caption}</span> : <span />}
          <a href={embed.watchUrl} rel="noopener noreferrer" className="underline underline-offset-4">
            {format(s.openOn, { site: embed.site })}
          </a>
        </figcaption>
      </figure>
    </section>
  );
}
