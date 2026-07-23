"use client";

import React from 'react';
import { Section, RenderMode } from '../types';
import { BlockRenderer } from './block-renderer';
import { SectionWrapper, SectionSettings } from '../components/section-wrapper';
import { cn } from '@weldsuite/ui/lib/utils';
import { ChevronUp, ChevronDown, Copy, Trash2 } from 'lucide-react';

interface SectionRendererProps {
  section: Section;
  mode?: RenderMode;
  store?: any;
  settings?: Record<string, any>;
  onSelectElement?: (elementId: string) => void;
  onUpdateElement?: (sectionId: string, elementId: string, updates: any) => void;
  onSelectBlock?: (blockId: string) => void;
  onMoveBlockUp?: (sectionId: string, blockId: string, blockIndex: number) => void;
  onMoveBlockDown?: (sectionId: string, blockId: string, blockIndex: number) => void;
  onDuplicateBlock?: (sectionId: string, blockId: string) => void;
  onDeleteBlock?: (sectionId: string, blockId: string) => void;
  selectedBlockId?: string | null;
  previewMode?: 'desktop' | 'tablet' | 'mobile';
  isSelected?: boolean;
  isHovered?: boolean;
}

export function SectionRenderer({
  section,
  mode = 'live',
  store,
  settings,
  onSelectElement,
  onUpdateElement,
  onSelectBlock,
  onMoveBlockUp,
  onMoveBlockDown,
  onDuplicateBlock,
  onDeleteBlock,
  selectedBlockId,
  previewMode = 'desktop',
  isSelected = false,
  isHovered = false
}: SectionRendererProps) {
  const isEditing = mode === 'edit';
  const [hoveredBlockId, setHoveredBlockId] = React.useState<string | null>(null);

  // Extract section settings (Shopify-like properties)
  const sectionSettings: SectionSettings = section.props || {};

  // All sections now use blocks
  if (!section.blocks || section.blocks.length === 0) {
    if (isEditing) {
      return (
        <div
          className={cn(
            "relative min-h-[100px] border-2 border-dashed border-gray-200 rounded-lg flex items-center justify-center",
            "hover:border-gray-300"
          )}
        >
          <p className="text-sm text-gray-400">Empty section - add blocks to get started</p>
        </div>
      );
    }
    return null;
  }

  // Determine if blocks should stack or flow inline
  const stackingBlockTypes = ['heading', 'text', 'image', 'video', 'videoPlayer', 'videoText', 'divider', 'spacer', 'grid', 'flex', 'container', 'columns', 'accordion', 'tabs', 'gallery', 'galleryCarousel', 'galleryAccordion', 'galleryHorizontalAccordion', 'horizontalAccordionGallery', 'countdownStats', 'countdownTimer', 'productCard', 'productDetail', 'testimonialCard', 'pricingCard', 'announcementBar', 'trustStrip', 'productList', 'collectionCarousel', 'newsletter', 'emailForm', 'contactFormModern', 'productGrid', 'navbar', 'navbarShopify', 'navbarMinimal', 'navbarLuxury', 'hero', 'heroVideoText', 'heroVideoTextHeading', 'heroVideoTextDescription', 'heroVideoTextButton', 'heroVideoBackground', 'heroOverlay', 'featuredCollection', 'featuredProduct', 'footer', 'footerAnimated', 'footerTime', 'footerLogo', 'footerInfo', 'imageBanner', 'collectionList', 'imageWithText', 'slideshow', 'slideshowContainer', 'productImageGallery', 'productTitle', 'productPrice', 'productColorSelector', 'productSizeSelector', 'productQuantitySelector', 'productActionButtons', 'productDescription', 'productPolicyButtons', 'productShippingFeatures', 'productInfoAccordion', 'productDetailGallery', 'productDetailTitle', 'productDetailPrice', 'productDetailVariantSelector', 'productDetailQuantity', 'productDetailButtons', 'productDetailDescription', 'productDetailAccordion', 'productCategories', 'categoryHeader', 'categoryBanner', 'categorySplit', 'heroGallery', 'videoCarousel', 'aboutProfile', 'galleryMarquee', 'heroCarousel', 'heroInteractive', 'heroVideoTextOverlay', 'galleryAccordionHorizontal', 'galleryAccordionVertical', 'featureDotted', 'ctaBanner'];

  // Determine which blocks should have full width (no max-width constraint)
  const fullWidthBlockTypes = ['announcementBar', 'trustStrip', 'productList', 'collectionCarousel', 'productDetail', 'navbar', 'navbarShopify', 'navbarMinimal', 'navbarLuxury', 'hero', 'heroVideoText', 'heroVideoTextHeading', 'videoText', 'heroVideoBackground', 'heroOverlay', 'galleryCarousel', 'featuredCollection', 'featuredProduct', 'contactFormModern', 'footer', 'footerAnimated', 'footerTime', 'footerLogo', 'footerInfo', 'imageBanner', 'imageWithText', 'slideshow', 'slideshowContainer', 'container', 'productCategories', 'categoryHeader', 'categoryBanner', 'categorySplit', 'heroGallery', 'videoCarousel', 'aboutProfile', 'galleryMarquee', 'heroCarousel', 'heroInteractive', 'heroVideoTextOverlay', 'galleryAccordionHorizontal', 'galleryAccordionVertical', 'featureDotted', 'ctaBanner'];

  // Check if section contains any full-width blocks
  const hasFullWidthBlock = section.blocks.some(block => fullWidthBlockTypes.includes(block.type));

  // Block type labels
  const blockLabels: Record<string, string> = {
    heading: 'Heading',
    text: 'Text',
    image: 'Image',
    button: 'Button',
    video: 'Video',
    videoPlayer: 'Video Player',
    divider: 'Divider',
    spacer: 'Spacer',
    icon: 'Icon',
    container: 'Container',
    columns: 'Columns',
    navbar: 'Navigation Bar',
    navbarShopify: 'Shopify Header',
    navbarMinimal: 'Minimal Header',
    navbarLuxury: 'Luxury Header',
    logo: 'Logo',
    menu: 'Menu',
    search: 'Search',
    link: 'Link',
    accordion: 'Accordion',
    tabs: 'Tabs',
    gallery: 'Gallery',
    testimonialCard: 'Testimonial',
    pricingCard: 'Pricing Card',
    countdown: 'Countdown',
    badge: 'Badge',
    quote: 'Quote',
    stats: 'Stats',
    progressBar: 'Progress Bar',
    socialIcons: 'Social Icons',
    announcementBar: 'Announcement',
    trustStrip: 'Trust Strip',
    productList: 'Product List',
    collectionCarousel: 'Collection Carousel',
    formInput: 'Input',
    formTextarea: 'Textarea',
    formSelect: 'Select',
    formCheckbox: 'Checkbox',
    formRadio: 'Radio',
    emailForm: 'Email form',
    productCard: 'Product',
    productDetail: 'Product Detail',
    collectionBanner: 'Collection Banner',
    newsletter: 'Newsletter',
    cartIcon: 'Cart',
    accountIcon: 'Account',
    grid: 'Grid',
    flex: 'Flex',
    productGrid: 'Product Grid',
    hero: 'Hero',
    heroVideoText: 'Hero Video Text',
    heroVideoTextHeading: 'Video Text Heading',
    heroVideoTextDescription: 'Description',
    heroVideoTextButton: 'Button',
    videoText: 'Video Text',
    heroArrowButton: 'Arrow Button',
    heroVideoBackground: 'Hero Video Background',
    heroOverlay: 'Hero Overlay',
    galleryCarousel: 'Gallery Carousel',
    galleryAccordion: 'Gallery Accordion',
    accordionGallery: 'Accordion Gallery',
    galleryHorizontalAccordion: 'Gallery Horizontal',
    horizontalAccordionGallery: 'Horizontal Accordion',
    countdownStats: 'Countdown Stats',
    countdownTimer: 'Countdown Timer',
    featuredCollection: 'Featured Collection',
    featuredProduct: 'Featured Product',
    imageBanner: 'Image Banner',
    collectionList: 'Collection List',
    imageWithText: 'Image with Text',
    slideshow: 'Slideshow',
    slideshowContainer: 'Slideshow Container',
    slideContainer: 'Slide',
    slideHeading: 'Slide Heading',
    slideText: 'Slide Text',
    slideButton: 'Slide Button',
    // Product detail blocks
    productImageGallery: 'Product Images',
    productTitle: 'Product Title',
    productPrice: 'Product Price',
    productColorSelector: 'Color Selector',
    productSizeSelector: 'Size Selector',
    productQuantitySelector: 'Quantity Selector',
    productActionButtons: 'Action Buttons',
    productDescription: 'Product Description',
    productPolicyButtons: 'Policy Buttons',
    productShippingFeatures: 'Shipping Features',
    productInfoAccordion: 'Product Info Accordion',
    // Product detail sub-blocks
    productDetailGallery: 'Gallery',
    productDetailTitle: 'Title',
    productDetailPrice: 'Price',
    productDetailVariantSelector: 'Variant Selector',
    productDetailQuantity: 'Quantity',
    productDetailButtons: 'Buttons',
    productDetailDescription: 'Description',
    productDetailAccordion: 'Accordion',
    productCategories: 'Product Categories',
    categoryHeader: 'Category Header',
    categoryBanner: 'Category Banner',
    categorySplit: 'Category Split',
    heroGallery: 'Hero Gallery',
    videoCarousel: 'Video Carousel',
    aboutProfile: 'About Profile',
    galleryMarquee: 'Gallery Marquee',
    heroCarousel: 'Hero Carousel',
    heroInteractive: 'Hero Interactive',
    heroVideoTextOverlay: 'Hero Video Text Overlay',
    galleryAccordionHorizontal: 'Gallery Accordion Horizontal',
    galleryAccordionVertical: 'Gallery Accordion Vertical',
    featureDotted: 'Feature Dotted',
    ctaBanner: 'CTA Banner',
    // Footer blocks
    footerLogo: 'Footer Logo',
    footerInfo: 'Footer Info',
    footerCopyrightText: 'Copyright',
    footerTimeDisplay: 'Time Display',
    footerEmail: 'Email',
  };

  // For single-block sections, don't show block UI (labels, actions) in edit mode
  const isSingleBlockSection = section.blocks.length === 1;

  // Check if this is a productGrid section type to apply special padding
  const isProductGridSection = section.type === 'productGrid';

  const content = (
    <div className={`flex flex-wrap items-center gap-2 ${isProductGridSection && isEditing ? 'py-24' : ''} ${section.type === 'faq' ? 'justify-center w-full' : ''}`}>
      {section.blocks.map((block, index) => {
        const isBlockSelected = selectedBlockId === block.id;
        const isBlockHovered = hoveredBlockId === block.id;
        const canMoveUp = index > 0;
        const canMoveDown = index < (section.blocks?.length || 0) - 1;

        // Determine if this block should stack
        const shouldStack = stackingBlockTypes.includes(block.type);

        return (
          <div
            key={block.id}
            data-block-container
            className={cn(
              "relative group",
              shouldStack ? "w-full" : "inline-block",
              isEditing && !isSingleBlockSection && "cursor-pointer",
              isBlockSelected && isEditing && !isSingleBlockSection && "ring-2 ring-blue-500 ring-inset"
            )}
            style={{}}
            onMouseEnter={(e) => {
              if (isEditing && !isSingleBlockSection) {
                setHoveredBlockId(block.id);
              }
            }}
            onMouseLeave={(e) => {
              if (isEditing && !isSingleBlockSection) {
                // Only clear hover if we're actually leaving the block container entirely
                const relatedTarget = e.relatedTarget as HTMLElement;
                const blockContainer = e.currentTarget;

                // Check if the mouse is moving to a child element or outside completely
                if (!relatedTarget || !blockContainer.contains(relatedTarget)) {
                  setHoveredBlockId(null);
                }
              }
            }}
            onClick={(e) => {
              if (isEditing && onSelectBlock && !isSingleBlockSection) {
                e.stopPropagation();
                console.log('Block clicked:', block.id, block.type);
                onSelectBlock(block.id);
              }
            }}
          >
            {/* Block Label - Only show for multi-block sections */}
            {isEditing && !isSingleBlockSection && (isBlockHovered || isBlockSelected) && (
              <div className="absolute top-0 left-0 z-40 bg-gray-900 text-white text-xs px-2 py-1 rounded shadow-lg whitespace-nowrap pointer-events-none">
                {blockLabels[block.type] || block.type}
              </div>
            )}

            {/* Block Action Menu - Only show for multi-block sections */}
            {isEditing && !isSingleBlockSection && (isBlockHovered || isBlockSelected) && (
              <div
                className="absolute -bottom-12 left-1/2 -translate-x-1/2 z-40 flex gap-1 bg-white shadow-lg rounded-md border border-gray-200 p-1"
                data-block-action
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onMoveBlockUp?.(section.id, block.id, index);
                  }}
                  disabled={!canMoveUp}
                  className={cn(
                    "p-1.5 rounded hover:bg-gray-100 transition-colors",
                    !canMoveUp && "opacity-40 cursor-not-allowed"
                  )}
                  title="Move up"
                >
                  <ChevronUp className="w-4 h-4" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onMoveBlockDown?.(section.id, block.id, index);
                  }}
                  disabled={!canMoveDown}
                  className={cn(
                    "p-1.5 rounded hover:bg-gray-100 transition-colors",
                    !canMoveDown && "opacity-40 cursor-not-allowed"
                  )}
                  title="Move down"
                >
                  <ChevronDown className="w-4 h-4" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDuplicateBlock?.(section.id, block.id);
                  }}
                  className="p-1.5 rounded hover:bg-gray-100 transition-colors"
                  title="Duplicate"
                >
                  <Copy className="w-4 h-4" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteBlock?.(section.id, block.id);
                  }}
                  className="p-1.5 rounded hover:bg-red-50 text-red-600 transition-colors"
                  title="Delete"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            )}
            <BlockRenderer
              block={block}
              mode={mode === 'preview' ? 'live' : mode}
              store={store}
              previewMode={previewMode}
              selectedBlockId={selectedBlockId || undefined}
              onSelectBlock={onSelectBlock}
              onMoveBlockUp={onMoveBlockUp}
              onMoveBlockDown={onMoveBlockDown}
              onDuplicateBlock={onDuplicateBlock}
              onDeleteBlock={onDeleteBlock}
              sectionId={section.id}
              blockIndex={index}
            />
          </div>
        );
      })}
    </div>
  );

  // In edit mode, apply minimal padding for visual consistency
  if (isEditing) {
    // Extract padding values from section settings
    const spacingMap = {
      none: '0',
      xs: '0.5rem',
      sm: '1rem',
      md: '1.5rem',
      lg: '2.5rem',
      xl: '4rem',
      '2xl': '6rem',
    };

    const paddingTop = sectionSettings.paddingTop ? spacingMap[sectionSettings.paddingTop] : '0';
    const paddingBottom = sectionSettings.paddingBottom ? spacingMap[sectionSettings.paddingBottom] : '0';

    return (
      <div
        className={cn("relative min-h-[50px]")}
        style={{
          paddingTop,
          paddingBottom,
        }}
      >
        {content}
      </div>
    );
  }

  // In live/preview mode, handle single-block sections specially
  // If section has only one block, render it directly without section wrapper
  // This makes the frontend cleaner and more Shopify-like
  if (section.blocks.length === 1) {
    const singleBlock = section.blocks[0];
    return (
      <BlockRenderer
        block={singleBlock}
        mode={mode === 'preview' ? 'live' : mode}
        store={store}
        previewMode={previewMode}
        selectedBlockId={selectedBlockId || undefined}
        onSelectBlock={onSelectBlock}
        onMoveBlockUp={onMoveBlockUp}
        onMoveBlockDown={onMoveBlockDown}
        onDuplicateBlock={onDuplicateBlock}
        onDeleteBlock={onDeleteBlock}
        sectionId={section.id}
        blockIndex={0}
      />
    );
  }

  // For multi-block sections, use section wrapper with all Shopify-like properties
  // Override maxWidth and fullWidth settings based on block types
  const finalSectionSettings = {
    ...sectionSettings,
    fullWidth: hasFullWidthBlock ? true : (sectionSettings.fullWidth ?? false),
    maxWidth: hasFullWidthBlock ? 'full' as const : (sectionSettings.maxWidth ?? 'xl'),
  };

  return (
    <SectionWrapper settings={finalSectionSettings} mode={mode}>
      {content}
    </SectionWrapper>
  );
}
