"use client";

import React, { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Star, Heart, ChevronLeft, ChevronRight, Minus, Plus, ChevronDown, Truck, Store, Undo2 } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';

// Shop app style with 60/40 split

export interface FeaturedProductBlockProps {
  layout?: 'image-left' | 'image-right' | 'image-top';
  productHandle?: string;
  heading?: string;
  description?: string;
  price?: string;
  compareAtPrice?: string;
  imageUrl?: string;
  imageAspectRatio?: 'square' | 'portrait' | 'landscape';
  showQuantitySelector?: boolean;
  buttonText?: string;
  buttonVariant?: 'primary' | 'secondary' | 'outline';
  showBadge?: boolean;
  badgeText?: string;
  badgeColor?: string;
  backgroundColor?: string;
  textColor?: string;
  mode?: 'live' | 'edit' | 'preview';
  store?: any;
  storeName?: string;
  rating?: number;
  reviewCount?: number;
  images?: string[];
  settings?: any;
  showSizeSelector?: boolean;
  showColorSelector?: boolean;
  showReviews?: boolean;
  showFAQ?: boolean;
  showShippingPolicy?: boolean;
  showRefundPolicy?: boolean;
}

export function FeaturedProductBlock({
  layout = 'image-left',
  productHandle = '',
  heading = 'Glazing Milk',
  description = 'The essential prep step for your skincare routine. Glazing Milk is a potent, nutrient-rich complex with a milky texture that leaves skin feeling hydrated and glowy while boosting the skin barrier over time. This luxurious formula combines powerful ingredients to deliver deep hydration and nourishment. Experience the transformative benefits of our carefully crafted blend, designed to enhance your natural radiance and promote healthy, glowing skin. Perfect for all skin types, this product absorbs quickly without leaving a greasy residue. Our advanced formulation includes premium botanical extracts and cutting-edge skincare technology to provide visible results. Each application helps to strengthen your skin\'s protective barrier while delivering intense moisture that lasts throughout the day. The lightweight, non-comedogenic formula is ideal for daily use and works beautifully under makeup.',
  price = '32.00',
  compareAtPrice = '',
  imageUrl = 'https://images.unsplash.com/photo-1620916566398-39f1143ab7be?w=800&h=800&fit=crop',
  imageAspectRatio = 'square',
  showQuantitySelector = true,
  buttonText = 'Koop nu',
  buttonVariant = 'primary',
  showBadge = false,
  badgeText = 'Sale',
  badgeColor = '#dc2626',
  backgroundColor = '#ffffff',
  textColor = '#000000',
  mode = 'live',
  store,
  storeName = 'rhode',
  rating = 4.8,
  reviewCount = 14600,
  images = [
    'https://images.unsplash.com/photo-1620916566398-39f1143ab7be?w=800&h=800&fit=crop',
    'https://images.unsplash.com/photo-1556228720-195a672e8a03?w=800&h=800&fit=crop',
    'https://images.unsplash.com/photo-1556228577-2f1a7a2e7c8d?w=800&h=800&fit=crop',
    'https://images.unsplash.com/photo-1556228578-0d85b1a4d571?w=800&h=800&fit=crop',
  ],
  settings = {},
  showSizeSelector = true,
  showColorSelector = true,
  showReviews = false,
  showFAQ = true,
  showShippingPolicy = true,
  showRefundPolicy = true,
}: FeaturedProductBlockProps) {
  const isEditing = mode === 'edit' || mode === 'preview';
  const [quantity, setQuantity] = React.useState(1);
  const [activeImage, setActiveImage] = useState(0);
  const [selectedSize, setSelectedSize] = useState('XS');
  const [selectedColor, setSelectedColor] = useState('Black');
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(null);

  // Get product from store if handle is provided
  const product = store?.products?.find((p: any) => p.handle === productHandle);

  // Use product data if available, otherwise use settings
  const finalHeading = product?.name || heading;
  const finalDescription = product?.description || description;
  const finalPrice = product?.price || price;
  const finalImages = product?.images || images;

  // Use settings for available sizes, colors, and FAQ items
  const availableSizes = settings.availableSizes || ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
  const availableColors = settings.availableColors || [
    { name: 'Black', color: '#000000' },
    { name: 'White', color: '#FFFFFF' },
    { name: 'Gray', color: '#9CA3AF' },
    { name: 'Blue', color: '#3B82F6' },
    { name: 'Red', color: '#EF4444' },
    { name: 'Green', color: '#10B981' },
  ];
  const faqItems = settings.faqItems || [
    {
      question: 'What is your return policy?',
      answer: 'We offer a 30-day return policy for all unused items in their original packaging. Simply contact our customer service team to initiate a return.'
    },
    {
      question: 'How long does shipping take?',
      answer: 'Standard shipping typically takes 5-7 business days. Express shipping options are available at checkout for faster delivery.'
    },
    {
      question: 'Is this product covered by warranty?',
      answer: 'Yes, all our products come with a 1-year manufacturer warranty covering defects in materials and workmanship.'
    }
  ];

  const hasCompareAtPrice = compareAtPrice && parseFloat(compareAtPrice) > parseFloat(finalPrice);

  return (
    <div
      className="w-full py-12 md:py-16"
      style={{ backgroundColor }}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col md:flex-row gap-6 md:gap-12 md:items-end">
          {/* Left Side - Product Images */}
          <div className="w-full" style={{ flex: '0 0 70%' }}>
            {/* Main Image */}
            <div className="relative mb-4 rounded-xl overflow-hidden bg-muted aspect-square">
              <img
                src={finalImages[activeImage]}
                alt={finalHeading}
                className="w-full h-full object-cover"
              />
              {showBadge && badgeText && (
                <div
                  className="absolute top-4 left-4 px-3 py-1 rounded-full text-white text-sm font-semibold"
                  style={{ backgroundColor: badgeColor }}
                >
                  {badgeText}
                </div>
              )}
            </div>

            {/* Thumbnail Gallery */}
            <div className="flex items-center gap-2.5">
              <div className="flex gap-2 flex-1 overflow-x-auto">
                {finalImages.map((image: string, index: number) => (
                  <button
                    key={index}
                    onClick={() => setActiveImage(index)}
                    className={cn(
                      "relative w-16 h-16 rounded-lg transition-all flex-shrink-0 cursor-pointer",
                      activeImage === index
                        ? "border-2 border-black"
                        : ""
                    )}
                  >
                    <img
                      src={image}
                      alt={`${finalHeading} ${index + 1}`}
                      className="w-full h-full object-cover rounded-md"
                    />
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  className="rounded-full h-9 w-9 shadow-none"
                  onClick={() => setActiveImage(Math.max(0, activeImage - 1))}
                  disabled={activeImage === 0}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="rounded-full h-9 w-9 shadow-none"
                  onClick={() => setActiveImage(Math.min(finalImages.length - 1, activeImage + 1))}
                  disabled={activeImage === finalImages.length - 1}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>

          {/* Right Side - Product Info */}
          <div className="w-full" style={{ flex: '0 0 30%', minWidth: 0 }}>
            <div className="flex flex-col h-full">
              <div className="flex-grow">
                {/* Product Name */}
                <div>
                  <h1 className="text-3xl md:text-4xl font-bold mb-2" style={{ color: textColor }}>
                    {finalHeading}
                  </h1>
                  {/* Rating */}
                  <div className="flex items-center gap-2 mb-2">
                    <div className="flex items-center">
                      {[...Array(5)].map((_, i) => (
                        <Star
                          key={i}
                          className={cn(
                            "h-4 w-4",
                            i < Math.floor(rating)
                              ? "fill-primary text-primary"
                              : "fill-muted text-muted"
                          )}
                        />
                      ))}
                    </div>
                    <button className="text-sm underline" style={{ color: textColor }}>
                      {reviewCount.toLocaleString()} beoordelingen
                    </button>
                  </div>
                </div>

                {/* Price */}
                <div className="text-lg font-medium" style={{ color: textColor, marginTop: '4px' }}>
                  €110
                  {hasCompareAtPrice && (
                    <span className="text-sm line-through opacity-50 ml-2">
                      €{parseFloat(compareAtPrice).toFixed(0)}
                    </span>
                  )}
                </div>

                {/* Color Selection */}
                {showColorSelector && (
                  <div style={{ marginTop: '16px' }}>
                    <p className="text-sm font-semibold mb-2" style={{ color: textColor }}>
                      Color: <span className="font-normal">{selectedColor}</span>
                    </p>
                    <div className="flex gap-2">
                      {availableColors.map((colorOption: any) => (
                        <button
                          key={colorOption.name}
                          onClick={() => setSelectedColor(colorOption.name)}
                          className={cn(
                            "w-7 h-7 rounded-full transition-all",
                            selectedColor === colorOption.name
                              ? "ring-2 ring-inset ring-black"
                              : colorOption.name === 'White' ? "border-2 border-gray-300 hover:border-gray-400" : ""
                          )}
                          style={{ backgroundColor: colorOption.color }}
                          title={colorOption.name}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Size Selection */}
                {showSizeSelector && (
                  <div style={{ marginTop: '16px' }}>
                    <div className="flex items-end justify-between mb-2">
                      <p className="text-sm font-semibold" style={{ color: textColor }}>
                        Size: <span className="font-normal">{selectedSize}</span>
                      </p>
                      <button className="text-sm underline" style={{ color: textColor }}>
                        Size & Fit
                      </button>
                    </div>
                    <div className="inline-flex border rounded-md overflow-hidden" style={{ width: '100%' }}>
                      {availableSizes.map((size: any, index: number) => (
                        <button
                          key={size}
                          onClick={() => setSelectedSize(size)}
                          className={cn(
                            "flex-1 h-10 text-sm transition-colors",
                            index < availableSizes.length - 1 && "border-r",
                            selectedSize === size
                              ? "bg-primary text-primary-foreground"
                              : "bg-background hover:bg-muted"
                          )}
                        >
                          {size}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Description */}
                <div className="pt-6 border-t">
                  <h3 className="font-semibold text-base mb-2" style={{ color: textColor }}>
                    Omschrijving
                  </h3>
                  <p className="text-sm leading-relaxed" style={{ color: textColor, opacity: 0.8 }}>
                    {finalDescription}
                  </p>
                </div>

                {/* Policy Buttons */}
                {(showShippingPolicy || showRefundPolicy) && (
                  <div className="flex gap-2 pt-4">
                    {showShippingPolicy && (
                      <Button variant="outline" className="flex-1 rounded-lg shadow-none">
                        Shipping Policy
                      </Button>
                    )}
                    {showRefundPolicy && (
                      <Button variant="outline" className="flex-1 rounded-lg shadow-none">
                        Refund Policy
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="space-y-3" style={{ marginTop: '300px' }}>
                {/* Quantity Selector */}
                {showQuantitySelector && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold" style={{ color: textColor }}>
                      Total
                    </span>
                    <div className="flex items-center bg-gray-100 rounded-lg overflow-hidden">
                      <button
                        onClick={() => setQuantity(Math.max(1, quantity - 1))}
                        className="p-2 hover:bg-gray-200 transition-colors"
                      >
                        <Minus className="h-4 w-4" />
                      </button>
                      <span className="px-4 text-base font-medium">{quantity}</span>
                      <button
                        onClick={() => setQuantity(quantity + 1)}
                        className="p-2 hover:bg-gray-200 transition-colors"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                )}

                <Button
                  className="w-full h-12 text-base text-white rounded-lg"
                  style={{ backgroundColor: '#0070FF', opacity: 1 }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#0059CC'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#0070FF'}
                >
                  Add to cart
                </Button>
                <Button
                  className="w-full h-12 text-base text-white rounded-lg"
                  style={{ backgroundColor: '#000000', opacity: 1 }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#1a1a1a'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#000000'}
                >
                  Order now
                </Button>

                {/* Shipping & Return Information */}
                <div className="space-y-2 pt-4 border-t">
                  <div className="flex items-center gap-2">
                    <Truck className="h-4 w-4" style={{ color: textColor, opacity: 0.7 }} />
                    <span className="text-xs" style={{ color: textColor, opacity: 0.7 }}>
                      gratis thuisbezorgd vanaf 30-
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Store className="h-4 w-4" style={{ color: textColor, opacity: 0.7 }} />
                    <span className="text-xs" style={{ color: textColor, opacity: 0.7 }}>
                      gratis afhalen in 500+ winkels vanaf 15-
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Undo2 className="h-4 w-4" style={{ color: textColor, opacity: 0.7 }} />
                    <span className="text-xs" style={{ color: textColor, opacity: 0.7 }}>
                      gratis retourneren binnen 30 dagen
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
