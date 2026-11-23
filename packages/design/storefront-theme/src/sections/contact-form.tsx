import { createWidget } from '@weldsuite/forms-embed';
import { useEffect, useRef } from 'react';
import { Heading } from '../components/heading';
import { useShop } from '../context';
import { cleanPublicId, formPageUrl, portalOrigin } from '../forms-embed';
import { RichText } from '../markdown';
import { sectionSettings } from '../settings';
import { headingId, type SectionProps } from './types';

/**
 * A WeldForms form, embedded inline by its public id the way
 * `@weldsuite/forms-embed` does it (an iframe of the forms portal that
 * reports its height). The portal's address comes from the renderer.
 */
export function ContactForm({ section, attributes, headingLevel, list }: Readonly<SectionProps>) {
  const { shop } = useShop();
  const settings = sectionSettings(section.type, section.settings);
  const container = useRef<HTMLDivElement>(null);
  const publicId = cleanPublicId(settings.text('form'));
  const portal = portalOrigin(shop.formsPortalUrl);
  const frameTitle = shop.strings.form.frameTitle;
  useEffect(() => {
    const element = container.current;
    if (!element || !publicId || !portal) return;
    const handle = createWidget({ publicId, baseUrl: portal, container: element, height: 520 });
    if (handle.iframe) handle.iframe.title = frameTitle;
    return () => handle.destroy();
  }, [publicId, portal, frameTitle]);
  const heading = settings.text('heading').trim();
  const labelId = headingId({ list, section });
  const ready = publicId !== null && portal !== null;
  if (!ready && !shop.preview) return null;
  return (
    <section {...attributes} aria-labelledby={heading ? labelId : undefined} className="shop-container shop-section flex max-w-3xl flex-col gap-6">
      {heading ? (
        <Heading level={headingLevel} id={labelId} className="text-3xl font-semibold md:text-4xl">
          {heading}
        </Heading>
      ) : null}
      <RichText source={settings.text('text')} baseLevel={3} />
      {ready ? (
        <>
          {/* The embed owns this element's children; React leaves it empty. */}
          <div ref={container} className="min-h-[520px]" />
          <noscript>
            <a href={formPageUrl(portal, publicId)} rel="noopener noreferrer" className="underline underline-offset-4">
              {shop.strings.form.open}
            </a>
          </noscript>
        </>
      ) : (
        <p className="shop-hint">{shop.strings.form.missing}</p>
      )}
    </section>
  );
}
