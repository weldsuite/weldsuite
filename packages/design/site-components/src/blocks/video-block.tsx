"use client";

import React from 'react';
import VideoSection from '../sections/video-section';

interface VideoBlockProps {
  // Video source
  url?: string;
  videoType?: 'youtube' | 'vimeo' | 'hosted';

  // Video settings
  autoplay?: boolean;
  loop?: boolean;
  muted?: boolean;
  showControls?: boolean;

  // Cover image
  coverImage?: string;

  // Section heading (above video)
  sectionHeading?: string;
  sectionHeadingAlignment?: 'left' | 'center' | 'right';

  // Text overlay
  heading?: string;
  description?: string;

  // Button
  buttonText?: string;
  buttonLink?: string;
  showButton?: boolean;

  // Styling
  height?: 'small' | 'medium' | 'large' | 'fullscreen' | 'custom';
  customHeight?: number;
  overlayOpacity?: number;
  textColor?: string;
  contentAlignment?: 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  fullWidth?: boolean;

  // Legacy props for backward compatibility
  controls?: boolean;
  aspectRatio?: '16/9' | '4/3' | '1/1' | '21/9';
  borderRadius?: number;
  mode?: string;
  store?: any;
}

export function VideoBlock({
  url = '',
  videoType,
  autoplay = false,
  loop = false,
  muted = true,
  showControls = true,
  coverImage,
  sectionHeading,
  sectionHeadingAlignment = 'left',
  heading,
  description,
  buttonText,
  buttonLink,
  showButton = false,
  height = 'medium',
  customHeight = 600,
  overlayOpacity = 0.3,
  textColor = '#ffffff',
  contentAlignment = 'center',
  fullWidth = false,
  // Legacy props
  controls = true,
  mode = 'live',
  store
}: VideoBlockProps) {
  return (
    <VideoSection
      url={url}
      videoType={videoType}
      autoplay={autoplay}
      loop={loop}
      muted={muted}
      showControls={showControls !== undefined ? showControls : controls}
      coverImage={coverImage}
      sectionHeading={sectionHeading}
      sectionHeadingAlignment={sectionHeadingAlignment}
      heading={heading}
      description={description}
      buttonText={buttonText}
      buttonLink={buttonLink}
      showButton={showButton}
      height={height}
      customHeight={customHeight}
      overlayOpacity={overlayOpacity}
      textColor={textColor}
      contentAlignment={contentAlignment}
      fullWidth={fullWidth}
      store={store}
    />
  );
}
