import { Heading } from '../components/heading';
import { columnsClass, COLOR_SCHEMES, COLUMN_OPTIONS, schemeClass } from '../components/scheme';
import { ShopLink } from '../components/shop-link';
import { ThemeImage } from '../components/theme-image';
import { safeLink } from '../links';
import { RichText } from '../markdown';
import { blockSettings, sectionSettings } from '../settings';
import { headingId, type SectionProps } from './types';

/** Columns of an image, a title, text and a link (one block each). */
export function Multicolumn({ section, attributes, headingLevel, list }: Readonly<SectionProps>) {
  const settings = sectionSettings(section.type, section.settings);
  const blocks = (section.blocks ?? []).filter((block) => block.type === 'column');
  const heading = settings.text('heading').trim();
  if (blocks.length === 0 && !heading) return null;
  const labelId = headingId({ list, section });
  const columnHeading = heading ? 'h3' : 'h2';
  return (
    <section {...attributes} aria-labelledby={heading ? labelId : undefined} className={schemeClass(settings.choice('colorScheme', COLOR_SCHEMES))}>
      <div className="shop-container shop-section flex flex-col gap-10">
        {heading ? (
          <Heading level={headingLevel} id={labelId} className="text-3xl font-semibold md:text-4xl">
            {heading}
          </Heading>
        ) : null}
        <ul className={`grid gap-8 ${columnsClass(settings.choice('columns', COLUMN_OPTIONS))}`}>
          {blocks.map((block) => {
            const column = blockSettings(section.type, block.type, block.settings);
            const title = column.text('title').trim();
            const link = column.text('link');
            const linkLabel = column.text('linkLabel').trim();
            const Title = columnHeading;
            return (
              <li key={block.id} className="flex flex-col gap-3">
                <ThemeImage src={column.text('image')} alt={column.text('imageAlt')} className="aspect-[4/3] w-full rounded-shop object-cover" />
                {title ? <Title className="text-xl font-semibold">{title}</Title> : null}
                <RichText source={column.text('text')} baseLevel={3} />
                {linkLabel && safeLink(link) ? (
                  <ShopLink href={link} className="font-medium underline underline-offset-4">
                    {linkLabel}
                  </ShopLink>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
