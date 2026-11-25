/**
 * The `atelier` theme's presets, fonts, and the document a new online store
 * starts from. Also the starting sections of new content pages, legal pages
 * included (the merchant fills in their own details: the texts are a
 * structure to complete, not legal advice).
 */

import { defaultSettings } from './catalog';
import type { Label } from './catalog';
import type { Section, SiteDocument, ThemeColors, ThemeSettings } from './types';

export const THEME_ID = 'atelier';

export interface ThemeFont {
  id: string;
  name: string;
  /** The CSS `font-family` stack; the renderer bundles the font files. */
  family: string;
}

/** Self-hosted fonts only: a shop never loads fonts from a CDN. */
export const THEME_FONTS: ThemeFont[] = [
  { id: 'inter', name: 'Inter', family: "'Inter Variable', ui-sans-serif, system-ui, sans-serif" },
  { id: 'dm-sans', name: 'DM Sans', family: "'DM Sans Variable', ui-sans-serif, system-ui, sans-serif" },
  { id: 'fraunces', name: 'Fraunces', family: "'Fraunces Variable', ui-serif, Georgia, serif" },
  { id: 'lora', name: 'Lora', family: "'Lora Variable', ui-serif, Georgia, serif" },
  { id: 'system', name: 'System', family: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' },
];

export interface ThemePreset {
  id: string;
  name: Label;
  colors: ThemeColors;
  fontHeading: string;
  fontBody: string;
  radius: ThemeSettings['radius'];
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'classic',
    name: { en: 'Classic', nl: 'Klassiek' },
    colors: { background: '#ffffff', foreground: '#111827', primary: '#111827', primaryForeground: '#ffffff', muted: '#f3f4f6', border: '#e5e7eb' },
    fontHeading: 'inter',
    fontBody: 'inter',
    radius: 'small',
  },
  {
    id: 'warm',
    name: { en: 'Warm', nl: 'Warm' },
    colors: { background: '#fbf8f3', foreground: '#2b2118', primary: '#a8461f', primaryForeground: '#ffffff', muted: '#f1ebe1', border: '#e4d9c8' },
    fontHeading: 'fraunces',
    fontBody: 'dm-sans',
    radius: 'medium',
  },
  {
    id: 'fresh',
    name: { en: 'Fresh', nl: 'Fris' },
    colors: { background: '#ffffff', foreground: '#0f1f17', primary: '#166534', primaryForeground: '#ffffff', muted: '#ecf5ef', border: '#d5e6da' },
    fontHeading: 'dm-sans',
    fontBody: 'dm-sans',
    radius: 'large',
  },
  {
    id: 'editorial',
    name: { en: 'Editorial', nl: 'Redactioneel' },
    colors: { background: '#fafafa', foreground: '#171717', primary: '#1d4ed8', primaryForeground: '#ffffff', muted: '#f0f0f0', border: '#dedede' },
    fontHeading: 'lora',
    fontBody: 'inter',
    radius: 'none',
  },
];

/** The theme settings of a preset. */
export function presetSettings(presetId: string): ThemeSettings {
  const preset = THEME_PRESETS.find((p) => p.id === presetId) ?? THEME_PRESETS[0]!;
  return {
    preset: preset.id,
    colors: { ...preset.colors },
    fontHeading: preset.fontHeading,
    fontBody: preset.fontBody,
    radius: preset.radius,
    logoUrl: null,
    logoAlt: null,
    faviconUrl: null,
    social: {},
  };
}

/** A section of `type` with its defaults, overridden by `settings`. */
export function newSection(id: string, type: string, settings: Section['settings'] = {}, blocks?: Section['blocks']): Section {
  const section: Section = { id, type, settings: { ...defaultSettings(type), ...settings } };
  if (blocks) section.blocks = blocks;
  return section;
}

/** The document a new online store starts from. */
export function defaultSiteDocument(): SiteDocument {
  return {
    schemaVersion: 1,
    theme: { id: THEME_ID, settings: presetSettings('classic') },
    groups: {
      header: [newSection('header', 'header')],
      footer: [newSection('footer', 'footer')],
    },
    templates: {
      home: [
        newSection('hero', 'hero'),
        newSection('featured', 'featured-products'),
        newSection('categories', 'category-list'),
        newSection('story', 'image-with-text'),
      ],
      product: [newSection('main', 'main-product'), newSection('related', 'related-products')],
      category: [newSection('main', 'main-category')],
      search: [newSection('main', 'main-search')],
      cart: [newSection('main', 'main-cart')],
      page: [newSection('main', 'main-page')],
      notFound: [newSection('main', 'main-not-found')],
    },
    seo: {},
    settings: { access: 'public', cookieBanner: false },
  };
}

export type PageTemplateId = 'blank' | 'about' | 'contact' | 'terms' | 'privacy' | 'withdrawal' | 'imprint';

export interface PageTemplate {
  id: PageTemplateId;
  name: Label;
  slug: string;
  title: Label;
  /** True for the pages EU shops are expected to have. */
  legal: boolean;
  sections: () => Section[];
}

