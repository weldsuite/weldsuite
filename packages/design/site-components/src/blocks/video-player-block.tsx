"use client";

import type { StoreData } from '../types';
import React, { useState, useRef } from 'react';
import { buildEmbedUrl } from '../lib/video-embed';
import { VideoMedia } from '../components/video-media';

interface VideoPlayerBlockProps {
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

  // Legacy props
  controls?: boolean;
  mode?: string;
  store?: StoreData;
}

// Alignment classes
const ALIGNMENT_MAP = {
  'top-left': 'items-start justify-start text-left',
  'top-center': 'items-start justify-center text-center',
  'top-right': 'items-start justify-end text-right',
  'center-left': 'items-center justify-start text-left',
  'center': 'items-center justify-center text-center',
  'center-right': 'items-center justify-end text-right',
  'bottom-left': 'items-end justify-start text-left',
  'bottom-center': 'items-end justify-center text-center',
  'bottom-right': 'items-end justify-end text-right',
};

export function VideoPlayerBlock({
  url = '',
  videoType = 'youtube',
  autoplay = false,
  loop = false,
  muted = true,
  showControls = true,
  coverImage,
  heading,
  description,
  buttonText,
  buttonLink = '#',
  showButton = false,
  height = 'medium',
  customHeight = 600,
  overlayOpacity = 0.3,
  textColor = '#ffffff',
  contentAlignment = 'center',
  controls = true
}: VideoPlayerBlockProps) {
  const [isPlaying, setIsPlaying] = useState(autoplay);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Height mapping
  const heightMap = {
    small: 400,
    medium: 650,
    large: 800,
    fullscreen: '100vh',
    custom: customHeight
  };

  const sectionHeight = heightMap[height];
  const containerHeightStyle = {
    height: typeof sectionHeight === 'number' ? `${sectionHeight}px` : sectionHeight,
    maxHeight: height === 'fullscreen' ? '100vh' : undefined,
  };

  // Check if it's a YouTube or Vimeo URL
  const isYouTube = videoType === 'youtube' || url.includes('youtube.com') || url.includes('youtu.be');
  const isVimeo = videoType === 'vimeo' || url.includes('vimeo.com');

  const embedUrl = buildEmbedUrl({ url, isYouTube, isVimeo, autoplay, loop, muted, showControls });

  const handlePlay = () => {
    setIsPlaying(true);
    if (videoRef.current) {
      videoRef.current.play();
    }
  };

  if (!embedUrl) {
    return (
      <div
        className="flex items-center justify-center bg-muted rounded-lg"
        style={containerHeightStyle}
      >
        <div className="text-center p-8">
          <div className="text-muted-foreground mb-4">
            <svg className="w-16 h-16 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p>Add a video URL to get started</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative overflow-hidden rounded-lg"
      style={containerHeightStyle}
    >
      {/* Video Container */}
      <div className="absolute inset-0">
        <VideoMedia
          showCover={!isPlaying}
          coverImage={coverImage}
          heading={heading}
          onPlay={handlePlay}
          isEmbed={isYouTube || isVimeo}
          embedUrl={embedUrl}
          videoRef={videoRef}
          autoplay={autoplay}
          loop={loop}
          muted={muted}
          controls={showControls ?? controls}
        />

        {/* Overlay */}
        {(heading || description || showButton) && (
          <div
            className="absolute inset-0 bg-black pointer-events-none"
            style={{ opacity: overlayOpacity }}
          />
        )}
      </div>

      {/* Content Overlay */}
      {(heading || description || showButton) && (
        <div className={`relative h-full flex flex-col ${ALIGNMENT_MAP[contentAlignment]} px-4 md:px-8 py-12 md:py-20 z-10`}>
          <div className="max-w-2xl space-y-4 md:space-y-6">
            {heading && (
              <h2
                className="text-4xl md:text-6xl font-bold tracking-tight"
                style={{ color: textColor }}
              >
                {heading}
              </h2>
            )}
            {description && (
              <p
                className="text-lg md:text-xl"
                style={{ color: textColor, opacity: 0.95 }}
              >
                {description}
              </p>
            )}
            {showButton && buttonText && (
              <div className="pointer-events-auto">
                <a
                  href={buttonLink}
                  className="inline-block px-6 md:px-8 py-3 md:py-4 bg-white text-black font-medium hover:bg-gray-100 transition-colors rounded-md"
                >
                  {buttonText}
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
