// Element and Section Types for Website Builder & Live Sites

// ─── Storefront data ─────────────────────────────────────────────────────────
// These describe the commerce payload the host app (apps/web/sites) fetches and
// threads down through every section and block as the `store` prop. Fields are
// optional because sections render against partial data (and against local mock
// data in the builder preview), so nothing here is guaranteed by the API.

/** Money as some commerce endpoints return it, instead of a bare number. */
export interface Money {
  amount: number;
  currencyCode?: string;
}

/** A price may arrive as a number, a preformatted string, or a Money object. */
export type ProductPrice = number | string | Money;

/** A product's category when the API embeds the record rather than its name. */
export interface ProductCategory {
  id?: string;
  name?: string;
  slug?: string;
  image?: string | null;
}

/**
 * A product image. The commerce API returns objects, while builder mock data
 * and several blocks use plain URL strings — both shapes reach the components.
 */
export interface ProductImage {
  src?: string;
  url?: string;
  alt?: string;
  thumbnail?: string;
  width?: number;
  height?: number;
}

export interface ProductVariant {
  id?: string;
  name?: string;
  title?: string;
  price?: number;
  compareAtPrice?: number;
  color?: string;
  colorHex?: string;
  size?: string;
  image?: string;
  imageUrl?: string;
  sku?: string;
  inventoryQuantity?: number;
  options?: Record<string, string>;
}

export interface Product {
  id?: string;
  handle?: string;
  slug?: string;
  name?: string;
  title?: string;
  description?: string;
  content?: string;
  price?: ProductPrice;
  salePrice?: number;
  compareAtPrice?: number;
  currency?: string;
  image?: string;
  imageUrl?: string;
  images?: (string | ProductImage)[];
  /** Free-form spec/info rows rendered by the product-info accordion. */
  info?: { title?: string; content?: string }[];
  badge?: string;
  category?: string | ProductCategory;
  featuredImageUrl?: string;
  categoryIds?: string[];
  collection?: string;
  collectionId?: string;
  collectionIds?: string[];
  rating?: number;
  reviews?: number;
  reviewCount?: number;
  stock?: number;
  inventoryQuantity?: number;
  colors?: string[];
  sizes?: string[];
  variants?: ProductVariant[];
  href?: string;
  link?: string;
  tags?: string[];
}

export interface Collection {
  id?: string;
  handle?: string;
  slug?: string;
  name?: string;
  title?: string;
  description?: string;
  image?: string;
  imageUrl?: string;
  banner?: string;
  productCount?: number;
  products?: Product[];
  href?: string;
  link?: string;
  price?: ProductPrice;
  megamenuImage?: string;
  megamenuImageAlt?: string;
}

export interface BlogPost {
  id?: string;
  handle?: string;
  slug?: string;
  title?: string;
  excerpt?: string;
  content?: string;
  image?: string;
  imageUrl?: string;
  author?: string;
  publishedAt?: string;
  date?: string;
  tags?: string[];
  href?: string;
  link?: string;
}

/**
 * The commerce context passed to every section and block. `selectedProduct` is
 * set on product-detail routes; the collection/product arrays back the grid,
 * carousel and navigation blocks.
 */
export interface StoreData {
  name?: string;
  description?: string;
  logo?: string;
  products?: Product[];
  collections?: Collection[];
  blogPosts?: BlogPost[];
  selectedProduct?: Product;
  selectedCollection?: Collection;
}

/**
 * Per-section settings bag produced by the website builder. The shape is
 * section-specific and not statically known, so readers have to narrow.
 */
export type SectionSettings = Record<string, unknown>;

export type ElementType =
  | 'text'
  | 'heading'
  | 'paragraph'
  | 'button'
  | 'link'
  | 'image'
  | 'video'
  | 'icon'
  | 'divider'
  | 'spacer'
  | 'container'
  | 'row'
  | 'column'
  | 'card'
  | 'productCard'
  | 'productDetail'
  | 'productGrid'
  | 'productList'
  | 'productRow'
  | 'productCarousel'
  | 'navbar'
  | 'breadcrumb'
  | 'dropdown'
  | 'sidebar'
  | 'section';

