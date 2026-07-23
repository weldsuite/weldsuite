"use client";

import React from 'react';
import { cn } from '@weldsuite/ui/lib/utils';

export interface CategorySplitBlockProps {
  title?: string;
  summary?: string;
  image?: {
    src: string;
    srcset?: string;
    alt: string;
    sizes?: string;
  };
  backgroundColor?: string;
  textColor?: string;
  borderRadius?: number;
  imagePosition?: 'left' | 'right';
  mode?: 'live' | 'preview' | 'edit';
  store?: {
    products?: any[];
    collections?: any[];
    [key: string]: any;
  };
}

export function CategorySplitBlock({
  title = "Sunglasses",
  summary = "Stylish and protective shades for every sunny day",
  image = {
    src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/accessories/Checkered-Sunglasses-on-Stone-Pedestal-1.png",
    srcset: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/accessories/Checkered-Sunglasses-on-Stone-Pedestal-1.png 529w, https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/accessories/Checkered-Sunglasses-on-Stone-Pedestal-2.png 992w",
    alt: "",
    sizes: "(min-width: 992px) 992px, 100vw",
  },
  backgroundColor = '#f5f5f5',
  textColor = '#000000',
  borderRadius = 12,
  imagePosition = 'right',
  mode = 'live',
  store,
}: CategorySplitBlockProps) {
  const contentSection = (
    <div className="flex h-full place-content-center place-items-center px-8 md:px-20 py-8">
      <div className="flex flex-col gap-3">
        <h1
          className="text-center text-4xl leading-relaxed font-medium"
          style={{ color: textColor }}
        >
          {title}
        </h1>
        <p
          className="text-center text-lg leading-normal text-balance"
          style={{ color: textColor, opacity: 0.8 }}
        >
          {summary}
        </p>
      </div>
    </div>
  );

  const imageSection = (
    <div className="relative h-full overflow-hidden min-h-[220px] md:min-h-0">
      <img
        src={image.src}
        alt={image.alt}
        srcSet={image.srcset}
        sizes={image.sizes}
        className="absolute inset-0 size-full object-cover object-center"
      />
    </div>
  );

  return (
    <section className="py-32">
      <div className="container mx-auto px-4">
        <div
          className="grid grid-cols-1 overflow-hidden md:min-h-[366px] md:grid-cols-2"
          style={{ backgroundColor, borderRadius: `${borderRadius}px` }}
        >
          {imagePosition === 'left' ? (
            <>
              {imageSection}
              {contentSection}
            </>
          ) : (
            <>
              {contentSection}
              {imageSection}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
