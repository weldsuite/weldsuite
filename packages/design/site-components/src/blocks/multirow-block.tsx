"use client";

import React from 'react';

interface Block {
  id: string;
  type: string;
  settings: any;
}

export interface MultirowBlockProps {
  // Section Settings
  heading?: string;
  headingSize?: 'h2' | 'h1' | 'h0' | 'hxl';
  imageHeight?: 'small' | 'medium' | 'large';
  desktopImageWidth?: 'small' | 'medium' | 'large';
  desktopContentPosition?: 'left' | 'center' | 'right';
  desktopContentAlignment?: 'left' | 'center' | 'right';
  mobileContentAlignment?: 'left' | 'center' | 'right';
  colorScheme?: 'scheme-1' | 'scheme-2' | 'scheme-3';
  containerColorScheme?: 'scheme-1' | 'scheme-2' | 'scheme-3';

  // Nested blocks for individual rows
  blocks?: Block[];

  // Selection state
  selectedBlockId?: string;

  // Store context
  store?: any;
}

export function MultirowBlock({
  heading = 'Multirow',
  headingSize = 'h1',
  imageHeight = 'medium',
  desktopImageWidth = 'medium',
  desktopContentPosition = 'center',
  desktopContentAlignment = 'left',
  mobileContentAlignment = 'left',
  colorScheme = 'scheme-1',
  containerColorScheme = 'scheme-1',
  blocks = [],
  selectedBlockId,
  store,
}: MultirowBlockProps) {

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

  // Get image height class
  const getImageHeightClass = () => {
    switch (imageHeight) {
      case 'small': return 'h-48 md:h-64';
      case 'medium': return 'h-64 md:h-80';
      case 'large': return 'h-80 md:h-96';
      default: return 'h-64 md:h-80';
    }
  };

  // Get desktop image width class
  const getImageWidthClass = () => {
    switch (desktopImageWidth) {
      case 'small': return 'md:w-1/3';
      case 'medium': return 'md:w-1/2';
      case 'large': return 'md:w-2/3';
      default: return 'md:w-1/2';
    }
  };

  // Get content alignment class
  const getContentAlignmentClass = (alignment: string, isMobile = false) => {
    const prefix = isMobile ? '' : 'md:';
    switch (alignment) {
      case 'left': return `${prefix}text-left`;
      case 'center': return `${prefix}text-center`;
      case 'right': return `${prefix}text-right`;
      default: return `${prefix}text-left`;
    }
  };

  // Get content position class (for flex alignment)
  const getContentPositionClass = () => {
    switch (desktopContentPosition) {
      case 'left': return 'md:items-start';
      case 'center': return 'md:items-center';
      case 'right': return 'md:items-end';
      default: return 'md:items-center';
    }
  };

  // Get color scheme classes
  const getColorSchemeClass = (scheme: string) => {
    switch (scheme) {
      case 'scheme-1': return 'bg-white text-gray-900';
      case 'scheme-2': return 'bg-gray-100 text-gray-900';
      case 'scheme-3': return 'bg-gray-900 text-white';
      default: return 'bg-white text-gray-900';
    }
  };

  return (
    <section className={`w-full py-12 md:py-16 ${getColorSchemeClass(colorScheme)}`}>
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Heading */}
        {heading && (
          <h2 className={`${getHeadingClass()} font-bold mb-8 md:mb-12 text-center`}>
            {heading}
          </h2>
        )}

        {/* Rows Container */}
        <div className="space-y-12 md:space-y-16">
          {blocks.map((block, index) => {
            if (block.type !== 'multirowRow') return null;

            const rowSettings = block.settings || {};
            const isRowSelected = selectedBlockId === block.id;

            // Extract nested elements from the row block
            const rowBlocks = rowSettings.blocks || [];
            const imageBlock = rowBlocks.find((b: Block) => b.type === 'multirowImage');
            const headingBlock = rowBlocks.find((b: Block) => b.type === 'multirowHeading');
            const textBlock = rowBlocks.find((b: Block) => b.type === 'multirowText');
            const buttonBlock = rowBlocks.find((b: Block) => b.type === 'multirowButton');

            // Check which element is selected
            const isImageSelected = selectedBlockId === imageBlock?.id;
            const isHeadingSelected = selectedBlockId === headingBlock?.id;
            const isTextSelected = selectedBlockId === textBlock?.id;
            const isButtonSelected = selectedBlockId === buttonBlock?.id;

            // Get final values from nested blocks or row settings
            const finalImage = imageBlock?.settings?.image || rowSettings.image || 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=800&h=600&fit=crop';
            const finalHeading = headingBlock?.settings?.heading || rowSettings.heading || 'Row heading';
            const finalRowHeadingSize = headingBlock?.settings?.headingSize || rowSettings.headingSize || 'h2';
            const finalText = textBlock?.settings?.text || rowSettings.text || 'Add your text here to describe this row content.';
            const finalButtonLabel = buttonBlock?.settings?.buttonLabel || rowSettings.buttonLabel || '';
            const finalButtonLink = buttonBlock?.settings?.buttonLink || rowSettings.buttonLink || '#';
            const finalButtonStyle = buttonBlock?.settings?.buttonStyle || rowSettings.buttonStyle || 'primary';

            // Alternate image position (left for even rows, right for odd rows)
            const imageOnLeft = index % 2 === 0;

            // Get row heading class
            const getRowHeadingClass = () => {
              switch (finalRowHeadingSize) {
                case 'h2': return 'text-2xl md:text-3xl';
                case 'h1': return 'text-[40px] md:text-[52px]';
                case 'h0': return 'text-4xl md:text-5xl';
                case 'hxl': return 'text-5xl md:text-6xl';
                default: return 'text-2xl md:text-3xl';
              }
            };

            return (
              <div
                key={block.id}
                className={`relative ${isRowSelected ? 'ring-2 ring-blue-500 ring-inset rounded-lg' : ''}`}
              >
                {isRowSelected && (
                  <div className="absolute top-2 left-2 bg-blue-500 text-white text-xs px-2 py-1 rounded z-10">
                    Row
                  </div>
                )}

                <div className={`grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8 ${getColorSchemeClass(containerColorScheme)} p-6 md:p-8 rounded-lg`}>
                  {/* Image */}
                  <div className={`relative ${imageOnLeft ? 'md:order-1' : 'md:order-2'} ${getImageWidthClass()} ${isImageSelected ? 'ring-2 ring-blue-500 ring-inset rounded-lg' : ''}`}>
                    {isImageSelected && (
                      <div className="absolute top-2 left-2 bg-blue-500 text-white text-xs px-2 py-1 rounded z-10">
                        Image
                      </div>
                    )}
                    <img
                      src={finalImage}
                      alt={finalHeading}
                      className={`w-full ${getImageHeightClass()} object-cover rounded-lg`}
                    />
                  </div>

                  {/* Content */}
                  <div className={`flex flex-col justify-center ${imageOnLeft ? 'md:order-2' : 'md:order-1'} ${getContentPositionClass()} space-y-4`}>
                    {/* Heading */}
                    {finalHeading && (
                      <div className={`relative ${isHeadingSelected ? 'ring-2 ring-blue-500 ring-inset rounded' : ''}`}>
                        {isHeadingSelected && (
                          <div className="absolute top-0 left-0 -mt-6 bg-blue-500 text-white text-xs px-2 py-1 rounded">
                            Heading
                          </div>
                        )}
                        <h3 className={`${getRowHeadingClass()} font-bold ${getContentAlignmentClass(desktopContentAlignment)} ${getContentAlignmentClass(mobileContentAlignment, true)}`}>
                          {finalHeading}
                        </h3>
                      </div>
                    )}

                    {/* Text */}
                    {finalText && (
                      <div className={`relative ${isTextSelected ? 'ring-2 ring-blue-500 ring-inset rounded' : ''}`}>
                        {isTextSelected && (
                          <div className="absolute top-0 left-0 -mt-6 bg-blue-500 text-white text-xs px-2 py-1 rounded">
                            Text
                          </div>
                        )}
                        <p className={`text-base md:text-lg text-gray-600 ${getContentAlignmentClass(desktopContentAlignment)} ${getContentAlignmentClass(mobileContentAlignment, true)}`}>
                          {finalText}
                        </p>
                      </div>
                    )}

                    {/* Button */}
                    {finalButtonLabel && (
                      <div className={`relative ${isButtonSelected ? 'ring-2 ring-blue-500 ring-inset rounded inline-block' : ''} ${getContentAlignmentClass(desktopContentAlignment)} ${getContentAlignmentClass(mobileContentAlignment, true)}`}>
                        {isButtonSelected && (
                          <div className="absolute top-0 left-0 -mt-6 bg-blue-500 text-white text-xs px-2 py-1 rounded">
                            Button
                          </div>
                        )}
                        <a
                          href={finalButtonLink}
                          className={`inline-block px-6 py-3 rounded-md font-medium transition-colors ${
                            finalButtonStyle === 'primary'
                              ? 'bg-blue-600 text-white hover:bg-blue-700'
                              : finalButtonStyle === 'secondary'
                              ? 'bg-gray-200 text-gray-900 hover:bg-gray-300'
                              : 'text-blue-600 hover:text-blue-700 underline'
                          }`}
                        >
                          {finalButtonLabel}
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Empty state */}
        {blocks.length === 0 && (
          <div className="text-center py-12 text-gray-400">
            <p>Add rows to create your multirow section</p>
          </div>
        )}
      </div>
    </section>
  );
}
