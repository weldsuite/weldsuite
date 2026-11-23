/**
 * The section catalog of the `atelier` theme: every section a shop can use,
 * where it may appear, and its settings. The editor builds its forms from it;
 * the backend validates drafts against its JSON export
 * (`rust/catalogs/storefront-sections.json`, written by
 * `pnpm --filter @weldsuite/storefront-theme catalog:export`); the renderer
 * draws each type with the component of the same name.
 *
 * Labels are for the editor, in the platform's languages (en, nl). The shop's
 * own strings are in `strings.ts`.
 */

import { GROUP_NAMES, TEMPLATE_NAMES, type GroupName, type ListName, type SettingValue, type TemplateName } from './types';

export type Label = { en: string; nl: string };

export type SettingType =
  | 'text'
  | 'textarea'
  | 'richtext'
  | 'url'
  | 'image'
  | 'select'
  | 'checkbox'
  | 'number'
  | 'color'
  | 'category'
  | 'product'
  | 'categories'
  | 'products'
  | 'menu'
  | 'page'
  | 'form'
  | 'video';

export interface SettingOption {
  value: string;
  label: Label;
}

export interface SettingDefinition {
  id: string;
  type: SettingType;
  label: Label;
  /** What a new section starts with; also the value when the setting is missing. */
  default: SettingValue;
  /** For `select`. */
  options?: SettingOption[];
  /** For `number`. */
  min?: number;
  max?: number;
  /** For text-like settings; the backend's defaults apply otherwise. */
  maxLength?: number;
  /** A hint under the field in the editor. */
  help?: Label;
}

export interface BlockDefinition {
  name: Label;
  settings: SettingDefinition[];
}

export interface SectionDefinition {
  name: Label;
  /** The lists it may appear in. */
  where: ListName[];
  /** The templates or groups it must appear in, exactly once (main sections). */
  required: (TemplateName | GroupName)[];
  /** Most per list; `null` is no limit beyond the list's own. */
  limit: number | null;
  maxBlocks: number;
  settings: SettingDefinition[];
  blocks: Record<string, BlockDefinition>;
}

const ALL_CONTENT: ListName[] = ['home', 'product', 'category', 'search', 'cart', 'page', 'notFound', 'content'];

// ── Shared settings ────────────────────────────────────────────────────

const heading = (defaultValue = ''): SettingDefinition => ({
  id: 'heading',
  type: 'text',
  label: { en: 'Heading', nl: 'Kop' },
  default: defaultValue,
  maxLength: 200,
});

const buttonLabel: SettingDefinition = {
  id: 'buttonLabel',
  type: 'text',
  label: { en: 'Button label', nl: 'Knoptekst' },
  default: '',
  maxLength: 60,
};

const buttonLink: SettingDefinition = {
  id: 'buttonLink',
  type: 'url',
  label: { en: 'Button link', nl: 'Knoplink' },
  default: '',
  help: { en: 'A page of this shop (/products) or a full https:// address', nl: 'Een pagina van deze winkel (/products) of een volledig https://-adres' },
};

const image = (id = 'image', label: Label = { en: 'Image', nl: 'Afbeelding' }): SettingDefinition => ({
  id,
  type: 'image',
  label,
  default: '',
});

const imageAlt: SettingDefinition = {
  id: 'imageAlt',
  type: 'text',
  label: { en: 'Image description', nl: 'Beschrijving van de afbeelding' },
  default: '',
  maxLength: 200,
  help: { en: 'For screen readers; leave empty for a decorative image', nl: 'Voor schermlezers; laat leeg voor een decoratieve afbeelding' },
};

const align: SettingDefinition = {
  id: 'align',
  type: 'select',
  label: { en: 'Alignment', nl: 'Uitlijning' },
  default: 'left',
  options: [
    { value: 'left', label: { en: 'Left', nl: 'Links' } },
    { value: 'center', label: { en: 'Centre', nl: 'Midden' } },
  ],
};

