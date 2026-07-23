"use client";

import React, { useState } from 'react';
import { ProductImageGalleryElement } from '../elements/product-image-gallery-element';
import { ProductInfoHeaderElement } from '../elements/product-info-header-element';
import { ProductTitleRatingElement } from '../elements/product-title-rating-element';
import { ProductPriceDisplayElement } from '../elements/product-price-display-element';
import { ProductSizeSelectorElement } from '../elements/product-size-selector-element';
import { ProductQuantitySelectorElement } from '../elements/product-quantity-selector-element';
import { ProductActionButtonsElement } from '../elements/product-action-buttons-element';
import { ProductDescriptionElement } from '../elements/product-description-element';
import { ProductPolicyButtonsElement } from '../elements/product-policy-buttons-element';

interface Block {
  id: string;
  type: string;
  settings: Record<string, any>;
  order: number;
  children?: Block[];
}

interface FeaturedProductSectionProps {
  productName?: string;
  productDescription?: string;
  price?: number;
  compareAtPrice?: number;
  imageUrl?: string;
  imagePosition?: 'left' | 'right';
  showRating?: boolean;
  rating?: number;
  reviews?: number;
  backgroundColor?: string;
  buttonText?: string;
  buttonColor?: string;
  paddingTop?: number;
  paddingBottom?: number;
  store?: any;
  product?: any;
  productId?: string;
  storeName?: string;
  images?: string[];
  blocks?: Block[];
  selectedBlockId?: string;
  isEditing?: boolean;
  onSelectBlock?: (blockId: string) => void;
}

