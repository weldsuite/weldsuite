"use client";

import React, { useState } from "react";
import { ShoppingCart } from "lucide-react";

export interface HorizontalAccordionGalleryBlockProps {
  images?: Array<{ src: string; title: string; code: string }>;
  borderRadius?: number;
  imageHeight?: number;
  expandedWidth?: number;
  collapsedWidth?: number;
  gap?: number;
  showBorder?: boolean;
  mode?: 'live' | 'edit' | 'preview';
}

export function HorizontalAccordionGalleryBlock({
  images = [
    {
      src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/random5.jpeg",
      title: "Summer Collection",
      code: "#0031",
    },
    {
      src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/random11.jpeg",
      title: "The Music Festival",
      code: "#0030",
    },
    {
      src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/random13.jpeg",
      title: "Winter Special",
      code: "#0032",
    },
    {
      src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/random1.jpeg",
      title: "Spring Edition",
      code: "#0033",
    },
    {
      src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/random2.jpeg",
      title: "Spring Edition",
      code: "#0033",
    },
    {
      src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/random8.jpeg",
      title: "Spring Edition",
      code: "#0033",
    },
    {
      src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/random9.jpeg",
      title: "Spring Edition",
      code: "#0033",
    },
    {
      src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/random10.jpeg",
      title: "Spring Edition",
      code: "#0033",
    },
  ],
  borderRadius = 24,
  imageHeight = 384,
  expandedWidth = 384,
  collapsedWidth = 80,
  gap = 4,
  showBorder = false,
  mode = 'live',
}: HorizontalAccordionGalleryBlockProps) {
  const [activeImage, setActiveImage] = useState<number>(0);

  return (
    <div className="flex w-full items-center justify-center" style={{ gap: `${gap}px` }}>
      {images.map((image, index) => (
        <div
          key={index}
          className={`relative cursor-pointer overflow-hidden ${showBorder ? 'border' : ''}`}
          style={{
            width: activeImage === index ? `${expandedWidth}px` : `${collapsedWidth}px`,
            height: `${imageHeight}px`,
            borderRadius: `${borderRadius}px`,
            transition: 'width 0.3s ease-in-out',
          }}
          onClick={() => setActiveImage(index)}
          onMouseEnter={() => setActiveImage(index)}
        >
          {/* Gradient overlay */}
          <div
            className="absolute h-full w-full bg-gradient-to-t from-black/80 to-transparent z-10"
            style={{
              opacity: activeImage === index ? 1 : 0,
              transition: 'opacity 0.3s ease-in-out',
            }}
          />

          {/* Content overlay */}
          <div
            className="absolute flex h-full w-full flex-col items-end justify-end px-4 pb-10 z-20"
            style={{
              opacity: activeImage === index ? 1 : 0,
              transform: activeImage === index ? 'translateY(0)' : 'translateY(20px)',
              transition: 'opacity 0.3s ease-in-out, transform 0.3s ease-in-out',
            }}
          >
            <p className="text-left text-xs text-white/50">
              {image.code}
            </p>
            <h3 className="w-42 text-right text-3xl font-bold text-white lg:w-fit lg:whitespace-nowrap">
              {image.title.split(" ")[0]}
              <span className="italic">
                {" "}
                {image.title.split(" ").slice(1).join(" ")}
              </span>
            </h3>
            <button className="bg-background mt-2 flex w-32 items-center justify-center gap-2 whitespace-nowrap rounded-full px-4 py-2 text-xs">
              Add to Cart <ShoppingCart size={14} />
            </button>
          </div>

          {/* Image */}
          <img
            src={image.src}
            className="size-full object-cover"
            alt={image.title}
          />
        </div>
      ))}
    </div>
  );
}