const columns = (defaultValue: string, values: string[] = ['2', '3', '4']): SettingDefinition => ({
  id: 'columns',
  type: 'select',
  label: { en: 'Columns on wide screens', nl: 'Kolommen op brede schermen' },
  default: defaultValue,
  options: values.map((value) => ({ value, label: { en: value, nl: value } })),
});

const height: SettingDefinition = {
  id: 'height',
  type: 'select',
  label: { en: 'Height', nl: 'Hoogte' },
  default: 'medium',
  options: [
    { value: 'small', label: { en: 'Small', nl: 'Klein' } },
    { value: 'medium', label: { en: 'Medium', nl: 'Gemiddeld' } },
    { value: 'large', label: { en: 'Large', nl: 'Groot' } },
  ],
};

const colorScheme: SettingDefinition = {
  id: 'colorScheme',
  type: 'select',
  label: { en: 'Colours', nl: 'Kleuren' },
  default: 'default',
  options: [
    { value: 'default', label: { en: 'Page colours', nl: 'Paginakleuren' } },
    { value: 'muted', label: { en: 'Muted', nl: 'Gedempt' } },
    { value: 'primary', label: { en: 'Primary colour', nl: 'Hoofdkleur' } },
  ],
};

const richText = (id = 'text', defaultValue = ''): SettingDefinition => ({
  id,
  type: 'richtext',
  label: { en: 'Text', nl: 'Tekst' },
  default: defaultValue,
  help: {
    en: 'Paragraphs, **bold**, *italic*, [links](https://…), lists (- item) and headings (## Heading)',
    nl: 'Alinea’s, **vet**, *cursief*, [links](https://…), lijsten (- item) en koppen (## Kop)',
  },
});

const section = (definition: Partial<SectionDefinition> & Pick<SectionDefinition, 'name' | 'where' | 'settings'>): SectionDefinition => ({
  required: [],
  limit: null,
  maxBlocks: 0,
  blocks: {},
  ...definition,
});

// ── The catalog ────────────────────────────────────────────────────────

