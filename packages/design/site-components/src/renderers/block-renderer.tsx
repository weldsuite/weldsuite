"use client";

// Block renderer for all block types
import React, { useState } from 'react';
import { cn } from '@weldsuite/ui/lib/utils';
import { ChevronUp, ChevronDown, Copy, Trash2 } from 'lucide-react';
import {
  TextBlock,
  HeadingBlock,
  ImageBlock,
  ButtonBlock,
  SpacerBlock,
  VideoBlock,
  VideoPlayerBlock,
  DividerBlock,
  IconBlock,
  ContainerBlock,
  ColumnsBlock,
  NavbarShopifyBlock,
  NavbarMinimalBlock,
  NavbarLuxuryBlock,
  HeroBlock,
  FeaturedCollectionBlock,
  FeaturedProductBlock,
  ProductImageGalleryBlock,
  ProductTitleBlock,
  ProductPriceBlock,
  ProductColorSelectorBlock,
  ProductSizeSelectorBlock,
  ProductQuantitySelectorBlock,
  ProductActionButtonsBlock,
  ProductDescriptionBlock,
  ProductPolicyButtonsBlock,
  ProductShippingFeaturesBlock,
  EmailFormBlock,
  ContactFormModernBlock,
  FooterBlock,
  ImageBannerBlock,
  CollectionListBlock,
  ImageWithTextBlock,
  MultirowBlock,
  SlideshowBlock,
  SlideshowContainerBlock,
  SlideContainerBlock,
  SlideHeadingBlock,
  SlideTextBlock,
  SlideButtonBlock,
  HeroVideoTextBlock,
  HeroVideoTextHeadingBlock,
  HeroVideoTextDescriptionBlock,
  HeroVideoTextButtonBlock,
  VideoTextBlock,
  HeroArrowButtonBlock,
  HeroVideoBackgroundBlock,
  HeroOverlayBlock,
  GalleryCarouselBlock,
  GalleryAccordionBlock,
  AccordionGalleryBlock,
  GalleryHorizontalAccordionBlock,
  HorizontalAccordionGalleryBlock,
  CountdownStatsBlock,
  CountdownTimerBlock,
  FooterAnimatedBlock,
  FooterTimeBlock,
  FooterLogoBlock,
  FooterInfoBlock,
  FooterCopyrightTextBlock,
  FooterTimeDisplayBlock,
  FooterEmailBlock
} from '../blocks';