export interface ElementSettings {
  // Layout
  width?: string;
  height?: string;
  padding?: string;
  margin?: string;
  marginTop?: string;
  marginBottom?: string;
  marginLeft?: string;
  marginRight?: string;
  position?: 'static' | 'relative' | 'absolute' | 'fixed' | 'sticky';
  display?: 'block' | 'inline' | 'inline-block' | 'flex' | 'grid' | 'none';
  flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse';
  justifyContent?: 'start' | 'center' | 'end' | 'space-between' | 'space-around' | 'space-evenly';
  alignItems?: 'start' | 'center' | 'end' | 'stretch' | 'baseline';
  flex?: string;
  gap?: string;
  gridColumns?: number;
  gridRows?: number;

  // Typography
  fontSize?: string;
  fontWeight?: string;
  fontFamily?: string;
  lineHeight?: string;
  letterSpacing?: string;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  textDecoration?: string;
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';

  // Colors
  color?: string;
  backgroundColor?: string;
  borderColor?: string;

  // Borders
  borderWidth?: string;
  borderStyle?: 'solid' | 'dashed' | 'dotted' | 'double' | 'none';
  borderRadius?: string;
  borderTop?: string;
  borderBottom?: string;
  borderLeft?: string;
  borderRight?: string;

  // Effects
  boxShadow?: string;
  opacity?: number;
  filter?: string;
  backdropFilter?: string;

  // Animation
  animation?: AnimationSettings;

  // Responsive
  responsive?: {
    mobile?: Partial<ElementSettings>;
    tablet?: Partial<ElementSettings>;
    desktop?: Partial<ElementSettings>;
  };

  // Custom CSS
  customStyles?: string;

  // Positioning (for absolute elements)
  left?: string;
  top?: string;
  right?: string;
  bottom?: string;
}

export interface AnimationSettings {
  type: 'fade' | 'slide' | 'scale' | 'rotate' | 'bounce' | 'custom';
  duration: number;
  delay?: number;
  easing?: string;
  trigger?: 'scroll' | 'hover' | 'click' | 'load';
  custom?: string;
}

/**
 * Content payload of a leaf element. Which fields are meaningful depends on
 * the element type (text/heading use `text`, image uses `src`, link uses `url`).
 */
export interface ElementContent {
  text?: string;
  tag?: string;
  src?: string;
  alt?: string;
  url?: string;
}

export interface Element {
  id: string;
  type: ElementType;
  content?: ElementContent | string;
  settings: ElementSettings;
  children?: Element[];
  parent?: string;
  locked?: boolean;
  visible?: boolean;
}

/** A block inside a section — the builder's nested content unit. */
export interface Block {
  id: string;
  type: string;
  settings: SectionSettings;
  order: number;
  children?: Block[];
}

export interface Section {
  id: string;
  name: string;
  type: string;
  elements?: Element[];
  blocks?: Block[];
  settings?: ElementSettings;
  props?: Record<string, unknown>;
  template?: string;
  locked?: boolean;
}

export interface Website {
  id: string;
  name: string;
  slug: string;
  subdomain?: string;
  customDomain?: string;
  description?: string;
  logo?: string;
  favicon?: string;
  primaryColor?: string;
  secondaryColor?: string;
  fontFamily?: string;
  seoTitle?: string;
  seoDescription?: string;
  seoKeywords?: string;
  ogImage?: string;
  pages?: unknown[];
  navigation?: unknown[];
  sections?: Section[];
  theme?: Record<string, unknown>;
  customCss?: string;
  customJs?: string;
  customHead?: string;
  googleAnalytics?: string;
  facebookPixel?: string;
  analytics?: Record<string, unknown>;
  isPublished: boolean;
  publishedUrl?: string;
  status: string;
  publishedAt?: string;
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// Rendering modes
export type RenderMode = 'edit' | 'preview' | 'live';

export interface RenderContext {
  mode: RenderMode;
  isEditing?: boolean;
  onSelect?: (elementId: string) => void;
  onUpdate?: (elementId: string, updates: Partial<Element>) => void;
}
