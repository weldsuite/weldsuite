"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';

export interface SlideshowContainerBlockProps {
  autoplay?: boolean;
  autoplaySpeed?: number;
  showArrows?: boolean;
  showDots?: boolean;
  showPlayPause?: boolean;
  minHeight?: number;
  transitionStyle?: 'fade' | 'slide' | 'zoom';
  mode?: 'live' | 'edit' | 'preview';
  children?: React.ReactNode;
  settings?: any;
}

export function SlideshowContainerBlock({
  autoplay = true,
  autoplaySpeed = 5000,
  showArrows = true,
  showDots = true,
  showPlayPause = true,
  minHeight = 600,
  transitionStyle = 'fade',
  mode = 'live',
  children,
  settings,
}: SlideshowContainerBlockProps) {
  const isEditing = mode === 'edit' || mode === 'preview';

  // Get slides from children (each slide is a container block with children)
  const slides = React.Children.toArray(children);
  const slideCount = slides.length;

  const [currentSlide, setCurrentSlide] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [progress, setProgress] = useState(0);

  const goToNext = useCallback(() => {
    if (isTransitioning || slideCount <= 1) return;
    setIsTransitioning(true);
    setCurrentSlide((prev) => (prev + 1) % slideCount);
    setProgress(0);
    setTimeout(() => setIsTransitioning(false), 600);
  }, [isTransitioning, slideCount]);

  const goToPrevious = useCallback(() => {
    if (isTransitioning || slideCount <= 1) return;
    setIsTransitioning(true);
    setCurrentSlide((prev) => (prev - 1 + slideCount) % slideCount);
    setProgress(0);
    setTimeout(() => setIsTransitioning(false), 600);
  }, [isTransitioning, slideCount]);

  const goToSlide = useCallback((index: number) => {
    if (isTransitioning || index === currentSlide || slideCount <= 1) return;
    setIsTransitioning(true);
    setCurrentSlide(index);
    setProgress(0);
    setTimeout(() => setIsTransitioning(false), 600);
  }, [isTransitioning, currentSlide, slideCount]);

  // Autoplay effect with progress
  useEffect(() => {
    if (!autoplay || isPaused || slideCount <= 1 || isEditing) {
      setProgress(0);
      return;
    }

    const progressInterval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 100) {
          return 0;
        }
        return prev + (100 / (autoplaySpeed / 50));
      });
    }, 50);

    const slideInterval = setInterval(() => {
      goToNext();
    }, autoplaySpeed);

    return () => {
      clearInterval(progressInterval);
      clearInterval(slideInterval);
    };
  }, [autoplay, autoplaySpeed, isPaused, slideCount, goToNext, isEditing]);

  const getTransitionClasses = (index: number) => {
    const isActive = index === currentSlide;

    switch (transitionStyle) {
      case 'slide':
        return `transition-all duration-600 ease-out ${
          isActive
            ? 'translate-x-0 opacity-100 z-10'
            : index < currentSlide
              ? '-translate-x-full opacity-0 z-0'
              : 'translate-x-full opacity-0 z-0'
        }`;
      case 'zoom':
        return `transition-all duration-600 ease-out ${
          isActive
            ? 'scale-100 opacity-100 z-10'
            : 'scale-95 opacity-0 z-0'
        }`;
      default:
        return `transition-all duration-600 ease-out ${
          isActive
            ? 'opacity-100 z-10'
            : 'opacity-0 z-0'
        }`;
    }
  };

  // If no slides, show placeholder in edit mode
  if (slideCount === 0 && isEditing) {
    return (
      <div className="relative overflow-hidden w-full bg-gray-100" style={{ minHeight: `${minHeight}px` }}>
        <div className="flex items-center justify-center h-full">
          <p className="text-gray-400">Add slides to your slideshow</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden w-full bg-gray-900" style={{ height: `${minHeight}px` }}>
      {/* Slides Container */}
      <div className="absolute inset-0 w-full h-full">
        {slides.map((slide, index) => (
          <div
            key={index}
            className={`absolute inset-0 w-full h-full ${getTransitionClasses(index)}`}
          >
            {slide}
          </div>
        ))}
      </div>

      {/* Navigation Arrows */}
      {showArrows && slideCount > 1 && (
        <>
          <button
            onClick={goToPrevious}
            disabled={isTransitioning}
            className="absolute left-4 md:left-6 top-1/2 -translate-y-1/2 w-12 h-12 md:w-14 md:h-14 flex items-center justify-center bg-white/90 hover:bg-white text-gray-900 rounded-full transition-all shadow-lg hover:shadow-xl hover:scale-110 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed z-20 backdrop-blur-sm"
            aria-label="Previous slide"
          >
            <ChevronLeft className="w-6 h-6" strokeWidth={2.5} />
          </button>
          <button
            onClick={goToNext}
            disabled={isTransitioning}
            className="absolute right-4 md:right-6 top-1/2 -translate-y-1/2 w-12 h-12 md:w-14 md:h-14 flex items-center justify-center bg-white/90 hover:bg-white text-gray-900 rounded-full transition-all shadow-lg hover:shadow-xl hover:scale-110 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed z-20 backdrop-blur-sm"
            aria-label="Next slide"
          >
            <ChevronRight className="w-6 h-6" strokeWidth={2.5} />
          </button>
        </>
      )}

      {/* Bottom Controls Bar */}
      {(showDots || showPlayPause) && slideCount > 1 && (
        <div className="absolute bottom-0 left-0 right-0 z-20">
          {/* Progress Bar */}
          {autoplay && !isPaused && !isEditing && (
            <div className="h-1 bg-white/20">
              <div
                className="h-full bg-white transition-all ease-linear"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

          {/* Controls Container */}
          <div className="flex items-center justify-between px-6 md:px-8 py-4 bg-gradient-to-t from-black/60 to-transparent backdrop-blur-sm">
            {/* Slide Counter */}
            <div className="text-white/90 text-sm font-medium">
              <span className="text-lg">{currentSlide + 1}</span>
              <span className="text-white/60 mx-1">/</span>
              <span className="text-white/60">{slideCount}</span>
            </div>

            {/* Dots */}
            {showDots && (
              <div className="flex gap-2.5">
                {slides.map((_, index) => (
                  <button
                    key={index}
                    onClick={() => goToSlide(index)}
                    disabled={isTransitioning}
                    className={`w-3 h-3 rounded-full transition-all duration-300 disabled:cursor-not-allowed ${
                      index === currentSlide
                        ? 'bg-white'
                        : 'bg-white/40 hover:bg-white/60'
                    }`}
                    aria-label={`Go to slide ${index + 1}`}
                  />
                ))}
              </div>
            )}

            {/* Play/Pause Button */}
            {showPlayPause && autoplay && !isEditing && (
              <button
                onClick={() => setIsPaused(!isPaused)}
                className="w-10 h-10 flex items-center justify-center bg-white/10 hover:bg-white/20 text-white rounded-full transition-all hover:scale-110 active:scale-95"
                aria-label={isPaused ? 'Play' : 'Pause'}
              >
                {isPaused ? (
                  <Play className="w-5 h-5 ml-0.5" fill="white" />
                ) : (
                  <Pause className="w-5 h-5" fill="white" />
                )}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
