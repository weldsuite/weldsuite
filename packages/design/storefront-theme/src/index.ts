export * from './types';
export * from './catalog';
export * from './defaults';

// The shop's own strings
export * from './strings';

// Drawing a site
export * from './context';
export { SectionRenderer, visibleSections, type SectionRendererProps } from './section-renderer';
export { SECTION_COMPONENTS, type SectionProps } from './sections';
export { sectionSettings, blockSettings, type SettingsReader } from './settings';
export { sectionDataNeeds, type DataNeeds, type SectionDataRequest } from './data-needs';
export { themeCssVariables, themeStyle, usedFontIds, fontFamily, contrastRatio, readableOn } from './theme-css';

// Safe content
export { RichText, parseMarkdown, parseInline, plainText, type MarkdownBlock, type Inline, type RichTextProps } from './markdown';
export { safeLink, safeImageSrc, type SafeLink } from './links';
export { videoEmbed, type VideoEmbed } from './video-url';
export { cleanPublicId, portalOrigin, formPageUrl } from './forms-embed';

// Pieces the renderer's own pages (checkout, account, orders) are built from
export { ShopLayout } from './components/layout';
export { ShopLink, currentPage } from './components/shop-link';
export { ThemeImage, type ThemeImageProps } from './components/theme-image';
export { Price, VatNote, useMoney, useTaxRate } from './components/price';
export { ProductCard, ProductGrid, productPath } from './components/product-card';
export { ProductBuyFields, variantFor } from './components/buy-fields';
export { Totals, OrderLines, AddressLines, useCountryName, type TotalsSource } from './components/totals';
export { Breadcrumbs, type Crumb } from './components/breadcrumbs';
export { AlertIcon, CheckIcon } from './components/icons';
