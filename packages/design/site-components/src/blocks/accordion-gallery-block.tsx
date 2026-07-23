"use client";

import React, { useState } from "react";
import { ShoppingCart } from "lucide-react";

export interface AccordionGalleryBlockProps {
  images?: Array<{ src: string; title: string; code: string }>;
  mode?: 'live' | 'edit' | 'preview';
}

export function AccordionGalleryBlock({
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
      title: "Autumn Style",
      code: "#0034",
    },
  ],
  mode = 'live',
}: AccordionGalleryBlockProps) {
  const [activeImage, setActiveImage] = useState<number>(0);

  return (
    <div className="flex flex-col items-center justify-center gap-1">
      {images.map((image, index) => (
        <div
          key={index}
          className="group relative cursor-pointer overflow-hidden border rounded-3xl"
          style={{
            height: activeImage === index ? '24rem' : '2.5rem',
            width: '24rem',
            transition: 'height 0.3s ease-in-out',
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
            className="absolute flex h-full w-full flex-col items-end justify-end px-4 pb-5 z-20"
            style={{
              opacity: activeImage === index ? 1 : 0,
              transform: activeImage === index ? 'translateY(0)' : 'translateY(20px)',
              transition: 'opacity 0.3s ease-in-out, transform 0.3s ease-in-out',
            }}
          >
            <p className="text-left text-xs text-white/50">
              {image.code}
            </p>
            <h3 className="text-3xl font-bold text-white">
              {image.title.split(" ")[0]}
              <span className="italic">
                {" "}
                {image.title.split(" ").slice(1).join(" ")}
              </span>
            </h3>
            <button
              className="mt-3 flex w-fit items-center justify-center gap-2 rounded-full text-xs px-3 py-1.5 bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors"
            >
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
