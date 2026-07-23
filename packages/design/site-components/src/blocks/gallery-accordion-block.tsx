"use client";

import React, { useState } from "react";
import { ArrowRight, ShoppingCart } from "lucide-react";

export interface GalleryAccordionBlockProps {
  images?: Array<{ src: string; title: string; code: string }>;
  heading?: string;
  description?: string;
  buttonText?: string;
  buttonLink?: string;
  mode?: 'live' | 'edit' | 'preview';
}

export function GalleryAccordionBlock({
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
  heading = "We don't Believe in talk we deliver Results",
  description = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt Lorem ipsum dolor sit amet, consectetur adipiscing",
  buttonText = "Contact Us",
  buttonLink = "#",
  mode = 'live',
}: GalleryAccordionBlockProps) {
  const isEditing = mode === 'edit' || mode === 'preview';
  const [activeImage, setActiveImage] = useState<number>(0);

  return (
    <section className="py-32 bg-muted">
      <div className="mx-auto px-4 overflow-hidden" style={{ maxWidth: '1280px' }}>
        <div className="relative flex flex-col items-center justify-between gap-12 p-10 py-20 md:flex-row">

          {/* Left content */}
          <div className="flex flex-col justify-center" style={{ height: '730px' }}>
            <h1 className="max-w-lg text-5xl font-semibold">
              {heading}
            </h1>
            <p className="text-md mt-10 max-w-md opacity-55">
              {description}
            </p>
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

          {/* Right accordion gallery */}
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
        </div>
      </div>
    </section>
  );
}

const DashedBorderH = (props: React.SVGProps<SVGSVGElement>) => {
  return (
    <svg {...props} fill="none" xmlns="http://www.w3.org/2000/svg">
      <line
        opacity="0.2"
        x1="1571.5"
        y1="0.570312"
        x2="0.683594"
        y2="0.570271"
        stroke="black"
        strokeDasharray="5 5"
      />
    </svg>
  );
};

const DashedBorderV = (props: React.SVGProps<SVGSVGElement>) => {
  return (
    <svg {...props} fill="none" xmlns="http://www.w3.org/2000/svg">
      <line
        opacity="0.2"
        x1="0.631348"
        y1="0.208984"
        x2="0.631311"
        y2="828.348"
        stroke="black"
        strokeDasharray="5 5"
      />
    </svg>
  );
};