// New blocks
import { LogoBlock } from '../blocks/logo-block';
import { MenuBlock } from '../blocks/menu-block';
import { SearchBlock } from '../blocks/search-block';
import { LinkBlock } from '../blocks/link-block';
import { AccordionBlock } from '../blocks/accordion-block';
import { TabsBlock } from '../blocks/tabs-block';
import { GalleryBlock } from '../blocks/gallery-block';
import { TestimonialCardBlock } from '../blocks/testimonial-card-block';
import { PricingCardBlock } from '../blocks/pricing-card-block';
import { CountdownBlock } from '../blocks/countdown-block';
import { SocialIconsBlock } from '../blocks/social-icons-block';
import { AnnouncementBarBlock } from '../blocks/announcement-bar-block';
import { TrustStripBlock } from '../blocks/trust-strip-block';
import { ProductListBlock } from '../blocks/product-list-block';
import { CollectionCarouselBlock } from '../blocks/collection-carousel-block';
import {
  ProductDetailBlock,
  ProductDetailGalleryBlock,
  ProductDetailTitleBlock,
  ProductDetailPriceBlock,
  ProductDetailVariantSelectorBlock,
  ProductDetailQuantityBlock,
  ProductDetailButtonsBlock,
  ProductDetailDescriptionBlock,
  ProductDetailAccordionBlock,
} from '../blocks/product-detail-block';
import { ProductInfoAccordionBlock } from '../blocks/product-info-accordion-block';
import { ProductCategoriesBlock } from '../blocks/product-categories-block';
import { CategoryHeaderBlock } from '../blocks/category-header-block';
import { CategoryBannerBlock } from '../blocks/category-banner-block';
import { CategorySplitBlock } from '../blocks/category-split-block';
import { HeroGalleryBlock } from '../blocks/hero-gallery-block';
import { VideoCarouselBlock } from '../blocks/video-carousel-block';
import { AboutProfileBlock } from '../blocks/about-profile-block';
import { HeroCarouselBlock } from '../blocks/hero-carousel-block';
import { HeroInteractiveBlock } from '../blocks/hero-interactive-block';
import { HeroVideoTextOverlayBlock } from '../blocks/hero-video-text-overlay-block';
import { GalleryAccordionHorizontalBlock } from '../blocks/gallery-accordion-horizontal-block';
import { GalleryAccordionVerticalBlock } from '../blocks/gallery-accordion-vertical-block';
import { FeatureDottedBlock } from '../blocks/feature-dotted-block';
import { CtaBannerBlock } from '../blocks/cta-banner-block';
import { ProductCollectionBlock } from '../blocks/product-collection-block';
import { BadgeBlock } from '../blocks/badge-block';
import { ProgressBarBlock } from '../blocks/progress-bar-block';
import { StatsBlock } from '../blocks/stats-block';
import { QuoteBlock } from '../blocks/quote-block';
import { FormInputBlock } from '../blocks/form-input-block';
import { FormTextareaBlock } from '../blocks/form-textarea-block';
import { FormSelectBlock } from '../blocks/form-select-block';
import { FormCheckboxBlock } from '../blocks/form-checkbox-block';
import { FormRadioBlock } from '../blocks/form-radio-block';
import { ProductCardBlock } from '../blocks/product-card-block';
import { CollectionBannerBlock } from '../blocks/collection-banner-block';
import { NewsletterBlock } from '../blocks/newsletter-block';
import { CartIconBlock } from '../blocks/cart-icon-block';
import { AccountIconBlock } from '../blocks/account-icon-block';
import { GridBlock } from '../blocks/grid-block';
import { FlexBlock } from '../blocks/flex-block';
import { ProductGridBlock } from '../blocks/product-grid-block';
import { FAQBlock } from '../blocks/faq-block';

interface Block {
  id: string;
  type: string;
  settings: Record<string, any>;
  order: number;
  children?: Block[];
}

interface BlockRendererProps {
  block: Block;
  mode?: 'live' | 'edit';
  store?: any;
  previewMode?: 'desktop' | 'tablet' | 'mobile';
  selectedBlockId?: string;
  onSelectBlock?: (blockId: string) => void;
  onMoveBlockUp?: (sectionId: string, blockId: string, blockIndex: number) => void;
  onMoveBlockDown?: (sectionId: string, blockId: string, blockIndex: number) => void;
  onDuplicateBlock?: (sectionId: string, blockId: string) => void;
  onDeleteBlock?: (sectionId: string, blockId: string) => void;
  sectionId?: string;
  parentBlockId?: string;
  blockIndex?: number;
}

// Helper function to replace dynamic content placeholders
function replaceDynamicContent(content: any, store: any): any {
  if (typeof content !== 'string') return content;

  // Replace {{product.field}} with actual product data
  if (content.includes('{{product.')) {
    const products = store?.products || [];
    const product = products[0]; // Use first product for preview

    if (product) {
      return content.replace(/\{\{product\.(\w+)\}\}/g, (match, field) => {
        // Handle special formatting for price
        if (field === 'price' && product[field]) {
          return `$${parseFloat(product[field]).toFixed(2)}`;
        }
        return product[field] || match;
      });
    }
  }

  return content;
}

