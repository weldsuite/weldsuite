// Element and Section Types for Website Builder & Live Sites

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

export interface Element {
  id: string;
  type: ElementType;
  content?: any;
  settings: ElementSettings;
  children?: Element[];
  parent?: string;
  locked?: boolean;
  visible?: boolean;
}

export interface Section {
  id: string;
  name: string;
  type: string;
  elements?: Element[];
  blocks?: any[];
  settings?: ElementSettings;
  props?: Record<string, any>;
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
  pages?: any[];
  navigation?: any[];
  sections?: Section[];
  theme?: Record<string, any>;
  customCss?: string;
  customJs?: string;
  customHead?: string;
  googleAnalytics?: string;
  facebookPixel?: string;
  analytics?: Record<string, any>;
  isPublished: boolean;
  publishedUrl?: string;
  status: string;
  publishedAt?: string;
  settings?: Record<string, any>;
  metadata?: Record<string, any>;
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
