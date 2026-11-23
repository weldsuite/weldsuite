import { ShopLink } from '../components/shop-link';
import { COLOR_SCHEMES, schemeClass } from '../components/scheme';
import { safeLink } from '../links';
import { sectionSettings } from '../settings';
import type { SectionProps } from './types';

/** A line of text above the header, optionally a link. */
export function AnnouncementBar({ section, attributes }: Readonly<SectionProps>) {
  const settings = sectionSettings(section.type, section.settings);
  const text = settings.text('text').trim();
  if (!text) return null;
  const link = settings.text('link');
  return (
    <div {...attributes} className={`${schemeClass(settings.choice('colorScheme', COLOR_SCHEMES))} px-4 py-2 text-center text-sm`}>
      {safeLink(link) ? (
        <ShopLink href={link} className="underline underline-offset-4">
          {text}
        </ShopLink>
      ) : (
        <p>{text}</p>
      )}
    </div>
  );
}
