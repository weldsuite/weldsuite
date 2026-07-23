"use client";

import React from 'react';
import { cn } from '@weldsuite/ui/lib/utils';

export interface CategoryBannerBlockProps {
  title?: string;
  summary?: string;
  image?: {
    src: string;
    alt: string;
  };
  overlayOpacity?: number;
  borderRadius?: number;
  textColor?: string;
  mode?: 'live' | 'preview' | 'edit';
  store?: {
    products?: any[];
    collections?: any[];
    [key: string]: any;
  };
}

export function CategoryBannerBlock({
  title = "Accessories",
  summary = "Reliable and stylish shirts for plant work",
  image = {
    src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/accessories/Gold-Heart-Earrings-2.png",
    alt: "",
  },
  overlayOpacity = 30,
  borderRadius = 12,
  textColor = '#ffffff',
  mode = 'live',
  store,
}: CategoryBannerBlockProps) {
  return (
    <section className="py-32">
      <div className="container mx-auto px-4">
        <div
          className="relative flex min-h-[300px] items-center justify-center overflow-hidden"
          style={{ borderRadius: `${borderRadius}px` }}
        >
          {/* Dark overlay */}
          <div
            className="absolute inset-0 z-20 size-full bg-black"
            style={{ opacity: overlayOpacity / 100 }}
          />

          {/* Content */}
          <div className="relative z-30 flex size-full flex-col gap-3 px-6 py-8 md:px-10 lg:px-20">
            <h1
              className="text-center text-4xl font-medium sm:text-5xl"
              style={{ color: textColor }}
            >
              {title}
            </h1>
            <p
              className="text-center text-lg"
              style={{ color: textColor }}
            >
              {summary}
            </p>
          </div>

          {/* Background image */}
          <div className="absolute inset-0">
            <img
              src={image.src}
              alt={image.alt}
              className="size-full object-cover object-center"
            />
          </div>
        </div>
      </div>
    </section>
  );
}
