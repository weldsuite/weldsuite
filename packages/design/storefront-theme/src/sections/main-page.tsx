import { useContext } from 'react';
import { RenderListContext, useShop } from '../context';
import { sectionSettings } from '../settings';
import type { SectionProps } from './types';

/** A content page: its title, then the page's own sections. */
export function MainPage({ section, attributes, priority }: Readonly<SectionProps>) {
  const { data } = useShop();
  const renderList = useContext(RenderListContext);
  const settings = sectionSettings(section.type, section.settings);
  const page = data.page;
  if (!page) return null;
  const showTitle = settings.bool('showTitle');
  return (
    <div {...attributes}>
      {showTitle ? (
        <div className="shop-container pt-10 md:pt-14">
          <h1 className="text-3xl font-semibold md:text-4xl">{page.title}</h1>
        </div>
      ) : null}
      {renderList?.(page.sections, 'content', { firstHeadingLevel: showTitle ? 2 : 1, priorityFirst: priority })}
    </div>
  );
}