export function FeaturedProductSection({
  productName: propProductName,
  productDescription: propProductDescription,
  price: propPrice,
  compareAtPrice: propCompareAtPrice,
  imageUrl: propImageUrl,
  imagePosition = 'left',
  showRating = true,
  rating: propRating,
  reviews: propReviews,
  backgroundColor = '#ffffff',
  buttonText = 'Koop nu',
  buttonColor = '#000000',
  paddingTop = 0,
  paddingBottom = 0,
  store,
  product,
  productId,
  storeName: propStoreName,
  images: propImages,
  blocks = [],
  selectedBlockId,
  isEditing = false,
  onSelectBlock,
}: FeaturedProductSectionProps) {
  const [quantity, setQuantity] = useState(1);
  const [activeImage, setActiveImage] = useState(0);
  const [selectedSize, setSelectedSize] = useState('big (4.2 oz)');

  // Use product data if available
  const selectedProduct = product || (productId && store?.products?.find((p: any) => p.id === productId));

  const productName = selectedProduct?.name || propProductName || 'glazing milk';
  const productDescription = selectedProduct?.description || propProductDescription || 'The essential prep step for your skincare routine. Glazing Milk is a potent, nutrient-rich complex with a milky texture that leaves skin feeling hydrated and glowy while boosting the skin barrier over time.';
  const price = selectedProduct?.price || propPrice || 32.00;
  const compareAtPrice = selectedProduct?.compareAtPrice || propCompareAtPrice;
  const storeName = selectedProduct?.storeName || propStoreName || 'rhode';
  const rating = selectedProduct?.rating || propRating || 4.8;
  const reviewCount = selectedProduct?.reviews || propReviews || 14600;

  const defaultImages = [
    propImageUrl || 'https://images.unsplash.com/photo-1620916566398-39f1143ab7be?w=800&h=800&fit=crop',
    'https://images.unsplash.com/photo-1556228720-195a672e8a03?w=800&h=800&fit=crop',
    'https://images.unsplash.com/photo-1556228577-2f1a7a2e7c8d?w=800&h=800&fit=crop',
    'https://images.unsplash.com/photo-1556228578-0d85b1a4d571?w=800&h=800&fit=crop',
  ];

  const finalImages = selectedProduct?.images || propImages || defaultImages;

  // Helper to render block with selection UI
  const renderBlock = (blockId: string, blockType: string, children: React.ReactNode) => {
    const isSelected = selectedBlockId === blockId;
    const handleClick = (e: React.MouseEvent) => {
      if (isEditing && onSelectBlock) {
        e.stopPropagation();
        onSelectBlock(blockId);
      }
    };

    return (
      <div
        key={blockId}
        className={`relative ${isEditing ? 'hover:ring-2 hover:ring-blue-400 hover:ring-inset rounded-lg cursor-pointer' : ''} ${isSelected ? 'ring-2 ring-blue-500 ring-inset rounded-lg' : ''}`}
        onClick={handleClick}
      >
        {isEditing && isSelected && (
          <div className="absolute -top-7 left-0 z-50 bg-blue-500 text-white text-xs px-2 py-1 rounded">
            {getBlockLabel(blockType)}
          </div>
        )}
        {children}
      </div>
    );
  };

  // Get block label for display
  const getBlockLabel = (type: string) => {
    const labels: Record<string, string> = {
      'productImageGallery': 'Image Gallery',
      'productInfoHeader': 'Store Info',
      'productTitleRating': 'Title & Rating',
      'productPriceDisplay': 'Price',
      'productSizeSelector': 'Size Selector',
      'productQuantitySelector': 'Quantity',
      'productActionButtons': 'Action Buttons',
      'productDescription': 'Description',
      'productPolicyButtons': 'Policy Buttons',
    };
    return labels[type] || type;
  };

  // Get blocks or create default ones
  const productBlocks = blocks.length > 0 ? blocks : [
    { id: 'product-gallery', type: 'productImageGallery', settings: {}, order: 0 },
    { id: 'product-store-header', type: 'productInfoHeader', settings: {}, order: 1 },
    { id: 'product-title', type: 'productTitleRating', settings: {}, order: 2 },
    { id: 'product-price', type: 'productPriceDisplay', settings: {}, order: 3 },
    { id: 'product-size', type: 'productSizeSelector', settings: {}, order: 4 },
    { id: 'product-quantity', type: 'productQuantitySelector', settings: {}, order: 5 },
    { id: 'product-actions', type: 'productActionButtons', settings: {}, order: 6 },
    { id: 'product-desc', type: 'productDescription', settings: {}, order: 7 },
    { id: 'product-policy', type: 'productPolicyButtons', settings: {}, order: 8 },
  ];

  // Find specific blocks
  const galleryBlock = productBlocks.find(b => b.type === 'productImageGallery');
  const infoHeaderBlock = productBlocks.find(b => b.type === 'productInfoHeader');
  const titleRatingBlock = productBlocks.find(b => b.type === 'productTitleRating');
  const priceBlock = productBlocks.find(b => b.type === 'productPriceDisplay');
  const sizeBlock = productBlocks.find(b => b.type === 'productSizeSelector');
  const quantityBlock = productBlocks.find(b => b.type === 'productQuantitySelector');
  const actionsBlock = productBlocks.find(b => b.type === 'productActionButtons');
  const descBlock = productBlocks.find(b => b.type === 'productDescription');
  const policyBlock = productBlocks.find(b => b.type === 'productPolicyButtons');

  return (
    <section
      style={{
        backgroundColor,
        paddingTop: `${paddingTop}px`,
        paddingBottom: `${paddingBottom}px`,
        width: '100%',
        padding: '3rem 1rem'
      }}
    >
      <div style={{ maxWidth: '1280px', margin: '0 auto' }}>
        <div className="md:flex-row" style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '2rem',
          columnGap: '4rem'
        }}>
          {/* Left Side - Product Images (60%) */}
          {galleryBlock && renderBlock(
            galleryBlock.id,
            galleryBlock.type,
            <ProductImageGalleryElement
              images={finalImages}
              productName={productName}
              activeImage={activeImage}
              onImageChange={setActiveImage}
              {...galleryBlock.settings}
            />
          )}

          {/* Right Side - Product Info (40%) */}
          <div style={{
            flex: '1 1 auto',
            width: '100%'
          }} className="md:max-w-[40%]">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              {/* Store Name */}
              {infoHeaderBlock && renderBlock(
                infoHeaderBlock.id,
                infoHeaderBlock.type,
                <ProductInfoHeaderElement
                  storeName={storeName}
                  {...infoHeaderBlock.settings}
                />
              )}

              {/* Product Name & Rating */}
              {titleRatingBlock && renderBlock(
                titleRatingBlock.id,
                titleRatingBlock.type,
                <ProductTitleRatingElement
                  productName={productName}
                  showRating={showRating}
                  rating={rating}
                  reviewCount={reviewCount}
                  {...titleRatingBlock.settings}
                />
              )}

              {/* Price & Shipping */}
              {priceBlock && renderBlock(
                priceBlock.id,
                priceBlock.type,
                <ProductPriceDisplayElement
                  price={price}
                  compareAtPrice={compareAtPrice}
                  {...priceBlock.settings}
                />
              )}

              {/* Size Selection */}
              {sizeBlock && renderBlock(
                sizeBlock.id,
                sizeBlock.type,
                <ProductSizeSelectorElement
                  selectedSize={selectedSize}
                  onSizeChange={setSelectedSize}
                  buttonColor={buttonColor}
                  {...sizeBlock.settings}
                />
              )}

              {/* Quantity Selector */}
              {quantityBlock && renderBlock(
                quantityBlock.id,
                quantityBlock.type,
                <ProductQuantitySelectorElement
                  quantity={quantity}
                  onQuantityChange={setQuantity}
                  {...quantityBlock.settings}
                />
              )}

              {/* Action Buttons */}
              {actionsBlock && renderBlock(
                actionsBlock.id,
                actionsBlock.type,
                <ProductActionButtonsElement
                  buyNowText={buttonText}
                  buttonColor={buttonColor}
                  textColor="#000000"
                  {...actionsBlock.settings}
                />
              )}

              {/* Description & Store Link */}
              {descBlock && renderBlock(
                descBlock.id,
                descBlock.type,
                <ProductDescriptionElement
                  description={productDescription}
                  storeName={storeName}
                  {...descBlock.settings}
                />
              )}

              {/* Policy Buttons */}
              {policyBlock && renderBlock(
                policyBlock.id,
                policyBlock.type,
                <ProductPolicyButtonsElement {...policyBlock.settings} />
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