const todo = (en: string) => `*${en}*`;

/**
 * Starting points for content pages. The legal ones give the structure EU
 * webshops are expected to cover, with placeholders to replace; they are not
 * legal advice and say so in the editor.
 */
export const PAGE_TEMPLATES: PageTemplate[] = [
  { id: 'blank', name: { en: 'Blank page', nl: 'Lege pagina' }, slug: '', title: { en: 'New page', nl: 'Nieuwe pagina' }, legal: false, sections: () => [newSection('text', 'rich-text')] },
  {
    id: 'about',
    name: { en: 'About us', nl: 'Over ons' },
    slug: 'about',
    title: { en: 'About us', nl: 'Over ons' },
    legal: false,
    sections: () => [
      newSection('intro', 'image-with-text', { heading: 'Our story', text: 'Tell visitors who you are and why you started.' }),
      newSection('values', 'multicolumn', { heading: 'What we stand for' }),
    ],
  },
  {
    id: 'contact',
    name: { en: 'Contact', nl: 'Contact' },
    slug: 'contact',
    title: { en: 'Contact', nl: 'Contact' },
    legal: false,
    sections: () => [
      newSection('text', 'rich-text', { heading: 'Get in touch', text: 'Email: hello@example.com\n\nPhone: +31 20 000 0000' }),
      newSection('form', 'contact-form'),
    ],
  },
  {
    id: 'terms',
    name: { en: 'Terms and conditions', nl: 'Algemene voorwaarden' },
    slug: 'terms',
    title: { en: 'Terms and conditions', nl: 'Algemene voorwaarden' },
    legal: true,
    sections: () => [
      newSection('text', 'rich-text', {
        text: [
          '## Who we are',
          todo('Your company name, address, Chamber of Commerce and VAT numbers, email address and phone number.'),
          '## Offers and prices',
          todo('Prices include VAT for consumers; how long offers are valid; what happens with obvious mistakes.'),
          '## Ordering and payment',
          todo('How an order is concluded, the payment methods, and when you may refuse an order.'),
          '## Delivery',
          todo('Delivery times, costs and what happens when delivery is late.'),
          '## Right of withdrawal',
          todo('Consumers may withdraw within 14 days of receipt. Refer to the withdrawal page and form.'),
          '## Warranty and complaints',
          todo('The legal guarantee, how to file a complaint and how quickly you answer.'),
          '## Disputes',
          todo('Applicable law and the dispute body, if any.'),
        ].join('\n\n'),
      }),
    ],
  },
  {
    id: 'privacy',
    name: { en: 'Privacy policy', nl: 'Privacybeleid' },
    slug: 'privacy',
    title: { en: 'Privacy policy', nl: 'Privacybeleid' },
    legal: true,
    sections: () => [
      newSection('text', 'rich-text', {
        text: [
          '## Who is responsible',
          todo('Your company name and contact details for privacy questions.'),
          '## What we collect and why',
          todo('Name, addresses and email to deliver and invoice orders (contract); order history (legal retention).'),
          '## Who receives it',
          todo('Payment provider, carriers, and WeldSuite as the processor that hosts this shop in the EU.'),
          '## How long we keep it',
          todo('For example: order data seven years for tax law; accounts until you delete them.'),
          '## Your rights',
          todo('Access, correction, deletion, objection, portability, and the right to complain to the supervisory authority.'),
          '## Cookies',
          todo('This shop uses only cookies it needs to work (your cart and sign-in).'),
        ].join('\n\n'),
      }),
    ],
  },
  {
    id: 'withdrawal',
    name: { en: 'Right of withdrawal', nl: 'Herroepingsrecht' },
    slug: 'withdrawal',
    title: { en: 'Right of withdrawal', nl: 'Herroepingsrecht' },
    legal: true,
    sections: () => [
      newSection('text', 'rich-text', {
        text: [
          'You may withdraw from your purchase within 14 days of receiving it, without giving a reason.',
          '## How to withdraw',
          todo('Send us an unambiguous statement (email address, postal address), for example with the model form below.'),
          '## Returning the products',
          todo('Where to send them, within 14 days, and who pays the return costs.'),
          '## Refunds',
          todo('We refund within 14 days of your withdrawal, including the standard delivery costs.'),
          '## Model withdrawal form',
          'To: [your company name, address, email]\n\nI/We hereby give notice that I/We withdraw from my/our contract of sale of the following goods: …\n\nOrdered on / received on: …\n\nName and address of the consumer: …\n\nDate: …',
        ].join('\n\n'),
      }),
    ],
  },
  {
    id: 'imprint',
    name: { en: 'Imprint', nl: 'Colofon (Impressum)' },
    slug: 'imprint',
    title: { en: 'Imprint', nl: 'Colofon' },
    legal: true,
    sections: () => [
      newSection('text', 'rich-text', {
        text: todo(
          'Company name and legal form, address, representative, email and phone, register and registration number, VAT number. Required in Germany and Austria.',
        ),
      }),
    ],
  },
];
