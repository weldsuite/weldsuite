/**
 * Draws a list of sections: each visible section of a known type, allowed in
 * that list, with its component. Hidden sections and types the theme does
 * not know (a newer document, a removed section) are skipped, never an
 * error. In preview mode every section's root carries `data-section-id` and
 * `data-section-list`, which the editor's preview bridge uses to highlight
 * and select it.
 */

import { useCallback, type ReactNode } from 'react';
import { SECTION_CATALOG } from './catalog';
import { RenderListContext, useShop, type RenderList } from './context';
import { SECTION_COMPONENTS } from './sections';
import type { ListName, Section, SectionList } from './types';

export interface SectionRendererProps {
  sections: SectionList | undefined;
  list: ListName;
  /** Overrides the shop's preview flag (tests, the editor's own previews). */
  preview?: boolean;
  /**
   * The heading level of the first section: 1 on a page whose sections carry
   * its only heading (home, a content page without its title), else 2.
   */
  firstHeadingLevel?: 1 | 2;
  /** Give the first section's large image priority (it is likely the page's LCP). */
  priorityFirst?: boolean;
}

/** The sections of `sections` that `SectionRenderer` draws, in order. */
export function visibleSections(sections: SectionList | undefined, list: ListName): Section[] {
  return (sections ?? []).filter((section) => {
    if (section.hidden) return false;
    const definition = SECTION_CATALOG[section.type];
    return definition !== undefined && SECTION_COMPONENTS[section.type] !== undefined && definition.where.includes(list);
  });
}

export function SectionRenderer({ sections, list, preview, firstHeadingLevel = 2, priorityFirst = false }: Readonly<SectionRendererProps>) {
  const { shop } = useShop();
  const inPreview = preview ?? shop.preview;
  const renderList = useCallback<RenderList>(
    (nested, nestedList, options) => (
      <SectionRenderer
        sections={nested}
        list={nestedList}
        preview={inPreview}
        firstHeadingLevel={options?.firstHeadingLevel}
        priorityFirst={options?.priorityFirst}
      />
    ),
    [inPreview],
  );
  const drawn: ReactNode[] = visibleSections(sections, list).map((section, position) => {
    const Component = SECTION_COMPONENTS[section.type]!;
    const attributes: Record<string, string> = inPreview ? { 'data-section-id': section.id, 'data-section-list': list } : {};
    return (
      <Component
        key={section.id}
        section={section}
        list={list}
        position={position}
        headingLevel={position === 0 ? firstHeadingLevel : 2}
        priority={priorityFirst && position === 0}
        attributes={attributes}
      />
    );
  });
  return <RenderListContext.Provider value={renderList}>{drawn}</RenderListContext.Provider>;
}
