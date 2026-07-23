"use client";

import React from 'react';
import { Button } from '@weldsuite/ui/components/button';

export interface ImageBannerBlockProps {
  // Image Settings
  image?: string;
  image2?: string;
  imageOverlay?: number;
  imageHeight?: 'adapt' | 'small' | 'medium' | 'large';
  imageBehavior?: 'none' | 'ambient' | 'fixed' | 'zoom-in';

  // Desktop Content Settings
  desktopContentPosition?: 'top_left' | 'top_center' | 'top_right' | 'middle_left' | 'middle_center' | 'middle_right' | 'bottom_left' | 'bottom_center' | 'bottom_right';
  desktopContentAlignment?: 'left' | 'center' | 'right';
  showTextBox?: boolean;

  // Mobile Settings
  mobileContentAlignment?: 'left' | 'center' | 'right';
  stackImagesOnMobile?: boolean;
  showTextBelow?: boolean;

  // Color & Styling
  colorScheme?: 'scheme-1' | 'scheme-2' | 'scheme-3' | 'inverse';

  // Content Blocks
  heading?: string;
  headingSize?: 'h2' | 'h1' | 'h0' | 'hxl' | 'hxxl';
  text?: string;
  textStyle?: 'body' | 'subtitle' | 'caption';
  button1Text?: string;
  button1Link?: string;
  button1Style?: 'primary' | 'secondary';
  button2Text?: string;
  button2Link?: string;
  button2Style?: 'primary' | 'secondary';
}

