"use client";

import React, { useState } from "react";
import { ArrowRight, ShoppingCart } from "lucide-react";

export interface GalleryHorizontalAccordionBlockProps {
  images?: Array<{ src: string; title: string; code: string }>;
  heading?: string;
  description?: string;
  buttonText?: string;
  buttonLink?: string;
  mode?: 'live' | 'edit' | 'preview';
}

export function GalleryHorizontalAccordionBlock({
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
  heading = "We don't Believe in talk",
  description = "we deliver Results Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt.",
  buttonText = "Contact Us",
  buttonLink = "#",
  mode = 'live',
}: GalleryHorizontalAccordionBlockProps) {
  const isEditing = mode === 'edit' || mode === 'preview';
  const [activeImage, setActiveImage] = useState<number>(0);

  return (
    <section className="py-32">
      <div className="container mx-auto px-4 relative overflow-x-clip">
        <div className="flex flex-col items-center justify-center">
          <h1 className="max-w-xl text-center text-5xl italic tracking-tighter md:text-6xl">
            {heading}
          </h1>
          <p className="text-md my-10 max-w-lg text-center opacity-50">
            {description}
          </p>

          <div className="flex w-full items-center justify-center gap-1">
            {images.map((image, index) => (
              <div
                key={index}
                className="relative cursor-pointer overflow-hidden rounded-3xl border"
                style={{
                  width: activeImage === index ? '24rem' : '5rem',
                  height: '24rem',
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

          <a
            href={isEditing ? undefined : buttonLink}
            onClick={(e) => isEditing && e.preventDefault()}
            className={`group mt-10 flex w-fit items-center justify-center gap-2 rounded-full px-4 py-2 tracking-tight bg-primary text-primary-foreground hover:bg-primary/90 transition-colors ${
              isEditing ? 'pointer-events-none' : ''
            }`}
          >
            {buttonText}
            <ArrowRight className="size-4 -rotate-45 transition-all ease-out group-hover:rotate-0" />
          </a>
        </div>
      </div>
    </section>
  );
}
