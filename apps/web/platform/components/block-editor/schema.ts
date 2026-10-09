import {
  BlockNoteSchema,
  COLORS_DEFAULT,
  createStyleSpec,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
} from '@blocknote/core';
import { BookmarkBlock } from './blocks/bookmark';
import { CalloutBlock } from './blocks/callout';
import { EmbedBlock } from './blocks/embed';
import { TableOfContentsBlock } from './blocks/table-of-contents';

// Custom style specs for font-family and font-size. BlockNote doesn't
// ship these by default; we register them as inline styles that render
// a <span> with the corresponding CSS so they round-trip through
// serialization and external HTML export.
const FontFamily = createStyleSpec(
  { type: 'fontFamily', propSchema: 'string' },
  {
    render: (value) => {
      const span = document.createElement('span');
      if (value) span.style.fontFamily = String(value);
      return { dom: span, contentDOM: span };
    },
    toExternalHTML: (value) => {
      const span = document.createElement('span');
      if (value) span.style.fontFamily = String(value);
      return { dom: span, contentDOM: span };
    },
    parse: (el) => {
      if (el instanceof HTMLElement && el.style.fontFamily) return el.style.fontFamily;
      return undefined;
    },
  },
);

const FontSize = createStyleSpec(
  { type: 'fontSize', propSchema: 'string' },
  {
    render: (value) => {
      const span = document.createElement('span');
      if (value) span.style.fontSize = String(value);
      return { dom: span, contentDOM: span };
    },
    toExternalHTML: (value) => {
      const span = document.createElement('span');
      if (value) span.style.fontSize = String(value);
      return { dom: span, contentDOM: span };
    },
    parse: (el) => {
      if (el instanceof HTMLElement && el.style.fontSize) return el.style.fontSize;
      return undefined;
    },
  },
);

// Text color and highlight. BlockNote's own specs render a bare <span> and
// leave the color to CSS rules for its ten named colors, so any other value —
// the document toolbar's swatches are hex — was stored but never shown. These
// keep the named colors on that themed CSS and put anything else inline.
function isNamedColor(value: string): value is keyof typeof COLORS_DEFAULT {
  return value in COLORS_DEFAULT;
}

const TextColor = createStyleSpec(
  { type: 'textColor', propSchema: 'string' },
  {
    render: (value) => {
      const span = document.createElement('span');
      if (value && value !== 'default' && !isNamedColor(value)) span.style.color = value;
      return { dom: span, contentDOM: span };
    },
    toExternalHTML: (value) => {
      const span = document.createElement('span');
      if (value && value !== 'default') span.style.color = isNamedColor(value) ? COLORS_DEFAULT[value].text : value;
      return { dom: span, contentDOM: span };
    },
    parse: (el) => (el.tagName === 'SPAN' && el.style.color ? el.style.color : undefined),
  },
);

const BackgroundColor = createStyleSpec(
  { type: 'backgroundColor', propSchema: 'string' },
  {
    render: (value) => {
      const span = document.createElement('span');
      if (value && value !== 'default' && !isNamedColor(value)) span.style.backgroundColor = value;
      return { dom: span, contentDOM: span };
    },
    toExternalHTML: (value) => {
      const span = document.createElement('span');
      if (value && value !== 'default') {
        span.style.backgroundColor = isNamedColor(value) ? COLORS_DEFAULT[value].background : value;
      }
      return { dom: span, contentDOM: span };
    },
    parse: (el) => (el.tagName === 'SPAN' && el.style.backgroundColor ? el.style.backgroundColor : undefined),
  },
);

/**
 * Every block the editor can hold: BlockNote's defaults (text, headings and
 * toggle headings, lists, toggle list, quote, code, table, image, video,
 * audio, file, divider) plus the WeldSuite blocks behind the Notion-style
 * slash commands. Both consumers (WeldKnow pages, CRM notes) store the block
 * JSON as-is, so there is no export format to stay compatible with.
 */
export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    callout: CalloutBlock(),
    embed: EmbedBlock(),
    bookmark: BookmarkBlock(),
    tableOfContents: TableOfContentsBlock(),
  },
  inlineContentSpecs: defaultInlineContentSpecs,
  styleSpecs: {
    ...defaultStyleSpecs,
    textColor: TextColor,
    backgroundColor: BackgroundColor,
    fontFamily: FontFamily,
    fontSize: FontSize,
  },
});

/** The editor instance bound to this schema. */
export type SchemaEditor = typeof schema.BlockNoteEditor;
/** A partial block (for inserts and updates) bound to this schema. */
export type SchemaPartialBlock = typeof schema.PartialBlock;