export function ImageBannerBlock({
  image = 'https://images.unsplash.com/photo-1441984904996-e0b6ba687e04?w=1920&h=1080&fit=crop',
  image2,
  imageOverlay = 0,
  imageHeight = 'adapt',
  imageBehavior = 'none',
  desktopContentPosition = 'middle_center',
  desktopContentAlignment = 'center',
  showTextBox = false,
  mobileContentAlignment = 'center',
  stackImagesOnMobile = false,
  showTextBelow = false,
  colorScheme = 'scheme-1',
  heading = 'Image banner',
  headingSize = 'h1',
  text = 'Give customers details about the banner image(s) or content on the template.',
  textStyle = 'body',
  button1Text = 'Shop now',
  button1Link = '#',
  button1Style = 'primary',
  button2Text,
  button2Link = '#',
  button2Style = 'secondary',
}: ImageBannerBlockProps) {

  // Get height classes
  const getHeightClass = () => {
    switch (imageHeight) {
      case 'adapt': return 'min-h-[500px] md:min-h-[600px]';
      case 'small': return 'h-[400px] md:h-[500px]';
      case 'medium': return 'h-[500px] md:h-[650px]';
      case 'large': return 'h-[650px] md:h-[750px]';
      default: return 'h-[500px] md:h-[650px]';
    }
  };

  // Get position classes for desktop
  const getPositionClasses = () => {
    const positions = {
      top_left: 'items-start justify-start',
      top_center: 'items-start justify-center',
      top_right: 'items-start justify-end',
      middle_left: 'items-center justify-start',
      middle_center: 'items-center justify-center',
      middle_right: 'items-center justify-end',
      bottom_left: 'items-end justify-start',
      bottom_center: 'items-end justify-center',
      bottom_right: 'items-end justify-end',
    };
    return positions[desktopContentPosition] || 'items-center justify-center';
  };

  // Get alignment classes
  const getAlignmentClass = (alignment: string) => {
    switch (alignment) {
      case 'left': return 'text-left items-start';
      case 'center': return 'text-center items-center';
      case 'right': return 'text-right items-end';
      default: return 'text-center items-center';
    }
  };

  // Get heading size classes
  const getHeadingClass = () => {
    switch (headingSize) {
      case 'h2': return 'text-2xl md:text-4xl';
      case 'h1': return 'text-3xl md:text-5xl';
      case 'h0': return 'text-4xl md:text-6xl';
      case 'hxl': return 'text-5xl md:text-7xl';
      case 'hxxl': return 'text-6xl md:text-8xl';
      default: return 'text-3xl md:text-5xl';
    }
  };

  // Get text style classes
  const getTextClass = () => {
    switch (textStyle) {
      case 'body': return 'text-base md:text-lg';
      case 'subtitle': return 'text-lg md:text-xl font-medium';
      case 'caption': return 'text-sm md:text-base uppercase tracking-wider';
      default: return 'text-base md:text-lg';
    }
  };

  // Get color scheme classes
  const getColorScheme = () => {
    switch (colorScheme) {
      case 'scheme-1': return 'text-gray-900';
      case 'scheme-2': return 'text-white';
      case 'scheme-3': return 'text-gray-800';
      case 'inverse': return 'text-white';
      default: return 'text-gray-900';
    }
  };

  // Get text color for content
  const getTextColor = () => {
    if (showTextBox) {
      return 'text-gray-900'; // Always dark text on white background
    }
    return colorScheme === 'inverse' ? 'text-white' : 'text-gray-900';
  };

  // Stack images on mobile class
  const hasSecondImage = image2 && stackImagesOnMobile;

  return (
    <div className={`banner relative w-full overflow-hidden ${getHeightClass()} ${showTextBelow ? 'banner--mobile-bottom' : ''}`}>
      {/* Image Container */}
      <div className="banner__media absolute inset-0 w-full h-full">
        {/* Primary Image */}
        <img
          src={image}
          alt={heading}
          className={`w-full h-full object-cover ${
            imageBehavior === 'zoom-in' ? 'scale-110 animate-zoom-slow' :
            imageBehavior === 'fixed' ? 'fixed' :
            imageBehavior === 'ambient' ? 'animate-ambient' : ''
          }`}
          loading="lazy"
        />

        {/* Secondary Image (for split layout on desktop) */}
        {image2 && (
          <img
            src={image2}
            alt={heading}
            className={`hidden md:block absolute top-0 right-0 w-1/2 h-full object-cover ${
              imageBehavior === 'zoom-in' ? 'scale-110 animate-zoom-slow' : ''
            }`}
            loading="lazy"
          />
        )}

        {/* Image Overlay */}
        {imageOverlay > 0 && (
          <div
            className="absolute inset-0 bg-black"
            style={{ opacity: imageOverlay / 100 }}
          />
        )}
      </div>

      {/* Content Container */}
      <div className={`banner__content relative z-10 w-full h-full flex ${getPositionClasses()} p-6 md:p-12`}>
        {/* Text Box - Shopify Style White Card */}
        <div className={`
          ${showTextBox ? 'bg-white shadow-md' : ''}
          ${showTextBox ? 'px-8 py-10 md:px-12 md:py-14' : ''}
          ${getTextColor()}
          ${getAlignmentClass(desktopContentAlignment)}
          md:${getAlignmentClass(desktopContentAlignment)}
          ${getAlignmentClass(mobileContentAlignment)}
          flex flex-col gap-5 md:gap-6
          max-w-lg
          ${showTextBelow ? 'md:relative md:z-10' : ''}
        `}>
            {/* Heading */}
            {heading && (
              <h2 className={`${getHeadingClass()} font-bold tracking-tight leading-tight`}>
                {heading}
              </h2>
            )}

            {/* Text */}
            {text && (
              <p className={`${getTextClass()} leading-relaxed ${showTextBox ? 'text-gray-600' : 'opacity-90'}`}>
                {text}
              </p>
            )}

            {/* Buttons - Shopify Style */}
            {(button1Text || button2Text) && (
              <div className="flex flex-col sm:flex-row gap-4 mt-2">
                {button1Text && (
                  <a
                    href={button1Link}
                    className={`
                      inline-flex items-center justify-center
                      px-6 py-3 md:px-8 md:py-4
                      text-base font-medium
                      transition-colors duration-200
                      ${button1Style === 'primary'
                        ? 'bg-gray-700 text-white hover:bg-gray-800'
                        : 'bg-transparent border-2 border-gray-700 text-gray-700 hover:bg-gray-700 hover:text-white'}
                    `}
                  >
                    {button1Text}
                  </a>
                )}
                {button2Text && (
                  <a
                    href={button2Link}
                    className={`
                      inline-flex items-center justify-center
                      px-6 py-3 md:px-8 md:py-4
                      text-base font-medium
                      transition-colors duration-200
                      ${button2Style === 'primary'
                        ? 'bg-gray-700 text-white hover:bg-gray-800'
                        : 'bg-transparent border-2 border-gray-700 text-gray-700 hover:bg-gray-700 hover:text-white'}
                    `}
                  >
                    {button2Text}
                  </a>
                )}
              </div>
            )}
        </div>
      </div>

      {/* Mobile: Text Below Image */}
      {showTextBelow && (
        <div className="md:hidden bg-white p-6">
          <div className={`flex flex-col gap-4 ${getAlignmentClass(mobileContentAlignment)}`}>
            {heading && (
              <h2 className={`${getHeadingClass()} font-bold tracking-tight text-gray-900`}>
                {heading}
              </h2>
            )}
            {text && (
              <p className={`${getTextClass()} text-gray-700`}>
                {text}
              </p>
            )}
            {(button1Text || button2Text) && (
              <div className="flex flex-col gap-3 mt-2">
                {button1Text && (
                  <Button
                    asChild
                    variant={button1Style === 'primary' ? 'default' : 'outline'}
                    size="lg"
                    className={button1Style === 'primary' ? 'bg-black text-white hover:bg-gray-800' : 'border-2 border-black text-black hover:bg-black hover:text-white'}
                  >
                    <a href={button1Link}>{button1Text}</a>
                  </Button>
                )}
                {button2Text && (
                  <Button
                    asChild
                    variant={button2Style === 'primary' ? 'default' : 'outline'}
                    size="lg"
                    className={button2Style === 'primary' ? 'bg-black text-white hover:bg-gray-800' : 'border-2 border-black text-black hover:bg-black hover:text-white'}
                  >
                    <a href={button2Link}>{button2Text}</a>
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
