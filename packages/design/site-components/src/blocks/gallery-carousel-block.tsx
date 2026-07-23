"use client";

import React, { useRef, useEffect, useState } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";

export interface GalleryCarouselBlockProps {
  images?: Array<{ src: string; alt: string }>;
  heading?: string;
  buttonText?: string;
  buttonLink?: string;
  autoplay?: boolean;
  autoplayDelay?: number;
  mode?: 'live' | 'edit' | 'preview';
}

export function GalleryCarouselBlock({
  images = [
    {
      src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/random11.jpeg",
      alt: "Gallery image 1",
    },
    {
      src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/random1.jpeg",
      alt: "Gallery image 2",
    },
    {
      src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/random2.jpeg",
      alt: "Gallery image 3",
    },
    {
      src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/random11.jpeg",
      alt: "Gallery image 4",
    },
    {
      src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/random1.jpeg",
      alt: "Gallery image 5",
    },
  ],
  heading = "Hear the Music: An Experience Like Never Before",
  buttonText = "Explore the world",
  buttonLink = "#",
  autoplay = true,
  autoplayDelay = 3000,
  mode = 'live',
}: GalleryCarouselBlockProps) {
  const isEditing = mode === 'edit' || mode === 'preview';
  const scrollRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isLoaded, setIsLoaded] = useState(false);

  const startAutoplay = () => {
    if (!autoplay || images.length === 0) return;

    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }

    intervalRef.current = setInterval(() => {
      setCurrentIndex((prev) => {
        const next = (prev + 1) % images.length;
        if (scrollRef.current) {
          const itemWidth = scrollRef.current.scrollWidth / images.length;
          scrollRef.current.scrollTo({
            left: next * itemWidth,
            behavior: 'smooth',
          });
        }
        return next;
      });
    }, autoplayDelay);
  };

  useEffect(() => {
    setIsLoaded(true);
  }, []);

  // Auto-scroll effect
  useEffect(() => {
    startAutoplay();
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [autoplay, autoplayDelay, images.length]);

  const scrollTo = (direction: 'prev' | 'next') => {
    if (!scrollRef.current) return;
    const itemWidth = scrollRef.current.scrollWidth / images.length;
    const newIndex = direction === 'next'
      ? (currentIndex + 1) % images.length
      : (currentIndex - 1 + images.length) % images.length;

    scrollRef.current.scrollTo({
      left: newIndex * itemWidth,
      behavior: 'smooth',
    });
    setCurrentIndex(newIndex);

    // Reset autoplay timer after manual navigation
    startAutoplay();
  };

  return (
    <section className="py-32">
      <div className="container mx-auto px-4 relative flex max-w-4xl flex-col items-center gap-10 overflow-x-clip">
        {/* Left and right gradient masks */}
        <div className="lg:w-66 pointer-events-none absolute left-0 z-10 h-full w-24 bg-gradient-to-r from-white to-transparent" />
        <div className="lg:w-66 pointer-events-none absolute right-0 z-10 h-full w-24 bg-gradient-to-l from-white to-transparent" />

        {/* Carousel */}
        <div
          className="relative h-[300px] w-full max-w-4xl"
          style={{
            opacity: isLoaded ? 1 : 0,
            transform: isLoaded ? 'translateY(0)' : 'translateY(20px)',
            transition: 'opacity 0.3s ease, transform 0.3s ease',
          }}
        >
          <div
            ref={scrollRef}
            className="flex h-full gap-6 overflow-x-auto scroll-smooth snap-x snap-mandatory pb-4 scrollbar-hide"
            style={{
              scrollbarWidth: 'none',
              msOverflowStyle: 'none',
            }}
          >
            {images.map((image, index) => (
              <div
                key={index}
                className="flex-shrink-0 snap-center"
                style={{
                  width: '300px',
                  transform: `scale(${index === currentIndex ? 1 : 0.85})`,
                  transition: 'transform 0.3s ease',
                }}
              >
                <img
                  className="h-full w-full overflow-hidden rounded-3xl object-cover shadow-lg"
                  src={image.src}
                  alt={image.alt}
                />
              </div>
            ))}
          </div>

          {/* Navigation buttons */}
          <button
            onClick={() => scrollTo('prev')}
            className="absolute left-4 top-1/2 -translate-y-1/2 z-20 p-2 rounded-full bg-white/80 hover:bg-white shadow-lg transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <button
            onClick={() => scrollTo('next')}
            className="absolute right-4 top-1/2 -translate-y-1/2 z-20 p-2 rounded-full bg-white/80 hover:bg-white shadow-lg transition-colors"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        {/* Content below carousel */}
        <div className="flex flex-col items-center justify-center">
          <h3 className="max-w-sm px-2 text-center text-2xl font-medium tracking-tight">
            {heading}
          </h3>
          {buttonText && (
            <a
              href={isEditing ? undefined : buttonLink}
              onClick={(e) => isEditing && e.preventDefault()}
              className={`group mt-10 flex items-center justify-center gap-2 rounded-full px-4 py-2 tracking-tight bg-secondary hover:bg-secondary/80 transition-colors ${
                isEditing ? 'pointer-events-none' : ''
              }`}
            >
              {buttonText}
              <ArrowRight className="size-4 -rotate-45 transition-all ease-out group-hover:rotate-0" />
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
