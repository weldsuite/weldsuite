"use client";

import React, { useState, useRef } from 'react';

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
  store?: any;
}

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
  fullWidth = false,
  controls = true,
  mode = 'live',
  store
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

  // Alignment classes
  const alignmentMap = {
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

  // Check if it's a YouTube or Vimeo URL
  const isYouTube = videoType === 'youtube' || url.includes('youtube.com') || url.includes('youtu.be');
  const isVimeo = videoType === 'vimeo' || url.includes('vimeo.com');
  const isHosted = videoType === 'hosted' || (!isYouTube && !isVimeo);

  const getEmbedUrl = () => {
    if (isYouTube) {
      const videoId = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/)?.[1];
      if (!videoId) return '';

      const params = new URLSearchParams();
      if (autoplay) params.set('autoplay', '1');
      if (loop) {
        params.set('loop', '1');
        params.set('playlist', videoId);
      }
      if (muted) params.set('mute', '1');
      if (!showControls) params.set('controls', '0');
      params.set('rel', '0');

      return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
    }

    if (isVimeo) {
      const videoId = url.match(/vimeo\.com\/(\d+)/)?.[1];
      if (!videoId) return '';

      const params = new URLSearchParams();
      if (autoplay) params.set('autoplay', '1');
      if (loop) params.set('loop', '1');
      if (muted) params.set('muted', '1');
      if (!showControls) params.set('controls', '0');

      return `https://player.vimeo.com/video/${videoId}?${params.toString()}`;
    }

    return url;
  };

  const embedUrl = getEmbedUrl();

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
        style={{
          height: typeof sectionHeight === 'number' ? `${sectionHeight}px` : sectionHeight,
          maxHeight: height === 'fullscreen' ? '100vh' : undefined
        }}
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
      style={{
        height: typeof sectionHeight === 'number' ? `${sectionHeight}px` : sectionHeight,
        maxHeight: height === 'fullscreen' ? '100vh' : undefined
      }}
    >
      {/* Video Container */}
      <div className="absolute inset-0">
        {isYouTube || isVimeo ? (
          <>
            {!isPlaying && coverImage ? (
              <div className="relative w-full h-full">
                <img
                  src={coverImage}
                  alt={heading || 'Video cover'}
                  className="w-full h-full object-cover"
                />
                <button
                  onClick={handlePlay}
                  className="absolute inset-0 flex items-center justify-center group"
                  aria-label="Play video"
                >
                  <div className="w-20 h-20 bg-white/90 rounded-full flex items-center justify-center group-hover:bg-white transition-colors">
                    <svg className="w-10 h-10 text-black ml-1" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </div>
                </button>
              </div>
            ) : (
              <iframe
                src={embedUrl}
                className="absolute inset-0 w-full h-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                title={heading || 'Video'}
              />
            )}
          </>
        ) : (
          <>
            {!isPlaying && coverImage ? (
              <div className="relative w-full h-full">
                <img
                  src={coverImage}
                  alt={heading || 'Video cover'}
                  className="w-full h-full object-cover"
                />
                <button
                  onClick={handlePlay}
                  className="absolute inset-0 flex items-center justify-center group"
                  aria-label="Play video"
                >
                  <div className="w-20 h-20 bg-white/90 rounded-full flex items-center justify-center group-hover:bg-white transition-colors">
                    <svg className="w-10 h-10 text-black ml-1" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </div>
                </button>
              </div>
            ) : (
              <video
                ref={videoRef}
                src={embedUrl}
                className="w-full h-full object-cover"
                autoPlay={autoplay}
                loop={loop}
                muted={muted}
                controls={showControls !== undefined ? showControls : controls}
                playsInline
              />
            )}
          </>
        )}

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
        <div className={`relative h-full flex flex-col ${alignmentMap[contentAlignment]} px-4 md:px-8 py-12 md:py-20 z-10`}>
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