export const SECTION_CATALOG: Record<string, SectionDefinition> = {
  // Header and footer groups
  'announcement-bar': section({
    name: { en: 'Announcement bar', nl: 'Mededelingsbalk' },
    where: ['header'],
    limit: 1,
    settings: [
      { id: 'text', type: 'text', label: { en: 'Text', nl: 'Tekst' }, default: 'Free shipping on orders over €50', maxLength: 200 },
      { id: 'link', type: 'url', label: { en: 'Link', nl: 'Link' }, default: '' },
      { ...colorScheme, default: 'primary' },
    ],
  }),
  header: section({
    name: { en: 'Header', nl: 'Koptekst' },
    where: ['header'],
    required: ['header'],
    limit: 1,
    settings: [
      { id: 'menu', type: 'menu', label: { en: 'Menu', nl: 'Menu' }, default: 'main' },
      { id: 'showSearch', type: 'checkbox', label: { en: 'Show search', nl: 'Zoeken tonen' }, default: true },
      { id: 'showAccount', type: 'checkbox', label: { en: 'Show account link', nl: 'Accountlink tonen' }, default: true },
      { id: 'sticky', type: 'checkbox', label: { en: 'Stay at the top while scrolling', nl: 'Bovenaan blijven bij scrollen' }, default: true },
    ],
  }),
  footer: section({
    name: { en: 'Footer', nl: 'Voettekst' },
    where: ['footer'],
    required: ['footer'],
    limit: 1,
    settings: [
      { id: 'menu', type: 'menu', label: { en: 'Menu', nl: 'Menu' }, default: 'footer' },
      richText('text', ''),
      { id: 'showSocial', type: 'checkbox', label: { en: 'Show social media links', nl: 'Sociale-medialinks tonen' }, default: true },
      { id: 'showLocaleNote', type: 'checkbox', label: { en: 'Show prices and VAT note', nl: 'Prijs- en btw-opmerking tonen' }, default: true },
    ],
  }),

  // Main sections: one per template, never removed
  'main-product': section({
    name: { en: 'Product', nl: 'Product' },
    where: ['product'],
    required: ['product'],
    limit: 1,
    settings: [
      {
        id: 'gallery',
        type: 'select',
        label: { en: 'Image gallery', nl: 'Afbeeldingengalerij' },
        default: 'thumbnails',
        options: [
          { value: 'thumbnails', label: { en: 'Large image with thumbnails', nl: 'Grote afbeelding met miniaturen' } },
          { value: 'stacked', label: { en: 'All images under each other', nl: 'Alle afbeeldingen onder elkaar' } },
        ],
      },
      { id: 'showSku', type: 'checkbox', label: { en: 'Show SKU', nl: 'Artikelnummer tonen' }, default: false },
      { id: 'showDescription', type: 'checkbox', label: { en: 'Show description', nl: 'Beschrijving tonen' }, default: true },
    ],
  }),
  'main-category': section({
    name: { en: 'Product grid', nl: 'Productraster' },
    where: ['category'],
    required: ['category'],
    limit: 1,
    settings: [
      columns('4'),
      { id: 'pageSize', type: 'number', label: { en: 'Products per page', nl: 'Producten per pagina' }, default: 24, min: 8, max: 48 },
      { id: 'showSort', type: 'checkbox', label: { en: 'Show sorting', nl: 'Sorteren tonen' }, default: true },
      { id: 'showDescription', type: 'checkbox', label: { en: 'Show category description', nl: 'Categoriebeschrijving tonen' }, default: true },
    ],
  }),
  'main-search': section({
    name: { en: 'Search results', nl: 'Zoekresultaten' },
    where: ['search'],
    required: ['search'],
    limit: 1,
    settings: [columns('4'), { id: 'pageSize', type: 'number', label: { en: 'Products per page', nl: 'Producten per pagina' }, default: 24, min: 8, max: 48 }],
  }),
  'main-cart': section({
    name: { en: 'Cart', nl: 'Winkelwagen' },
    where: ['cart'],
    required: ['cart'],
    limit: 1,
    settings: [
      { id: 'showDiscount', type: 'checkbox', label: { en: 'Show discount code field', nl: 'Kortingscodeveld tonen' }, default: true },
      richText('note', ''),
    ],
  }),
  'main-page': section({
    name: { en: 'Page content', nl: 'Pagina-inhoud' },
    where: ['page'],
    required: ['page'],
    limit: 1,
    settings: [{ id: 'showTitle', type: 'checkbox', label: { en: 'Show the page title', nl: 'Paginatitel tonen' }, default: true }],
  }),
  'main-not-found': section({
    name: { en: 'Page not found', nl: 'Pagina niet gevonden' },
    where: ['notFound'],
    required: ['notFound'],
    limit: 1,
    settings: [
      heading(''),
      { ...richText('text', ''), help: { en: 'Leave empty for the theme’s own text', nl: 'Laat leeg voor de eigen tekst van het thema' } },
    ],
  }),

  // Content sections
  hero: section({
    name: { en: 'Hero', nl: 'Hero' },
    where: ALL_CONTENT,
    settings: [
      image(),
      imageAlt,
      heading('Welcome to our shop'),
      { id: 'text', type: 'textarea', label: { en: 'Text', nl: 'Tekst' }, default: '', maxLength: 500 },
      { ...buttonLabel, default: 'Shop now' },
      { ...buttonLink, default: '/products' },
      { ...height, default: 'large' },
      { ...align, default: 'center' },
      { id: 'overlay', type: 'number', label: { en: 'Image darkening (%)', nl: 'Verdonkering van de afbeelding (%)' }, default: 30, min: 0, max: 80 },
    ],
  }),
  'image-banner': section({
    name: { en: 'Image banner', nl: 'Afbeeldingsbanner' },
    where: ALL_CONTENT,
    settings: [image(), imageAlt, heading(''), { id: 'text', type: 'textarea', label: { en: 'Text', nl: 'Tekst' }, default: '', maxLength: 500 }, buttonLabel, buttonLink, height],
  }),
  'featured-products': section({
    name: { en: 'Featured products', nl: 'Uitgelichte producten' },
    where: ALL_CONTENT,
    settings: [
      heading('Featured products'),
      {
        id: 'source',
        type: 'select',
        label: { en: 'Products', nl: 'Producten' },
        default: 'newest',
        options: [
          { value: 'newest', label: { en: 'Newest', nl: 'Nieuwste' } },
          { value: 'category', label: { en: 'From a category', nl: 'Uit een categorie' } },
          { value: 'products', label: { en: 'Chosen products', nl: 'Gekozen producten' } },
        ],
      },
      { id: 'category', type: 'category', label: { en: 'Category', nl: 'Categorie' }, default: '' },
      { id: 'products', type: 'products', label: { en: 'Products', nl: 'Producten' }, default: [] },
      { id: 'limit', type: 'number', label: { en: 'How many', nl: 'Hoeveel' }, default: 8, min: 2, max: 24 },
      columns('4'),
      { id: 'showViewAll', type: 'checkbox', label: { en: 'Show “View all” link', nl: 'Link “Alles bekijken” tonen' }, default: true },
    ],
  }),
  'related-products': section({
    name: { en: 'Related products', nl: 'Gerelateerde producten' },
    where: ['product'],
    limit: 1,
    settings: [heading('You may also like'), { id: 'limit', type: 'number', label: { en: 'How many', nl: 'Hoeveel' }, default: 4, min: 2, max: 12 }, columns('4')],
  }),
  'category-list': section({
    name: { en: 'Category list', nl: 'Categorielijst' },
    where: ALL_CONTENT,
    settings: [
      heading('Shop by category'),
      { id: 'categories', type: 'categories', label: { en: 'Categories', nl: 'Categorieën' }, default: [], help: { en: 'Empty shows the top-level categories', nl: 'Leeg toont de hoofdcategorieën' } },
      columns('3'),
    ],
  }),
  'image-with-text': section({
    name: { en: 'Image with text', nl: 'Afbeelding met tekst' },
    where: ALL_CONTENT,
    settings: [
      image(),
      imageAlt,
      heading('Made with care'),
      richText('text', 'Tell your customers what makes your products special.'),
      buttonLabel,
      buttonLink,
      {
        id: 'imagePosition',
        type: 'select',
        label: { en: 'Image position', nl: 'Positie van de afbeelding' },
        default: 'left',
        options: [
          { value: 'left', label: { en: 'Left', nl: 'Links' } },
          { value: 'right', label: { en: 'Right', nl: 'Rechts' } },
        ],
      },
      colorScheme,
    ],
  }),
  'rich-text': section({
    name: { en: 'Text', nl: 'Tekst' },
    where: ALL_CONTENT,
    settings: [heading(''), richText('text', ''), align, colorScheme],
  }),
  multicolumn: section({
    name: { en: 'Columns', nl: 'Kolommen' },
    where: ALL_CONTENT,
    maxBlocks: 12,
    settings: [heading(''), columns('3'), colorScheme],
    blocks: {
      column: {
        name: { en: 'Column', nl: 'Kolom' },
        settings: [
          image(),
          imageAlt,
          { id: 'title', type: 'text', label: { en: 'Title', nl: 'Titel' }, default: '', maxLength: 200 },
          richText('text', ''),
          { id: 'linkLabel', type: 'text', label: { en: 'Link label', nl: 'Linktekst' }, default: '', maxLength: 60 },
          { id: 'link', type: 'url', label: { en: 'Link', nl: 'Link' }, default: '' },
        ],
      },
    },
  }),
  testimonials: section({
    name: { en: 'Testimonials', nl: 'Klantervaringen' },
    where: ALL_CONTENT,
    maxBlocks: 12,
    settings: [heading('What our customers say'), colorScheme],
    blocks: {
      quote: {
        name: { en: 'Quote', nl: 'Citaat' },
        settings: [
          { id: 'quote', type: 'textarea', label: { en: 'Quote', nl: 'Citaat' }, default: '', maxLength: 600 },
          { id: 'author', type: 'text', label: { en: 'Name', nl: 'Naam' }, default: '', maxLength: 100 },
          { id: 'detail', type: 'text', label: { en: 'Role or place', nl: 'Functie of plaats' }, default: '', maxLength: 100 },
        ],
      },
    },
  }),
  faq: section({
    name: { en: 'Questions and answers', nl: 'Vragen en antwoorden' },
    where: ALL_CONTENT,
    maxBlocks: 30,
    settings: [heading('Frequently asked questions')],
    blocks: {
      item: {
        name: { en: 'Question', nl: 'Vraag' },
        settings: [
          { id: 'question', type: 'text', label: { en: 'Question', nl: 'Vraag' }, default: '', maxLength: 300 },
          richText('answer', ''),
        ],
      },
    },
  }),
  video: section({
    name: { en: 'Video', nl: 'Video' },
    where: ALL_CONTENT,
    settings: [
      heading(''),
      {
        id: 'url',
        type: 'video',
        label: { en: 'YouTube or Vimeo address', nl: 'YouTube- of Vimeo-adres' },
        default: '',
        help: {
          en: 'Loads only after the visitor clicks play, so nothing is sent to the video site before that',
          nl: 'Laadt pas als de bezoeker op afspelen klikt, zodat er vooraf niets naar de videosite gaat',
        },
      },
      { id: 'caption', type: 'text', label: { en: 'Caption', nl: 'Onderschrift' }, default: '', maxLength: 200 },
    ],
  }),
  'contact-form': section({
    name: { en: 'Contact form', nl: 'Contactformulier' },
    where: ALL_CONTENT,
    limit: 1,
    settings: [
      heading('Contact us'),
      richText('text', ''),
      {
        id: 'form',
        type: 'form',
        label: { en: 'WeldForms form', nl: 'WeldForms-formulier' },
        default: '',
        help: { en: 'The public id of a published form', nl: 'De openbare id van een gepubliceerd formulier' },
      },
    ],
  }),
};

