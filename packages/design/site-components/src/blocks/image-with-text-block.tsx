"use client";

import React from 'react';

interface Block {
  id: string;
  type: string;
  settings: any;
}

export interface ImageWithTextBlockProps {
  // Image Settings
  image?: string;
  imagePosition?: 'left' | 'right';

  // Desktop Layout
  desktopContentPosition?: 'top' | 'middle' | 'bottom';
  desktopContentAlignment?: 'left' | 'center' | 'right';

  // Content
  heading?: string;
  headingSize?: 'h2' | 'h1' | 'h0' | 'hxl';
  text?: string;

  // Button
  buttonLabel?: string;
  buttonLink?: string;
  buttonStyle?: 'primary' | 'secondary' | 'link';

  // Color Scheme
  colorScheme?: 'scheme-1' | 'scheme-2' | 'scheme-3';

  // Nested blocks for individual elements
  blocks?: Block[];

  // Selection state
  selectedBlockId?: string;

  // Store context
  store?: any;
}

export function ImageWithTextBlock({
  image = 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=800&h=600&fit=crop',
  imagePosition = 'left',
  desktopContentPosition = 'middle',
  desktopContentAlignment = 'left',
  heading = 'Image with text',
  headingSize = 'h1',
  text = 'Pair text with an image to focus on your chosen product, collection, or blog post. Add details on availability, style, or even provide a review and share your story.',
  buttonLabel = 'Button label',
  buttonLink = '#',
  buttonStyle = 'primary',
  colorScheme = 'scheme-1',
  blocks = [],
  selectedBlockId,
  store,
}: ImageWithTextBlockProps) {

  // Extract settings from blocks if they exist
  const imageBlock = blocks?.find(b => b.type === 'imageWithTextImage');
  const headingBlock = blocks?.find(b => b.type === 'imageWithTextHeading');
  const textBlock = blocks?.find(b => b.type === 'imageWithTextText');
  const buttonBlock = blocks?.find(b => b.type === 'imageWithTextButton');

  // Use block settings if available, otherwise use direct props
  const finalImage = imageBlock?.settings?.image || image;
  const finalImagePosition = imageBlock?.settings?.imagePosition || imagePosition;
  const finalHeading = headingBlock?.settings?.heading || heading;
  const finalHeadingSize = headingBlock?.settings?.headingSize || headingSize;
  const finalText = textBlock?.settings?.text || text;
  const finalButtonLabel = buttonBlock?.settings?.buttonLabel || buttonLabel;
  const finalButtonLink = buttonBlock?.settings?.buttonLink || buttonLink;
  const finalButtonStyle = buttonBlock?.settings?.buttonStyle || buttonStyle;

  // Check which element is selected
  const isImageSelected = selectedBlockId === imageBlock?.id;
  const isHeadingSelected = selectedBlockId === headingBlock?.id;
  const isTextSelected = selectedBlockId === textBlock?.id;
  const isButtonSelected = selectedBlockId === buttonBlock?.id;

  // Get heading size class
  const getHeadingClass = () => {
    switch (headingSize) {
      case 'h2': return 'text-2xl md:text-3xl';
      case 'h1': return 'text-[40px] md:text-[52px]';
      case 'h0': return 'text-4xl md:text-5xl';
      case 'hxl': return 'text-5xl md:text-6xl';
      default: return 'text-[40px] md:text-[52px]';
    }
  };

  // Get content vertical position classes
  const getContentPositionClass = () => {
    switch (desktopContentPosition) {
      case 'top': return 'md:justify-start';
      case 'middle': return 'md:justify-center';
      case 'bottom': return 'md:justify-end';
      default: return 'md:justify-center';
    }
  };

  // Get content alignment classes
  const getContentAlignmentClass = () => {
    switch (desktopContentAlignment) {
      case 'left': return 'text-left';
      case 'center': return 'text-center';
      case 'right': return 'text-right';
      default: return 'text-left';
    }
  };

  // Get button style classes
  const getButtonClass = () => {
    switch (buttonStyle) {
      case 'primary': return 'bg-black text-white px-6 py-3 hover:bg-gray-900 rounded-md';
      case 'secondary': return 'bg-white text-gray-900 px-6 py-3 border-2 border-black hover:bg-gray-100 rounded-md';
      case 'link': return 'text-gray-900 underline hover:text-gray-600';
      default: return 'bg-black text-white px-6 py-3 hover:bg-gray-900 rounded-md';
    }
  };

  return (
    <div className="w-full">
      <div className="w-full">
        <div className="grid grid-cols-1 md:grid-cols-[60%_40%] gap-0 w-full">
          {/* Image Column */}
          <div className={`relative w-full ${finalImagePosition === 'right' ? 'md:order-2' : 'md:order-1'}`}>
            <div
              className={`relative w-full h-full min-h-[400px] md:min-h-[400px] transition-all ${
                isImageSelected ? 'ring-2 ring-blue-500 ring-inset' : ''
              }`}
            >
              <img
                src={finalImage}
                alt={finalHeading}
                className="absolute inset-0 w-full h-full object-cover"
              />
              {isImageSelected && (
                <div className="absolute top-2 left-2 bg-blue-500 text-white text-xs px-2 py-1 rounded shadow-lg font-medium">
                  Image
                </div>
              )}
            </div>
          </div>

          {/* Text Column */}
          <div className={`relative flex items-center bg-white ${getContentPositionClass()} ${finalImagePosition === 'right' ? 'md:order-1' : 'md:order-2'}`}>
            <div className={`w-full px-8 md:px-12 lg:px-16 py-8 md:py-10 ${getContentAlignmentClass()}`}>
              {/* Heading */}
              <div className={`relative ${isHeadingSelected ? 'ring-2 ring-blue-500 rounded' : ''}`}>
                <h2
                  className={`${getHeadingClass()} font-semibold text-gray-900 mb-4 leading-tight`}
                  style={{
                    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
                    fontSize: '36px',
                  }}
                >
                  {finalHeading}
                </h2>
                {isHeadingSelected && (
                  <div className="absolute -top-6 left-0 bg-blue-500 text-white text-xs px-2 py-1 rounded shadow-lg font-medium">
                    Heading
                  </div>
                )}
              </div>

              {/* Text */}
              <div className={`relative ${isTextSelected ? 'ring-2 ring-blue-500 rounded' : ''}`}>
                <p className="text-base text-gray-700 mb-6 leading-relaxed max-w-lg">
                  {finalText}
                </p>
                {isTextSelected && (
                  <div className="absolute -top-6 left-0 bg-blue-500 text-white text-xs px-2 py-1 rounded shadow-lg font-medium">
                    Text
                  </div>
                )}
              </div>

              {/* Button */}
              {finalButtonLabel && (
                <div className={`relative inline-block ${isButtonSelected ? 'ring-2 ring-blue-500 rounded' : ''}`}>
                  <a
                    href={finalButtonLink}
                    className={`inline-block ${getButtonClass()} transition-colors duration-200`}
                  >
                    {finalButtonLabel}
                  </a>
                  {isButtonSelected && (
                    <div className="absolute -top-6 left-0 bg-blue-500 text-white text-xs px-2 py-1 rounded shadow-lg font-medium whitespace-nowrap">
                      Button
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