// Nested block wrapper component to handle hover state
function NestedBlockWrapper({
  child,
  childIndex,
  totalChildren,
  mode,
  store,
  previewMode,
  selectedBlockId,
  onSelectBlock,
  onMoveBlockUp,
  onMoveBlockDown,
  onDuplicateBlock,
  onDeleteBlock,
  sectionId,
  parentBlockId
}: {
  child: Block;
  childIndex: number;
  totalChildren: number;
  mode?: 'live' | 'edit';
  store?: any;
  previewMode?: 'desktop' | 'tablet' | 'mobile';
  selectedBlockId?: string;
  onSelectBlock: (blockId: string) => void;
  onMoveBlockUp?: (sectionId: string, blockId: string, blockIndex: number) => void;
  onMoveBlockDown?: (sectionId: string, blockId: string, blockIndex: number) => void;
  onDuplicateBlock?: (sectionId: string, blockId: string) => void;
  onDeleteBlock?: (sectionId: string, blockId: string) => void;
  sectionId?: string;
  parentBlockId?: string;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const isSelected = selectedBlockId === child.id;
  const canMoveUp = childIndex > 0;
  const canMoveDown = childIndex < totalChildren - 1;

  // For slide containers, we need full height/width to properly fill the slideshow
  const isSlideContainer = child.type === 'slideContainer';

  return (
    <div
      key={child.id}
      className={cn(
        "relative group/nested-block cursor-pointer transition-all",
        isSlideContainer && "w-full h-full",
        isSelected && "outline outline-2 outline-blue-500 outline-offset-2",
        isHovered && !isSelected && "outline outline-1 outline-gray-300"
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={(e) => {
        e.stopPropagation();
        onSelectBlock(child.id);
      }}
    >
      {/* Nested block label on hover/select */}
      {(isHovered || isSelected) && (
        <div className="absolute -top-6 left-0 z-50 bg-gray-900 text-white text-xs px-2 py-0.5 rounded shadow-lg whitespace-nowrap pointer-events-none">
          {child.type.charAt(0).toUpperCase() + child.type.slice(1)}
        </div>
      )}

      {/* Block Action Menu */}
      {(isHovered || isSelected) && (
        <div
          className="absolute -bottom-12 left-1/2 -translate-x-1/2 z-50 flex gap-1 bg-white shadow-lg rounded-md border border-gray-200 p-1"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (sectionId && onMoveBlockUp) {
                onMoveBlockUp(sectionId, child.id, childIndex);
              }
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
              if (sectionId && onMoveBlockDown) {
                onMoveBlockDown(sectionId, child.id, childIndex);
              }
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
              if (sectionId && onDuplicateBlock) {
                onDuplicateBlock(sectionId, child.id);
              }
            }}
            className="p-1.5 rounded hover:bg-gray-100 transition-colors"
            title="Duplicate"
          >
            <Copy className="w-4 h-4" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (sectionId && onDeleteBlock) {
                onDeleteBlock(sectionId, child.id);
              }
            }}
            className="p-1.5 rounded hover:bg-red-50 text-red-600 transition-colors"
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      )}

      <BlockRenderer
        block={child}
        mode={mode}
        store={store}
        previewMode={previewMode}
        selectedBlockId={selectedBlockId}
        onSelectBlock={onSelectBlock}
        onMoveBlockUp={onMoveBlockUp}
        onMoveBlockDown={onMoveBlockDown}
        onDuplicateBlock={onDuplicateBlock}
        onDeleteBlock={onDeleteBlock}
        sectionId={sectionId}
        parentBlockId={parentBlockId}
      />
    </div>
  );
}

