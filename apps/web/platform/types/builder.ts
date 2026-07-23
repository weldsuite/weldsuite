type ElementType =
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
  | 'accordion'
  | 'tabs'
  | 'carousel'
  | 'gallery'
  | 'form'
  | 'input'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'toggle'
  | 'slider'
  | 'map'
  | 'chart'
  | 'table'
  | 'list'
  | 'timeline'
  | 'testimonial'
  | 'pricing'
  | 'countdown'
  | 'progress'
  | 'stats'
  | 'social'
  | 'embed'
  | 'code'
  | 'custom'
  | 'section'
  | 'menu'
  | 'element'
  | 'Ground'
  | 'square'
  | 'circle'
  | 'triangle'
  | 'line'
  | 'arrow'
  | 'productCard'
  | 'productDetail'
  | 'productGrid'
  | 'productList'
  | 'productRow'
  | 'productRowComponent'
  | 'productCarousel'
  | 'navbar'
  | 'breadcrumb'
  | 'dropdown'
  | 'sidebar'
  | 'socialShare'
  | 'socialFeed'
  | 'animation'
  | 'canvas';

interface ElementSettings {
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
}

interface AnimationSettings {
  type: 'fade' | 'slide' | 'scale' | 'rotate' | 'bounce' | 'custom';
  duration: number;
  delay?: number;
  easing?: string;
  trigger?: 'scroll' | 'hover' | 'click' | 'load';
  custom?: string;
}

interface Element {
  id: string;
  type: ElementType;
  content?: any;
  settings: ElementSettings;
  children?: Element[];
  parent?: string;
  locked?: boolean;
  visible?: boolean;
}

export interface ElementCategory {
  id: string;
  name: string;
  icon: string;
  elements: ElementDefinition[];
}

export interface ElementDefinition {
  type: ElementType;
  name: string;
  icon: string | any;
  description: string;
  category: string;
  defaultSettings?: Partial<ElementSettings>;
  defaultContent?: any;
  presets?: ElementPreset[];
  configurable?: ElementConfig[];
}

interface ElementPreset {
  id: string;
  name: string;
  thumbnail?: string;
  preview?: string;
  settings: Partial<ElementSettings>;
  content?: any;
  children?: Element[];
}

interface ElementConfig {
  id: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'color' | 'toggle' | 'slider' | 'spacing' | 'border' | 'shadow' | 'image';
  category?: 'content' | 'style' | 'layout' | 'advanced';
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: any;
}

interface BuilderSection {
  id: string;
  name: string;
  type: string;
  elements: Element[];
  settings: ElementSettings;
  template?: string;
  locked?: boolean;
}

interface BuilderTemplate {
  id: string;
  name: string;
  category: string;
  thumbnail?: string;
  sections: BuilderSection[];
}

interface DragData {
  type: 'section' | 'element';
  sectionType?: string;
  elementType?: ElementType;
  preset?: ElementPreset;
  sourceId?: string;
  targetPosition?: number;
}
