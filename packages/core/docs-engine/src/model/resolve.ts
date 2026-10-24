/**
 * Effective formatting: what a paragraph or a character looks like once its
 * named style chain and direct formatting are combined.
 */

import { DEFAULT_FONT, DEFAULT_SIZE, NORMAL } from './defaults';
import type { NamedStyle, ParaProps, TextStyle } from './styles';

export interface StyleSource {
  styles: Map<string, NamedStyle> | Record<string, NamedStyle>;
}

function getStyle(source: StyleSource, id: string): NamedStyle | undefined {
  return source.styles instanceof Map ? source.styles.get(id) : source.styles[id];
}

/** The named styles from `normal` down to `id`, base first (cycles and unknown ids cut short). */
export function styleChain(source: StyleSource, id: string | undefined): NamedStyle[] {
  const chain: NamedStyle[] = [];
  const seen = new Set<string>();
  let current: string | undefined = id ?? NORMAL;
  while (current && !seen.has(current)) {
    seen.add(current);
    const style = getStyle(source, current);
    if (!style) break;
    chain.unshift(style);
    current = style.basedOn ?? (current === NORMAL ? undefined : NORMAL);
  }
  if (!seen.has(NORMAL)) {
    const normal = getStyle(source, NORMAL);
    if (normal) chain.unshift(normal);
  }
  return chain;
}

export type ResolvedText = TextStyle & { font: string; size: number };

/** Paragraph properties with the named style's defaults filled in. */
export function resolveParagraph(source: StyleSource, props: ParaProps): ParaProps {
  let out: ParaProps = {};
  for (const s of styleChain(source, props.style)) out = { ...out, ...s.para };
  return { ...out, ...props };
}

/** Character formatting of text with direct style `style` in a paragraph with properties `para`. */
export function resolveText(source: StyleSource, para: ParaProps, style: TextStyle): ResolvedText {
  let out: TextStyle = { font: DEFAULT_FONT, size: DEFAULT_SIZE };
  for (const s of styleChain(source, para.style)) out = { ...out, ...s.text };
  return { ...out, ...style } as ResolvedText;
}

/** Outline level of a paragraph (0 = title, 1–6 = headings), or null when it is body text. */
export function outlineLevel(source: StyleSource, props: ParaProps): number | null {
  const style = getStyle(source, props.style ?? NORMAL);
  return style?.outline ?? null;
}