export function BlockRenderer({
  block,
  mode = 'live',
  store,
  previewMode = 'desktop',
  selectedBlockId,
  onSelectBlock,
  onMoveBlockUp,
  onMoveBlockDown,
  onDuplicateBlock,
  onDeleteBlock,
  sectionId,
  parentBlockId,
  blockIndex
}: BlockRendererProps) {
  const blockComponents: Record<string, React.ComponentType<any>> = {
    // Original blocks
    text: TextBlock,
    heading: HeadingBlock,
    image: ImageBlock,
    button: ButtonBlock,
    spacer: SpacerBlock,
    video: VideoBlock,
    videoPlayer: VideoPlayerBlock,
    divider: DividerBlock,
    icon: IconBlock,
    container: ContainerBlock,
    columns: ColumnsBlock,

    // Header/Navigation blocks
    navbarShopify: NavbarShopifyBlock,
    navbarMinimal: NavbarMinimalBlock,
    navbarLuxury: NavbarLuxuryBlock,
    hero: HeroBlock,
    featuredCollection: FeaturedCollectionBlock,
    featuredProduct: FeaturedProductBlock,
    logo: LogoBlock,
    menu: MenuBlock,
    search: SearchBlock,
    link: LinkBlock,
    footer: FooterBlock,
    footerAnimated: FooterAnimatedBlock,
    footerTime: FooterTimeBlock,
    footerLogo: FooterLogoBlock,
    footerInfo: FooterInfoBlock,
    footerCopyrightText: FooterCopyrightTextBlock,
    footerTimeDisplay: FooterTimeDisplayBlock,
    footerEmail: FooterEmailBlock,

    // Content blocks
    accordion: AccordionBlock,
    tabs: TabsBlock,
    faq: FAQBlock,
    testimonialCard: TestimonialCardBlock,
    pricingCard: PricingCardBlock,
    countdown: CountdownBlock,
    badge: BadgeBlock,
    quote: QuoteBlock,
    stats: StatsBlock,
    progressBar: ProgressBarBlock,

    // Media blocks
    gallery: GalleryBlock,

    // Utility blocks
    socialIcons: SocialIconsBlock,
    announcementBar: AnnouncementBarBlock,
    trustStrip: TrustStripBlock,
    productList: ProductListBlock,
    collectionCarousel: CollectionCarouselBlock,

    // Form blocks
    formInput: FormInputBlock,
    formTextarea: FormTextareaBlock,
    formSelect: FormSelectBlock,
    formCheckbox: FormCheckboxBlock,
    formRadio: FormRadioBlock,
    emailForm: EmailFormBlock,
    contactFormModern: ContactFormModernBlock,

    // Commerce blocks
    productCard: ProductCardBlock,
    productDetail: ProductDetailBlock,
    collectionBanner: CollectionBannerBlock,
    newsletter: NewsletterBlock,
    cartIcon: CartIconBlock,
    accountIcon: AccountIconBlock,

    // Product detail blocks
    productImageGallery: ProductImageGalleryBlock,
    productTitle: ProductTitleBlock,
    productPrice: ProductPriceBlock,
    productColorSelector: ProductColorSelectorBlock,
    productSizeSelector: ProductSizeSelectorBlock,
    productQuantitySelector: ProductQuantitySelectorBlock,
    productActionButtons: ProductActionButtonsBlock,
    productDescription: ProductDescriptionBlock,
    productPolicyButtons: ProductPolicyButtonsBlock,
    productShippingFeatures: ProductShippingFeaturesBlock,
    productInfoAccordion: ProductInfoAccordionBlock,

    // Product detail sub-blocks (for nested editing)
    productDetailGallery: ProductDetailGalleryBlock,
    productDetailTitle: ProductDetailTitleBlock,
    productDetailPrice: ProductDetailPriceBlock,
    productDetailVariantSelector: ProductDetailVariantSelectorBlock,
    productDetailQuantity: ProductDetailQuantityBlock,
    productDetailButtons: ProductDetailButtonsBlock,
    productDetailDescription: ProductDetailDescriptionBlock,
    productDetailAccordion: ProductDetailAccordionBlock,
    productCategories: ProductCategoriesBlock,
    categoryHeader: CategoryHeaderBlock,
    categoryBanner: CategoryBannerBlock,
    categorySplit: CategorySplitBlock,
    heroGallery: HeroGalleryBlock,
    videoCarousel: VideoCarouselBlock,
    aboutProfile: AboutProfileBlock,
    heroCarousel: HeroCarouselBlock,
    heroInteractive: HeroInteractiveBlock,
    heroVideoTextOverlay: HeroVideoTextOverlayBlock,
    galleryAccordionHorizontal: GalleryAccordionHorizontalBlock,
    galleryAccordionVertical: GalleryAccordionVerticalBlock,
    featureDotted: FeatureDottedBlock,
    ctaBanner: CtaBannerBlock,
    productCollection: ProductCollectionBlock,

    // Layout blocks
    grid: GridBlock,
    flex: FlexBlock,
    productGrid: ProductGridBlock,
    imageBanner: ImageBannerBlock,
    collectionList: CollectionListBlock,
    imageWithText: ImageWithTextBlock,
    multirow: MultirowBlock,
    slideshow: SlideshowBlock,

    // Slideshow blocks
    slideshowContainer: SlideshowContainerBlock,
    slideContainer: SlideContainerBlock,
    slideHeading: SlideHeadingBlock,
    slideText: SlideTextBlock,
    slideButton: SlideButtonBlock,
    heroVideoText: HeroVideoTextBlock,
    heroVideoTextHeading: HeroVideoTextHeadingBlock,
    heroVideoTextDescription: HeroVideoTextDescriptionBlock,
    heroVideoTextButton: HeroVideoTextButtonBlock,
    videoText: VideoTextBlock,
    heroArrowButton: HeroArrowButtonBlock,
    heroVideoBackground: HeroVideoBackgroundBlock,
    heroOverlay: HeroOverlayBlock,
    galleryCarousel: GalleryCarouselBlock,
    galleryAccordion: GalleryAccordionBlock,
    accordionGallery: AccordionGalleryBlock,
    galleryHorizontalAccordion: GalleryHorizontalAccordionBlock,
    horizontalAccordionGallery: HorizontalAccordionGalleryBlock,
    countdownStats: CountdownStatsBlock,
    countdownTimer: CountdownTimerBlock,
  };

  const Component = blockComponents[block.type];

  if (!Component) {
    return (
      <div className="py-4 px-4 text-center text-muted-foreground bg-red-50 border border-red-200 rounded">
        Unknown block type: {block.type}
      </div>
    );
  }

  // Process dynamic content in settings
  const processedSettings = { ...block.settings };

  // Always check for dynamic content in string fields
  Object.keys(processedSettings).forEach(key => {
    if (typeof processedSettings[key] === 'string' && processedSettings[key].includes('{{product.')) {
      processedSettings[key] = replaceDynamicContent(processedSettings[key], store);
    }
  });

  // Filter children based on parent block settings
  let filteredChildren = block.children;
  if (block.type === 'productDetail' && processedSettings.showAccordion === false) {
    filteredChildren = block.children?.filter(child => child.type !== 'productDetailAccordion');
  }

  // Recursively render children for layout blocks
  const renderedChildren = filteredChildren && filteredChildren.length > 0
    ? filteredChildren.map((child, childIndex) => {
        // In edit mode, wrap nested blocks with click handlers and visual feedback
        if (mode === 'edit' && onSelectBlock) {
          return (
            <NestedBlockWrapper
              key={child.id}
              child={child}
              childIndex={childIndex}
              totalChildren={filteredChildren!.length}
              mode={mode}
              store={store}
              previewMode={previewMode}
              selectedBlockId={selectedBlockId}
              onSelectBlock={onSelectBlock}
              onMoveBlockUp={onMoveBlockUp}
              onMoveBlockDown={onMoveBlockDown}
              onDuplicateBlock={onDuplicateBlock}
              onDeleteBlock={onDeleteBlock}
              sectionId={sectionId}
              parentBlockId={block.id}
            />
          );
        }

        // In live mode, just render normally
        return (
          <BlockRenderer
            key={child.id}
            block={child}
            mode={mode}
            store={store}
            previewMode={previewMode}
            selectedBlockId={selectedBlockId}
            onSelectBlock={onSelectBlock}
            onMoveBlockUp={onMoveBlockUp}
            onMoveBlockDown={onMoveBlockDown}
            onDuplicateBlock={onDuplicateBlock}
            onDeleteBlock={onDeleteBlock}
            sectionId={sectionId}
            parentBlockId={block.id}
            blockIndex={childIndex}
          />
        );
      })
    : undefined;

  return (
    <Component
      {...processedSettings}
      settings={processedSettings}
      mode={mode}
      store={store}
      previewMode={previewMode}
      selectedBlockId={selectedBlockId}
    >
      {renderedChildren}
    </Component>
  );
}
