"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';

interface Slide {
  image: string;
  heading: string;
  text: string;
  buttonText: string;
  buttonLink: string;
}

interface SlideshowSectionProps {
  slides?: Slide[];
  autoplay?: boolean;
  autoplaySpeed?: number;
  showArrows?: boolean;
  showDots?: boolean;
  showPlayPause?: boolean;
  minHeight?: number;
  overlayOpacity?: number;
  contentAlignment?: 'left' | 'center' | 'right';
  transitionStyle?: 'fade' | 'slide' | 'zoom';
}

export function SlideshowSection({
  slides = [
    {
      image: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=1920&h=600&fit=crop',
      heading: 'Summer Collection 2024',
      text: 'Discover our latest arrivals with exclusive summer styles',
      buttonText: 'Shop Now',
      buttonLink: '/collections/summer'
    },
    {
      image: 'https://images.unsplash.com/photo-1441984904996-e0b6ba687e04?w=1920&h=600&fit=crop',
      heading: 'New Arrivals',
      text: 'Explore the newest additions to our collection',
      buttonText: 'Explore Collection',
      buttonLink: '/collections/new'
    },
    {
      image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=1920&h=600&fit=crop',
      heading: 'Limited Time Offer',
      text: 'Up to 50% off on selected items',
      buttonText: 'Shop Sale',
      buttonLink: '/collections/sale'
    }
  ],
  autoplay = true,
  autoplaySpeed = 5000,
  showArrows = true,
  showDots = true,
  showPlayPause = true,
  minHeight = 600,
  overlayOpacity = 0.4,
  contentAlignment = 'center',
  transitionStyle = 'fade',
}: SlideshowSectionProps) {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [progress, setProgress] = useState(0);

  const goToNext = useCallback(() => {
    if (isTransitioning) return;
    setIsTransitioning(true);
    setCurrentSlide((prev) => (prev + 1) % slides.length);
    setProgress(0);
    setTimeout(() => setIsTransitioning(false), 600);
  }, [isTransitioning, slides.length]);

  const goToPrevious = useCallback(() => {
    if (isTransitioning) return;
    setIsTransitioning(true);
    setCurrentSlide((prev) => (prev - 1 + slides.length) % slides.length);
    setProgress(0);
    setTimeout(() => setIsTransitioning(false), 600);
  }, [isTransitioning, slides.length]);

  const goToSlide = useCallback((index: number) => {
    if (isTransitioning || index === currentSlide) return;
    setIsTransitioning(true);
    setCurrentSlide(index);
    setProgress(0);
    setTimeout(() => setIsTransitioning(false), 600);
  }, [isTransitioning, currentSlide]);

  // Autoplay effect with progress
  useEffect(() => {
    if (!autoplay || isPaused || slides.length <= 1) {
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
  }, [autoplay, autoplaySpeed, isPaused, slides.length, goToNext]);

  const getAlignmentClasses = () => {
    switch (contentAlignment) {
      case 'left':
        return 'items-start text-left';
      case 'right':
        return 'items-end text-right';
      default:
        return 'items-center text-center';
    }
  };

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

  return (
    <section className="relative overflow-hidden w-full bg-gray-900" style={{ minHeight: `${minHeight}px` }}>
      {/* Slides Container */}
      <div className="relative h-full w-full" style={{ minHeight: `${minHeight}px` }}>
        {slides.map((slide, index) => (
          <div
            key={index}
            className={`absolute inset-0 ${getTransitionClasses(index)}`}
          >
            {/* Background Image */}
            <div className="absolute inset-0">
              <img
                src={slide.image}
                alt={slide.heading}
                className="w-full h-full object-cover"
                loading={index === 0 ? 'eager' : 'lazy'}
              />
              {/* Gradient Overlay */}
              <div
                className="absolute inset-0 bg-gradient-to-b from-black/30 via-black/20 to-black/50"
                style={{ opacity: overlayOpacity }}
              />
            </div>

            {/* Content */}
            <div className={`relative h-full flex flex-col justify-center ${getAlignmentClasses()} px-6 sm:px-12 md:px-16 lg:px-24`}>
              <div className={`max-w-4xl ${contentAlignment === 'center' ? 'mx-auto' : ''}`}>
                {/* Heading */}
                <h2
                  className={`text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold text-white mb-4 md:mb-6 transition-all duration-700 ${
                    index === currentSlide
                      ? 'translate-y-0 opacity-100'
                      : 'translate-y-12 opacity-0'
                  }`}
                  style={{
                    transitionDelay: index === currentSlide ? '100ms' : '0ms',
                    lineHeight: '1.1',
                    letterSpacing: '-0.02em',
                    textShadow: '0 2px 20px rgba(0,0,0,0.3)'
                  }}
                >
                  {slide.heading}
                </h2>

                {/* Text */}
                <p
                  className={`text-lg sm:text-xl md:text-2xl text-white/95 mb-8 md:mb-10 max-w-2xl transition-all duration-700 ${
                    index === currentSlide
                      ? 'translate-y-0 opacity-100'
                      : 'translate-y-12 opacity-0'
                  }`}
                  style={{
                    transitionDelay: index === currentSlide ? '200ms' : '0ms',
                    textShadow: '0 1px 10px rgba(0,0,0,0.3)'
                  }}
                >
                  {slide.text}
                </p>

                {/* Button */}
                <div
                  className={`transition-all duration-700 ${
                    index === currentSlide
                      ? 'translate-y-0 opacity-100'
                      : 'translate-y-12 opacity-0'
                  }`}
                  style={{ transitionDelay: index === currentSlide ? '300ms' : '0ms' }}
                >
                  <a
                    href={slide.buttonLink}
                    className="inline-flex items-center px-8 py-4 bg-white text-gray-900 font-semibold rounded-md hover:bg-gray-100 transition-all shadow-xl hover:shadow-2xl hover:scale-105 active:scale-95 text-base md:text-lg"
                  >
                    {slide.buttonText}
                    <ChevronRight className="ml-2 w-5 h-5" />
                  </a>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Navigation Arrows */}
      {showArrows && slides.length > 1 && (
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
      {(showDots || showPlayPause) && slides.length > 1 && (
        <div className="absolute bottom-0 left-0 right-0 z-20">
          {/* Progress Bar */}
          {autoplay && !isPaused && (
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
              <span className="text-white/60">{slides.length}</span>
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
            {showPlayPause && autoplay && (
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
    </section>
  );
}
