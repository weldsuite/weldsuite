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

const HEIGHT_CLASSES: Record<string, string> = {
  adapt: 'min-h-[500px] md:min-h-[600px]',
  small: 'h-[400px] md:h-[500px]',
  medium: 'h-[500px] md:h-[650px]',
  large: 'h-[650px] md:h-[750px]',
};
const DEFAULT_HEIGHT_CLASS = 'h-[500px] md:h-[650px]';

const POSITION_CLASSES: Record<string, string> = {
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

const ALIGNMENT_CLASSES: Record<string, string> = {
  left: 'text-left items-start',
  center: 'text-center items-center',
  right: 'text-right items-end',
};

const HEADING_CLASSES: Record<string, string> = {
  h2: 'text-2xl md:text-4xl',
  h1: 'text-3xl md:text-5xl',
  h0: 'text-4xl md:text-6xl',
  hxl: 'text-5xl md:text-7xl',
  hxxl: 'text-6xl md:text-8xl',
};

const TEXT_CLASSES: Record<string, string> = {
  body: 'text-base md:text-lg',
  subtitle: 'text-lg md:text-xl font-medium',
  caption: 'text-sm md:text-base uppercase tracking-wider',
};

const IMAGE_BEHAVIOR_CLASSES: Record<string, string> = {
  'zoom-in': 'scale-110 animate-zoom-slow',
  fixed: 'fixed',
  ambient: 'animate-ambient',
};

const getHeightClass = (imageHeight: string) => HEIGHT_CLASSES[imageHeight] ?? DEFAULT_HEIGHT_CLASS;
const getPositionClasses = (position: string) => POSITION_CLASSES[position] || 'items-center justify-center';
const getAlignmentClass = (alignment: string) => ALIGNMENT_CLASSES[alignment] ?? 'text-center items-center';
const getHeadingClass = (headingSize: string) => HEADING_CLASSES[headingSize] ?? 'text-3xl md:text-5xl';
const getTextClass = (textStyle: string) => TEXT_CLASSES[textStyle] ?? 'text-base md:text-lg';

// Always dark text on the white text box
const getTextColor = (showTextBox: boolean, colorScheme: string) =>
  !showTextBox && colorScheme === 'inverse' ? 'text-white' : 'text-gray-900';

interface BannerButtonsProps {
  button1Text?: string;
  button1Link: string;
  button1Style: 'primary' | 'secondary';
  button2Text?: string;
  button2Link: string;
  button2Style: 'primary' | 'secondary';
}

const BANNER_BUTTON_BASE = `
                      inline-flex items-center justify-center
                      px-6 py-3 md:px-8 md:py-4
                      text-base font-medium
                      transition-colors duration-200
                      `;
const BANNER_BUTTON_PRIMARY = 'bg-gray-700 text-white hover:bg-gray-800';
const BANNER_BUTTON_SECONDARY = 'bg-transparent border-2 border-gray-700 text-gray-700 hover:bg-gray-700 hover:text-white';

function BannerButtons({ button1Text, button1Link, button1Style, button2Text, button2Link, button2Style }: Readonly<BannerButtonsProps>) {
  if (!button1Text && !button2Text) return null;
  const styleClass = (style: 'primary' | 'secondary') =>
    style === 'primary' ? BANNER_BUTTON_PRIMARY : BANNER_BUTTON_SECONDARY;

  return (
    <div className="flex flex-col sm:flex-row gap-4 mt-2">
      {button1Text && (
        <a href={button1Link} className={`${BANNER_BUTTON_BASE}${styleClass(button1Style)}`}>
          {button1Text}
        </a>
      )}
      {button2Text && (
        <a href={button2Link} className={`${BANNER_BUTTON_BASE}${styleClass(button2Style)}`}>
          {button2Text}
        </a>
      )}
    </div>
  );
}

const MOBILE_BUTTON_PRIMARY = 'bg-black text-white hover:bg-gray-800';
const MOBILE_BUTTON_SECONDARY = 'border-2 border-black text-black hover:bg-black hover:text-white';

interface MobileButtonProps {
  text: string;
  link: string;
  style: 'primary' | 'secondary';
}

function MobileBannerButton({ text, link, style }: Readonly<MobileButtonProps>) {
  const isPrimary = style === 'primary';
  return (
    <Button
      asChild
      variant={isPrimary ? 'default' : 'outline'}
      size="lg"
      className={isPrimary ? MOBILE_BUTTON_PRIMARY : MOBILE_BUTTON_SECONDARY}
    >
      <a href={link}>{text}</a>
    </Button>
  );
}

interface MobileTextBelowProps extends BannerButtonsProps {
  heading?: string;
  text?: string;
  headingClass: string;
  textClass: string;
  alignmentClass: string;
}

function MobileTextBelow({
  heading,
  text,
  headingClass,
  textClass,
  alignmentClass,
  button1Text,
  button1Link,
  button1Style,
  button2Text,
  button2Link,
  button2Style,
}: Readonly<MobileTextBelowProps>) {
  return (
    <div className="md:hidden bg-white p-6">
      <div className={`flex flex-col gap-4 ${alignmentClass}`}>
        {heading && (
          <h2 className={`${headingClass} font-bold tracking-tight text-gray-900`}>
            {heading}
          </h2>
        )}
        {text && (
          <p className={`${textClass} text-gray-700`}>
            {text}
          </p>
        )}
        {(button1Text || button2Text) && (
          <div className="flex flex-col gap-3 mt-2">
            {button1Text && <MobileBannerButton text={button1Text} link={button1Link} style={button1Style} />}
            {button2Text && <MobileBannerButton text={button2Text} link={button2Link} style={button2Style} />}
          </div>
        )}
      </div>
    </div>
  );
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
}: Readonly<ImageBannerBlockProps>) {

  const headingClass = getHeadingClass(headingSize);
  const textClass = getTextClass(textStyle);
  const buttonProps = { button1Text, button1Link, button1Style, button2Text, button2Link, button2Style };

  return (
    <div className={`banner relative w-full overflow-hidden ${getHeightClass(imageHeight)} ${showTextBelow ? 'banner--mobile-bottom' : ''}`}>
      {/* Image Container */}
      <div className="banner__media absolute inset-0 w-full h-full">
        {/* Primary Image */}
        <img
          src={image}
          alt={heading}
          className={`w-full h-full object-cover ${IMAGE_BEHAVIOR_CLASSES[imageBehavior] ?? ''}`}
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
      <div className={`banner__content relative z-10 w-full h-full flex ${getPositionClasses(desktopContentPosition)} p-6 md:p-12`}>
        {/* Text Box - Shopify Style White Card */}
        <div className={`
          ${showTextBox ? 'bg-white shadow-md' : ''}
          ${showTextBox ? 'px-8 py-10 md:px-12 md:py-14' : ''}
          ${getTextColor(showTextBox, colorScheme)}
          ${getAlignmentClass(desktopContentAlignment)}
          md:${getAlignmentClass(desktopContentAlignment)}
          ${getAlignmentClass(mobileContentAlignment)}
          flex flex-col gap-5 md:gap-6
          max-w-lg
          ${showTextBelow ? 'md:relative md:z-10' : ''}
        `}>
            {/* Heading */}
            {heading && (
              <h2 className={`${headingClass} font-bold tracking-tight leading-tight`}>
                {heading}
              </h2>
            )}

            {/* Text */}
            {text && (
              <p className={`${textClass} leading-relaxed ${showTextBox ? 'text-gray-600' : 'opacity-90'}`}>
                {text}
              </p>
            )}

            {/* Buttons - Shopify Style */}
            <BannerButtons {...buttonProps} />
        </div>
      </div>

      {/* Mobile: Text Below Image */}
      {showTextBelow && (
        <MobileTextBelow
          heading={heading}
          text={text}
          headingClass={headingClass}
          textClass={textClass}
          alignmentClass={getAlignmentClass(mobileContentAlignment)}
          {...buttonProps}
        />
      )}
    </div>
  );
}