/** The JSON the backend validates drafts against (`rust/catalogs/storefront-sections.json`). */
export function catalogExport() {
  return {
    version: 1,
    templates: [...TEMPLATE_NAMES],
    groups: [...GROUP_NAMES],
    sections: SECTION_CATALOG,
  };
}

/** A section's settings with every default filled in. */
export function defaultSettings(type: string): Record<string, SettingValue> {
  const definition = SECTION_CATALOG[type];
  if (!definition) return {};
  return Object.fromEntries(definition.settings.map((setting) => [setting.id, setting.default]));
}

/** A block's settings with every default filled in. */
export function defaultBlockSettings(type: string, blockType: string): Record<string, SettingValue> {
  const definition = SECTION_CATALOG[type]?.blocks[blockType];
  if (!definition) return {};
  return Object.fromEntries(definition.settings.map((setting) => [setting.id, setting.default]));
}

/** The section types that may be added to `list`, in catalog order (main sections excluded). */
export function addableSections(list: ListName): string[] {
  return Object.entries(SECTION_CATALOG)
    .filter(([, definition]) => definition.where.includes(list) && definition.required.length === 0)
    .map(([type]) => type);
}

/** A setting's value on a section, or its default. */
export function settingValue(settings: Record<string, SettingValue>, type: string, id: string): SettingValue {
  if (id in settings) return settings[id] ?? null;
  return SECTION_CATALOG[type]?.settings.find((setting) => setting.id === id)?.default ?? null;
}
