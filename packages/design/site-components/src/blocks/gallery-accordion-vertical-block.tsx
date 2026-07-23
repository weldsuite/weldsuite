"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, ShoppingCart } from "lucide-react";
import React, { useState } from "react";
import { cn } from "@weldsuite/ui/lib/utils";

interface GalleryImage {
  id: number;
  src: string;
  title: string;
  code: string;
}

interface GalleryAccordionVerticalBlockProps {
  heading?: string;
  description?: string;
  buttonText?: string;
  buttonLink?: string;
  images?: GalleryImage[];
  showAddToCart?: boolean;
  backgroundColor?: string;
  textColor?: string;
  className?: string;
  mode?: 'live' | 'edit' | 'preview';
  store?: any;
}

const defaultImages: GalleryImage[] = [
  {
    id: 1,
    src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/random5.jpeg",
    title: "Summer Collection",
    code: "#0031",
  },
  {
    id: 2,
    src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/random11.jpeg",
    title: "The Music Festival",
    code: "#0030",
  },
  {
    id: 3,
    src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/random13.jpeg",
    title: "Winter Special",
    code: "#0032",
  },
  {
    id: 4,
    src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/random1.jpeg",
    title: "Spring Edition",
    code: "#0033",
  },
  {
    id: 5,
    src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/random2.jpeg",
    title: "Spring Edition",
    code: "#0034",
  },
];

const DashedBorderH = (props: React.SVGProps<SVGSVGElement>) => {
  return (
    <svg {...props} fill="none" xmlns="http://www.w3.org/2000/svg">
      <line
        opacity="0.2"
        x1="1571.5"
        y1="0.570312"
        x2="0.683594"
        y2="0.570271"
        stroke="currentColor"
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
        stroke="currentColor"
        strokeDasharray="5 5"
      />
    </svg>
  );
};

export function GalleryAccordionVerticalBlock({
  heading = "We don't Believe in talk we deliver Results",
  description = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt Lorem ipsum dolor sit amet, consectetur adipiscing",
  buttonText = "Contact Us",
  buttonLink = "#",
  images = defaultImages,
  showAddToCart = true,
  backgroundColor,
  textColor,
  className,
  mode = 'live',
  store,
}: GalleryAccordionVerticalBlockProps) {
  const [activeImage, setActiveImage] = useState<number | null>(1);
  const isEditing = mode === 'edit' || mode === 'preview';

  return (
    <section className={cn("py-32", className)} style={{ backgroundColor }}>
      <div className="container mx-auto px-4">
        <div className="overflow-hidden p-10">
        <div className="relative flex flex-col items-center justify-between gap-12 border bg-muted p-10 py-20 md:flex-row">
          <DashedBorderV className="absolute -top-10 -left-px h-[150%] w-px" />
          <DashedBorderH className="absolute -top-px -left-10 h-px w-[150%]" />
          <DashedBorderV className="absolute -top-10 -right-px h-[150%] w-px" />
          <DashedBorderH className="absolute -bottom-px -left-12 h-px w-[150%]" />

          <div className="flex h-142 flex-col justify-center">
            <h1
              className="max-w-lg font-calSans text-5xl"
              style={{ color: textColor }}
            >
              {heading}
            </h1>
            <p
              className="text-md mt-10 max-w-md opacity-55"
              style={{ color: textColor }}
            >
              {description}
            </p>
            {buttonText && (
              <a
                href={isEditing ? undefined : buttonLink}
                onClick={(e) => isEditing && e.preventDefault()}
                className={cn(
                  "group mt-10 flex w-fit items-center justify-center gap-2 rounded-full px-6 py-3 tracking-tight bg-primary text-primary-foreground hover:bg-primary/90 transition-colors",
                  isEditing && "pointer-events-none"
                )}
              >
                {buttonText}
                <ArrowRight className="size-4 -rotate-45 transition-all ease-out group-hover:rotate-0" />
              </a>
            )}
          </div>

          <div className="flex flex-col items-center justify-center gap-1">
            {images.map((image, index) => (
              <motion.div
                key={image.id}
                className="group relative cursor-pointer overflow-hidden rounded-[2rem] border"
                initial={{ height: "2.5rem", width: "24rem" }}
                animate={{
                  height: activeImage === index ? "24rem" : "2.5rem",
                }}
                transition={{ duration: 0.3, ease: "easeInOut" }}
                onClick={() => setActiveImage(index)}
                onHoverStart={() => setActiveImage(index)}
              >
                <AnimatePresence>
                  {activeImage === index && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="absolute h-full w-full bg-gradient-to-t from-black/80 to-transparent"
                    />
                  )}
                </AnimatePresence>
                <AnimatePresence>
                  {activeImage === index && (
                    <motion.div
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 20 }}
                      className="absolute flex h-full w-full flex-col items-end justify-end px-4 pb-5"
                    >
                      <p className="text-left text-xs text-white/50">
                        {image.code}
                      </p>
                      <h3 className="text-3xl font-bold text-white">
                        {image.title.split(" ")[0]}
                        <span className="font-playfair italic">
                          {" "}
                          {image.title.split(" ")[1]}{" "}
                        </span>
                      </h3>
                      {showAddToCart && (
                        <button className="mt-3 flex w-fit items-center justify-center gap-2 rounded-full bg-secondary px-4 py-2 text-xs">
                          Add to Cart <ShoppingCart size={14} />
                        </button>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
                <img
                  src={image.src}
                  className="size-full object-cover"
                  alt={image.title}
                />
              </motion.div>
            ))}
          </div>
        </div>
        </div>
      </div>
    </section>
  );
}
