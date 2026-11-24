import type { ListName, Section } from '../types';

/** What `SectionRenderer` gives every section component. */
export interface SectionProps {
  section: Section;
  list: ListName;
  /** The section's place among the visible sections of its list (0 is first). */
  position: number;
  /** The level of the section's own heading: 1 for the first section of a page without a main section, else 2. */
  headingLevel: 1 | 2;
  /** Load this section's large image first (the page's likely LCP). */
  priority: boolean;
  /** `data-section-id` and `data-section-list` in preview mode; spread on the section's root. */
  attributes: Record<string, string>;
}

/** A unique id for a section's heading, for `aria-labelledby`. */
export function headingId(props: Pick<SectionProps, 'list' | 'section'>): string {
  return `section-${props.list}-${props.section.id}-heading`;
}
