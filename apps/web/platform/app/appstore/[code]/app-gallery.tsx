/**
 * The image gallery at the top of an app's page, as on Attio's app pages: the
 * picked image large (8:5) with the thumbnails stacked beside it. Until an app
 * has screenshots, each slide is a placeholder: the app's icon on a flat
 * canvas.
 */

import { useState } from 'react';
import type { AvailableApp } from '@/hooks/queries/use-settings-queries';
import { cn } from '@/lib/utils';

/** How many placeholder slides an app without screenshots shows. */
const PLACEHOLDER_SLIDES = 3;

interface Slide {
  src: string | null;
  alt: string;
}

/** The catalog's screenshots, when it sends any (`{ url, altText }` rows), else placeholders. */
function slidesOf(app: AvailableApp): Slide[] {
  const shots = (app.screenshots ?? []).flatMap((shot) => {
    if (typeof shot !== 'object' || shot === null) return [];
    const { url, altText } = shot as { url?: unknown; altText?: unknown };
    return typeof url === 'string' ? [{ src: url, alt: typeof altText === 'string' ? altText : app.name }] : [];
  });
  if (shots.length > 0) return shots;
  return Array.from({ length: PLACEHOLDER_SLIDES }, () => ({ src: null, alt: app.name }));
}

/** A slide's picture: the screenshot, or the app's icon centred on a flat canvas. */
function SlideImage({ slide, icon }: Readonly<{ slide: Slide; icon: React.ReactNode }>) {
  if (slide.src) return <img src={slide.src} alt={slide.alt} className="size-full object-cover" />;
  return <div className="flex size-full items-center justify-center bg-muted/70">{icon}</div>;
}

export function AppGallery({ app, largeIcon, smallIcon }: Readonly<{ app: AvailableApp; largeIcon: React.ReactNode; smallIcon: React.ReactNode }>) {
  const slides = slidesOf(app);
  const [picked, setPicked] = useState(0);
  const current = slides[picked] ?? slides[0];

  return (
    <div className="grid grid-cols-10 gap-5">
      <div className="relative col-span-8 flex aspect-[8/5] w-full items-center justify-center overflow-hidden rounded-2xl bg-muted/40">
        <SlideImage slide={current} icon={largeIcon} />
      </div>
      <div className="col-span-2 flex flex-col gap-4">
        {slides.map((slide, index) => (
          <button
            key={index}
            type="button"
            aria-label={`${slide.alt} ${index + 1}`}
            aria-pressed={index === picked}
            onClick={() => setPicked(index)}
            className={cn(
              'aspect-[8/5] w-full cursor-pointer overflow-hidden rounded-xl border bg-transparent p-0.5 transition-colors',
              index === picked ? 'border-foreground/30' : 'border-border hover:border-foreground/20',
            )}
          >
            <div className="size-full overflow-hidden rounded-[10px]">
              <SlideImage slide={slide} icon={smallIcon} />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
