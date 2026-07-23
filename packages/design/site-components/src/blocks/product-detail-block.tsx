"use client";

import React, { useState, useRef } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react';

// ============================================
// Product Gallery Block
// ============================================

interface ProductImage {
  src: string;
  alt?: string;
  thumbnail?: string;
  width?: number;
  height?: number;
}

export interface ProductDetailGalleryBlockProps {
  galleryStyle?: 'grid' | 'thumbnailLeft' | 'thumbnailScroll' | 'masonry';
  imageRounding?: number;
  images?: ProductImage[];
  textColor?: string;
  mode?: 'live' | 'preview' | 'edit';
  store?: {
    products?: any[];
    selectedProduct?: any;
  };
}

const DEFAULT_IMAGES: ProductImage[] = [
  { src: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/Professional-Woman-&-Tote-2.png', alt: 'Product image 1', thumbnail: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/Professional-Woman-&-Tote-1.png' },
  { src: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/Elegant-Professional-Look-2.png', alt: 'Product image 2', thumbnail: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/Elegant-Professional-Look-1.png' },
  { src: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/Stylish-Woman-1-with-Tote-2.png', alt: 'Product image 3', thumbnail: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/Stylish-Woman-1-with-Tote-1.png' },
  { src: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/Minimalist-Fashion-Look-2.png', alt: 'Product image 4', thumbnail: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/Minimalist-Fashion-Look-1.png' },
  { src: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/Woman-with-Leather-Tote-2.png', alt: 'Product image 5', thumbnail: 'https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/Woman-with-Leather-Tote-1.png' },
];

export function ProductDetailGalleryBlock({
  galleryStyle = 'grid',
  imageRounding = 8,
  images,
  textColor = '#171717',
  mode = 'live',
  store,
}: ProductDetailGalleryBlockProps) {
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const thumbnailRef = useRef<HTMLUListElement>(null);

  // Use product images from store if available
  const productImages = store?.selectedProduct?.images;
  const displayImages = productImages && productImages.length > 0 ? productImages : (images || DEFAULT_IMAGES);

  const handlePrevImage = () => {
    setCurrentImageIndex(currentImageIndex === 0 ? displayImages.length - 1 : currentImageIndex - 1);
  };

  const handleNextImage = () => {
    setCurrentImageIndex(currentImageIndex === displayImages.length - 1 ? 0 : currentImageIndex + 1);
  };

  // Gallery Style: Grid
  if (galleryStyle === 'grid') {
    return (
      <div className="w-full">
        {/* Mobile Carousel */}
        <div className="md:hidden">
          <div
            className="relative aspect-square bg-gray-100 overflow-hidden"
            style={{ borderRadius: `${imageRounding}px` }}
          >
            <img
              src={displayImages[currentImageIndex]?.src}
              alt={displayImages[currentImageIndex]?.alt || 'Product image'}
              className="w-full h-full object-cover"
            />
          </div>
          <div className="flex items-center justify-center gap-4 mt-4">
            <button onClick={handlePrevImage} className="p-2 rounded-full hover:bg-gray-100 transition-colors">
              <ChevronLeft className="w-5 h-5" style={{ color: textColor }} />
            </button>
            <span className="text-sm text-gray-500">{currentImageIndex + 1} / {displayImages.length}</span>
            <button onClick={handleNextImage} className="p-2 rounded-full hover:bg-gray-100 transition-colors">
              <ChevronRight className="w-5 h-5" style={{ color: textColor }} />
            </button>
          </div>
        </div>

        {/* Desktop Grid */}
        <div className="hidden md:grid md:grid-cols-2 gap-2">
          {displayImages.slice(0, 5).map((image: ProductImage, index: number) => (
            <div
              key={index}
              className={`aspect-square bg-gray-100 overflow-hidden cursor-pointer ${index === 0 ? 'col-span-2' : ''}`}
              style={{ borderRadius: `${imageRounding}px` }}
              onClick={() => setCurrentImageIndex(index)}
            >
              <img
                src={image.src}
                alt={image.alt || `Product image ${index + 1}`}
                className="w-full h-full object-cover hover:scale-105 transition-transform duration-300"
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Gallery Style: Thumbnail Left
  if (galleryStyle === 'thumbnailLeft') {
    return (
      <div className="w-full">
        <div className="hidden md:flex w-full items-start gap-4">
          {/* Thumbnails */}
          <ul ref={thumbnailRef} className="w-20 shrink-0 flex flex-col gap-2 overflow-y-auto" style={{ maxHeight: '500px' }}>
            {displayImages.map((img: ProductImage, index: number) => (
              <li key={`thumbnail-${index}`} className="w-full shrink-0">
                <button
                  onClick={() => setCurrentImageIndex(index)}
                  className={`relative block size-20 overflow-hidden transition-all ${
                    index === currentImageIndex ? 'ring-2 ring-current' : 'hover:ring-1 hover:ring-gray-300'
                  }`}
                  style={{ borderRadius: `${Math.min(imageRounding, 14)}px` }}
                >
                  <img src={img.thumbnail || img.src} alt={img.alt} className="block size-full object-cover object-center" loading="lazy" />
                </button>
              </li>
            ))}
          </ul>

          {/* Main Image */}
          <div className="flex-1">
            <div className="group/product-photos relative">
              <div className="relative aspect-[4/5] w-full overflow-hidden bg-gray-100" style={{ borderRadius: `${imageRounding}px` }}>
                <img src={displayImages[currentImageIndex]?.src} alt={displayImages[currentImageIndex]?.alt || 'Product image'} className="block size-full object-cover object-center" />
                <div className="hidden opacity-0 group-hover/product-photos:opacity-100 md:block">
                  {currentImageIndex > 0 && (
                    <button onClick={handlePrevImage} className="absolute left-4 top-1/2 -translate-y-1/2 size-11 rounded-full bg-white shadow-lg flex items-center justify-center hover:bg-gray-50 transition-colors">
                      <ChevronLeft className="w-5 h-5" />
                    </button>
                  )}
                  {currentImageIndex < displayImages.length - 1 && (
                    <button onClick={handleNextImage} className="absolute right-4 top-1/2 -translate-y-1/2 size-11 rounded-full bg-white shadow-lg flex items-center justify-center hover:bg-gray-50 transition-colors">
                      <ChevronRight className="w-5 h-5" />
                    </button>
                  )}
                </div>
              </div>
              <div className="absolute bottom-4 left-4 rounded-full bg-white/90 px-3 py-1.5 text-xs font-medium">{currentImageIndex + 1} / {displayImages.length}</div>
            </div>
            <div className="relative my-2 h-[3px] w-full overflow-hidden rounded-lg bg-gray-200">
              <div style={{ width: `${100 / displayImages.length}%`, transform: `translateX(${100 * currentImageIndex}%)` }} className="absolute h-full bg-gray-900 transition-transform duration-300" />
            </div>
          </div>
        </div>

        {/* Mobile View */}
        <div className="md:hidden">
          <div className="relative aspect-square bg-gray-100 overflow-hidden" style={{ borderRadius: `${imageRounding}px` }}>
            <img src={displayImages[currentImageIndex]?.src} alt={displayImages[currentImageIndex]?.alt || 'Product image'} className="w-full h-full object-cover" />
          </div>
          <div className="flex items-center justify-center gap-4 mt-4">
            <button onClick={handlePrevImage} className="p-2 rounded-full hover:bg-gray-100 transition-colors">
              <ChevronLeft className="w-5 h-5" style={{ color: textColor }} />
            </button>
            <span className="text-sm text-gray-500">{currentImageIndex + 1} / {displayImages.length}</span>
            <button onClick={handleNextImage} className="p-2 rounded-full hover:bg-gray-100 transition-colors">
              <ChevronRight className="w-5 h-5" style={{ color: textColor }} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Gallery Style: Thumbnail Scroll
  if (galleryStyle === 'thumbnailScroll') {
    return (
      <div className="w-full">
        <div className="relative flex gap-5">
          {/* Sticky thumbnails */}
          <div className="sticky top-5 hidden self-start lg:block">
            <ol className="flex max-h-[calc(100dvh-2.5rem)] w-fit flex-col gap-4 overflow-y-auto p-px">
              {displayImages.map((img: ProductImage, index: number) => (
                <li key={`thumbnail-scroll-${index}`} className="w-14 shrink-0 grow-0">
                  <button
                    onClick={() => setCurrentImageIndex(index)}
                    className={`block aspect-square w-14 overflow-hidden transition-shadow duration-200 ${
                      index === currentImageIndex ? 'ring-2 ring-gray-900' : 'hover:ring-1 hover:ring-gray-300'
                    }`}
                    style={{ borderRadius: `${Math.min(imageRounding, 14)}px` }}
                  >
                    <img src={img.thumbnail || img.src} alt={img.alt} className="block size-full object-cover object-center" />
                  </button>
                </li>
              ))}
            </ol>
          </div>

          {/* Vertical image list (desktop) */}
          <div className="w-full hidden lg:flex flex-col gap-2">
            {displayImages.map((img: ProductImage, index: number) => (
              <div key={`scroll-image-${index}`} className="aspect-square overflow-hidden" style={{ borderRadius: `${imageRounding}px` }}>
                <img src={img.src} alt={img.alt} className="block size-full object-cover object-center cursor-pointer hover:scale-[1.02] transition-transform" onClick={() => setCurrentImageIndex(index)} />
              </div>
            ))}
          </div>

          {/* Mobile carousel */}
          <div className="lg:hidden w-full">
            <div className="relative aspect-square bg-gray-100 overflow-hidden" style={{ borderRadius: `${imageRounding}px` }}>
              <img src={displayImages[currentImageIndex]?.src} alt={displayImages[currentImageIndex]?.alt || 'Product image'} className="w-full h-full object-cover" />
            </div>
            <div className="flex items-center justify-center mt-4">
              <ol className="flex items-center justify-center">
                {displayImages.map((_: ProductImage, index: number) => (
                  <button onClick={() => setCurrentImageIndex(index)} key={`indicator-${index}`} className="flex size-5.5 p-1">
                    <span className={`m-auto block size-1.5 rounded-full transition-colors ${index === currentImageIndex ? 'bg-gray-900' : 'bg-gray-300'}`} />
                  </button>
                ))}
              </ol>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Gallery Style: Masonry
  return (
    <div className="w-full">
      {/* Desktop Masonry Grid */}
      <div className="hidden md:flex flex-col gap-0">
        <div className="w-full grid grid-cols-2">
          {displayImages.map((img: ProductImage, index: number) => (
            <div key={`masonry-${index}`} className={`overflow-hidden cursor-pointer ${index === 0 ? 'col-span-2' : ''}`} style={{ borderRadius: `${imageRounding}px` }}>
              <div className="aspect-[4/5]">
                <img src={img.src} alt={img.alt} className="block size-full object-cover object-center hover:scale-[1.02] transition-transform" onClick={() => setCurrentImageIndex(index)} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Mobile Carousel */}
      <div className="md:hidden">
        <div className="relative aspect-[4/5] bg-gray-100 overflow-hidden" style={{ borderRadius: `${imageRounding}px` }}>
          <img src={displayImages[currentImageIndex]?.src} alt={displayImages[currentImageIndex]?.alt || 'Product image'} className="w-full h-full object-cover" />
        </div>
        <div className="my-3 flex items-center justify-center">
          <ol className="flex items-center justify-center">
            {displayImages.map((_: ProductImage, index: number) => (
              <button onClick={() => setCurrentImageIndex(index)} key={`masonry-indicator-${index}`} className="flex size-4 p-0.5">
                <span className={`m-auto block size-2 rounded-full transition-colors ${index === currentImageIndex ? 'bg-gray-900' : 'bg-gray-300'}`} />
              </button>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

// ============================================
// Product Detail Title Block
// ============================================

export interface ProductDetailTitleBlockProps {
  title?: string;
  textColor?: string;
  fontSize?: 'sm' | 'md' | 'lg' | 'xl';
  fontWeight?: 'normal' | 'medium' | 'semibold' | 'bold';
  mode?: 'live' | 'preview' | 'edit';
  store?: {
    products?: any[];
    selectedProduct?: any;
  };
}

export function ProductDetailTitleBlock({
  title = 'Maison Liora Bag',
  textColor = '#171717',
  fontSize = 'lg',
  fontWeight = 'normal',
  mode = 'live',
  store,
}: ProductDetailTitleBlockProps) {
  const displayTitle = store?.selectedProduct?.name || title;

  const fontSizeClass = {
    sm: 'text-xl md:text-2xl',
    md: 'text-2xl md:text-3xl',
    lg: 'text-3xl md:text-4xl',
    xl: 'text-4xl md:text-5xl',
  }[fontSize];

  const fontWeightClass = {
    normal: 'font-normal',
    medium: 'font-medium',
    semibold: 'font-semibold',
    bold: 'font-bold',
  }[fontWeight];

  return (
    <h1 className={`${fontSizeClass} ${fontWeightClass}`} style={{ color: textColor }}>
      {displayTitle}
    </h1>
  );
}

// ============================================
// Product Detail Price Block
// ============================================

export interface ProductDetailPriceBlockProps {
  price?: number;
  salePrice?: number;
  currency?: string;
  textColor?: string;
  mode?: 'live' | 'preview' | 'edit';
  store?: {
    products?: any[];
    selectedProduct?: any;
  };
}

export function ProductDetailPriceBlock({
  price = 420.00,
  salePrice,
  currency = 'USD',
  textColor = '#171717',
  mode = 'live',
  store,
}: ProductDetailPriceBlockProps) {
  const displayPrice = store?.selectedProduct?.price || price;
  const displaySalePrice = store?.selectedProduct?.salePrice || salePrice;
  const displayCurrency = store?.selectedProduct?.currency || currency;

  const formatPrice = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: displayCurrency,
    }).format(amount);
  };

  return (
    <div className="flex items-baseline gap-3">
      {displaySalePrice ? (
        <>
          <span className="text-2xl" style={{ color: textColor }}>
            {formatPrice(displaySalePrice)}
          </span>
          <span className="text-xl text-gray-400 line-through">
            {formatPrice(displayPrice)}
          </span>
        </>
      ) : (
        <span className="text-2xl" style={{ color: textColor }}>
          {formatPrice(displayPrice)}
        </span>
      )}
    </div>
  );
}

// ============================================
// Product Detail Variant Selector Block
// ============================================

interface VariantOption {
  id: string;
  label: string;
  value: string;
  inStock?: boolean;
}

export interface ProductDetailVariantSelectorBlockProps {
  label?: string;
  options?: VariantOption[];
  textColor?: string;
  mode?: 'live' | 'preview' | 'edit';
  store?: {
    products?: any[];
    selectedProduct?: any;
  };
}

export function ProductDetailVariantSelectorBlock({
  label = 'Color',
  options = [
    { id: 'green', label: 'Green', value: 'green', inStock: true },
    { id: 'black', label: 'Black', value: 'black', inStock: true },
    { id: 'white', label: 'White', value: 'white', inStock: false },
    { id: 'red', label: 'Red', value: 'red', inStock: false },
  ],
  textColor = '#171717',
  mode = 'live',
  store,
}: ProductDetailVariantSelectorBlockProps) {
  const [selectedValue, setSelectedValue] = useState(options.find(o => o.inStock)?.value || options[0]?.value);

  return (
    <div>
      <label className="text-sm text-gray-500 mb-2 block">{label}</label>
      <div className="flex flex-wrap gap-3">
        {options.map((option) => (
          <button
            key={option.id}
            onClick={() => option.inStock && setSelectedValue(option.value)}
            disabled={!option.inStock}
            className={`px-4 py-2 text-sm border rounded-md transition-colors ${
              selectedValue === option.value
                ? 'bg-gray-900 text-white border-gray-900'
                : option.inStock
                  ? 'border-gray-900 hover:bg-gray-100'
                  : 'border-gray-200 text-gray-400 line-through cursor-not-allowed'
            }`}
            style={selectedValue === option.value ? {} : { color: option.inStock ? textColor : undefined }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ============================================
// Product Detail Quantity Block
// ============================================

export interface ProductDetailQuantityBlockProps {
  label?: string;
  textColor?: string;
  mode?: 'live' | 'preview' | 'edit';
  store?: {
    products?: any[];
    selectedProduct?: any;
  };
}

export function ProductDetailQuantityBlock({
  label = 'Quantity',
  textColor = '#171717',
  mode = 'live',
  store,
}: ProductDetailQuantityBlockProps) {
  const [quantity, setQuantity] = useState(1);

  const decreaseQuantity = () => setQuantity(prev => Math.max(1, prev - 1));
  const increaseQuantity = () => setQuantity(prev => Math.min(99, prev + 1));

  return (
    <div>
      <label className="text-sm text-gray-500 mb-2 block">{label}</label>
      <div className="flex items-center w-32 border border-gray-200 rounded-md overflow-hidden">
        <button onClick={decreaseQuantity} className="p-2 hover:bg-gray-100 transition-colors">
          <Minus className="w-4 h-4 text-gray-500" />
        </button>
        <input
          type="number"
          value={quantity}
          onChange={(e) => {
            const val = parseInt(e.target.value);
            if (!isNaN(val) && val >= 1 && val <= 99) setQuantity(val);
          }}
          className="w-full text-center text-sm py-2 border-0 focus:outline-none focus:ring-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          style={{ color: textColor, backgroundColor: 'transparent' }}
          min={1}
          max={99}
        />
        <button onClick={increaseQuantity} className="p-2 hover:bg-gray-100 transition-colors">
          <Plus className="w-4 h-4 text-gray-500" />
        </button>
      </div>
    </div>
  );
}

// ============================================
// Product Detail Buttons Block
// ============================================

export interface ProductDetailButtonsBlockProps {
  addToCartText?: string;
  buyNowText?: string;
  showAddToCart?: boolean;
  showBuyNow?: boolean;
  textColor?: string;
  mode?: 'live' | 'preview' | 'edit';
  store?: {
    products?: any[];
    selectedProduct?: any;
  };
}

export function ProductDetailButtonsBlock({
  addToCartText = 'Add to cart',
  buyNowText = 'Purchase',
  showAddToCart = true,
  showBuyNow = true,
  textColor = '#171717',
  mode = 'live',
  store,
}: ProductDetailButtonsBlockProps) {
  return (
    <div className="flex flex-col gap-3">
      {showAddToCart && (
        <button
          className="w-full py-3 px-4 border border-gray-900 text-sm font-medium rounded-md hover:bg-gray-100 transition-colors"
          style={{ color: textColor }}
          onClick={(e) => mode !== 'live' && e.preventDefault()}
        >
          {addToCartText}
        </button>
      )}
      {showBuyNow && (
        <button
          className="w-full py-3 px-4 bg-gray-900 text-white text-sm font-medium rounded-md hover:bg-gray-800 transition-colors"
          onClick={(e) => mode !== 'live' && e.preventDefault()}
        >
          {buyNowText}
        </button>
      )}
    </div>
  );
}

// ============================================
// Product Detail Description Block
// ============================================

export interface ProductDetailDescriptionBlockProps {
  description?: string;
  textColor?: string;
  mode?: 'live' | 'preview' | 'edit';
  store?: {
    products?: any[];
    selectedProduct?: any;
  };
}

export function ProductDetailDescriptionBlock({
  description = 'Our sculptural, soft-structured handbag brings elegance and utility together in one refined piece. With a simple adjustment, it transforms from a shoulder bag to a top-handle or crossbody companion.',
  textColor = '#171717',
  mode = 'live',
  store,
}: ProductDetailDescriptionBlockProps) {
  const displayDescription = store?.selectedProduct?.description || description;

  return (
    <p className="text-base leading-relaxed" style={{ color: textColor, opacity: 0.6 }}>
      {displayDescription}
    </p>
  );
}

// ============================================
// Product Detail Accordion Block
// ============================================

interface AccordionItem {
  id: string;
  title: string;
  content: string;
}

export interface ProductDetailAccordionBlockProps {
  items?: AccordionItem[];
  textColor?: string;
  borderColor?: string;
  mode?: 'live' | 'preview' | 'edit';
  store?: {
    products?: any[];
    selectedProduct?: any;
  };
}

const DEFAULT_ACCORDION_ITEMS: AccordionItem[] = [
  { id: 'composition', title: 'Composition', content: 'Made from premium pebbled leather with a structured silhouette. Fully lined in soft cotton twill. Accented with brushed gold-tone hardware.' },
  { id: 'delivery', title: 'Delivery & Returns', content: 'Enjoy complimentary shipping and easy returns on all purchases. Orders within the U.S. typically ship within 5–7 business days.' },
  { id: 'dimensions', title: 'Dimensions', content: 'Height: 21 cm × Width: 28 cm (8.3" × 11") — comfortably fits daily essentials.' },
  { id: 'care', title: 'Care Guide', content: 'Wipe gently with a clean, damp cloth. Avoid harsh cleaners and direct exposure to sunlight or moisture.' },
];

export function ProductDetailAccordionBlock({
  items = DEFAULT_ACCORDION_ITEMS,
  textColor = '#171717',
  borderColor = '#e5e5e5',
  mode = 'live',
  store,
}: ProductDetailAccordionBlockProps) {
  const [openItem, setOpenItem] = useState<string | null>(null);
  const displayItems = store?.selectedProduct?.info || items;

  const toggleItem = (id: string) => setOpenItem(prev => prev === id ? null : id);

  return (
    <div className="w-full border-t" style={{ borderColor }}>
      {displayItems.map((item: AccordionItem) => (
        <div key={item.id} className="border-b" style={{ borderColor }}>
          <button onClick={() => toggleItem(item.id)} className="w-full py-4 flex items-center justify-between text-left">
            <span className="text-base font-normal" style={{ color: textColor }}>{item.title}</span>
            <ChevronRight className={`w-4 h-4 transition-transform duration-200 ${openItem === item.id ? 'rotate-90' : ''}`} style={{ color: textColor, opacity: 0.5 }} />
          </button>
          {openItem === item.id && (
            <div className="pb-4">
              <p className="text-base leading-relaxed" style={{ color: textColor, opacity: 0.6 }}>{item.content}</p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ============================================
// Main Product Detail Block (Container)
// ============================================

export interface ProductDetailBlockProps {
  productId?: string;
  galleryStyle?: 'grid' | 'thumbnailLeft' | 'thumbnailScroll' | 'masonry';
  imageRounding?: number;
  backgroundColor?: string;
  textColor?: string;
  showAccordion?: boolean;
  mode?: 'live' | 'preview' | 'edit';
  store?: {
    products?: any[];
  };
  children?: React.ReactNode;
}

export function ProductDetailBlock({
  productId,
  galleryStyle = 'grid',
  imageRounding = 8,
  backgroundColor = '#ffffff',
  textColor = '#171717',
  showAccordion = true,
  mode = 'live',
  store,
  children,
}: ProductDetailBlockProps) {
  // If children are provided, separate gallery from info blocks based on order
  // First child is gallery, rest are info blocks
  if (children) {
    const childArray = React.Children.toArray(children);
    const galleryChild = childArray[0]; // First child is the gallery
    const infoChildren = childArray.slice(1); // Rest are info blocks

    return (
      <section className="py-16 md:py-24" style={{ backgroundColor }}>
        <div className="max-w-6xl mx-auto px-5">
          <div className="flex flex-col md:flex-row gap-8 md:gap-12">
            {/* Gallery Column */}
            <div className="md:w-[60%]">
              {galleryChild}
            </div>

            {/* Info Column */}
            <div className="md:w-[40%]">
              <div className="sticky top-24 space-y-6">
                {infoChildren}
              </div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  // Default rendering when no children (standalone mode)
  return (
    <section className="py-16 md:py-24" style={{ backgroundColor }}>
      <div className="max-w-6xl mx-auto px-5">
        <div className="flex flex-col md:flex-row gap-8 md:gap-12">
          {/* Gallery Column */}
          <div className="md:w-[60%]">
            <ProductDetailGalleryBlock
              galleryStyle={galleryStyle}
              imageRounding={imageRounding}
              textColor={textColor}
              mode={mode}
              store={store}
            />
          </div>

          {/* Info Column */}
          <div className="md:w-[40%]">
            <div className="sticky top-24 space-y-6">
              <ProductDetailTitleBlock textColor={textColor} mode={mode} store={store} />
              <ProductDetailPriceBlock textColor={textColor} mode={mode} store={store} />
              <ProductDetailVariantSelectorBlock label="Color" textColor={textColor} mode={mode} store={store} />
              <ProductDetailVariantSelectorBlock
                label="Material"
                options={[
                  { id: 'leather', label: 'Leather', value: 'leather', inStock: true },
                  { id: 'polyester', label: 'Polyester', value: 'polyester', inStock: true },
                  { id: 'nylon', label: 'Nylon', value: 'nylon', inStock: true },
                ]}
                textColor={textColor}
                mode={mode}
                store={store}
              />
              <ProductDetailQuantityBlock textColor={textColor} mode={mode} store={store} />
              <ProductDetailButtonsBlock textColor={textColor} mode={mode} store={store} />
              <ProductDetailDescriptionBlock textColor={textColor} mode={mode} store={store} />
              <ProductDetailAccordionBlock textColor={textColor} mode={mode} store={store} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
