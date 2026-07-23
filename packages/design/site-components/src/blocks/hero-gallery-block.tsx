"use client";

import React from 'react';
import { cn } from '@weldsuite/ui/lib/utils';
import { motion } from 'framer-motion';

const DEFAULT_GALLERY_IMAGES = [
  [
    "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/bw1.jpeg",
    "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/bw2.jpeg",
    "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/bw3.jpeg",
    "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/bw4.jpeg",
    "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/bw5.jpeg",
    "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/bw6.jpeg",
  ],
  [
    "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/bw7.jpeg",
    "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/bw8.jpeg",
    "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/bw9.jpeg",
    "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/bw10.jpeg",
    "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/bw11.jpeg",
    "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/bw12.jpeg",
  ],
];

export interface HeroGalleryBlockProps {
  title?: string;
  buttonText?: string;
  buttonLink?: string;
  galleryImages?: string[][];
  backgroundColor?: string;
  overlayColor?: string;
  overlayOpacity?: number;
  textColor?: string;
  animationSpeed?: number;
  mode?: 'live' | 'preview' | 'edit';
  store?: {
    products?: any[];
    collections?: any[];
    [key: string]: any;
  };
}

export function HeroGalleryBlock({
  title = "A Studio\nCrafting\nDigital Art",
  buttonText = "View Projects",
  buttonLink = "#",
  galleryImages = DEFAULT_GALLERY_IMAGES,
  backgroundColor = '#ffffff',
  overlayColor = '#000000',
  overlayOpacity = 60,
  textColor = '#ffffff',
  animationSpeed = 30,
  mode = 'live',
  store,
}: HeroGalleryBlockProps) {
  // Convert newlines to <br> for display
  const titleLines = title.split('\n');

  return (
    <section
      className="relative min-h-screen overflow-hidden"
      style={{ backgroundColor }}
    >
      {/* Animated gallery background */}
      <div className="absolute inset-0 flex flex-col justify-center gap-4">
        {galleryImages.map((row, rowIndex) => (
          <motion.div
            key={`${rowIndex}-${animationSpeed}`}
            className="flex gap-4 will-change-transform"
            animate={{
              x: rowIndex === 1 ? [-1920, 0] : [0, -1920],
            }}
            transition={{
              duration: animationSpeed,
              repeat: Infinity,
              ease: "linear",
            }}
          >
            {[...row, ...row, ...row].map((image, imageIndex) => (
              <motion.div
                key={`${rowIndex}-${imageIndex}`}
                className="relative flex-shrink-0 overflow-hidden rounded-lg"
                style={{
                  width: rowIndex === 1 ? "280px" : "240px",
                  height: rowIndex === 1 ? "350px" : "300px",
                }}
                whileHover={{ scale: 1.05 }}
                transition={{ duration: 0.3 }}
              >
                <img
                  src={image}
                  alt={`Gallery image ${imageIndex + 1}`}
                  className="h-full w-full object-cover"
                />
              </motion.div>
            ))}
          </motion.div>
        ))}
      </div>

      {/* Left side mask */}
      <div
        className="absolute top-0 left-0 z-10 h-full w-[160px] md:w-[200px]"
        style={{
          background: `linear-gradient(to right, ${backgroundColor}, transparent)`,
        }}
      />

      {/* Right side mask */}
      <div
        className="absolute top-0 right-0 z-10 h-full w-[160px] md:w-[200px]"
        style={{
          background: `linear-gradient(to left, ${backgroundColor}, transparent)`,
        }}
      />

      {/* Content overlay */}
      <div className="relative z-20 flex min-h-screen items-center justify-center">
        <motion.div
          className="rounded-lg p-8 backdrop-blur-md md:p-12"
          style={{
            backgroundColor: overlayColor,
            opacity: overlayOpacity / 100,
          }}
          initial={mode === 'edit' ? false : { opacity: 0, x: -50 }}
          animate={mode === 'edit' ? false : { opacity: overlayOpacity / 100, x: 0 }}
          transition={mode === 'edit' ? { duration: 0 } : { duration: 0.8, delay: 0.5 }}
        >
          <motion.h1
            className="text-3xl leading-tight md:text-5xl lg:text-6xl"
            style={{ color: textColor }}
            initial={mode === 'edit' ? false : { opacity: 0, y: 30 }}
            animate={mode === 'edit' ? false : { opacity: 1, y: 0 }}
            transition={mode === 'edit' ? { duration: 0 } : { duration: 0.8, delay: 0.7 }}
          >
            {titleLines.map((line, index) => (
              <React.Fragment key={index}>
                {line}
                {index < titleLines.length - 1 && <br />}
              </React.Fragment>
            ))}
          </motion.h1>

          <motion.div
            className="mt-6"
            initial={mode === 'edit' ? false : { opacity: 0, y: 20 }}
            animate={mode === 'edit' ? false : { opacity: 1, y: 0 }}
            transition={mode === 'edit' ? { duration: 0 } : { duration: 0.6, delay: 1 }}
          >
            <a
              href={mode === 'live' ? buttonLink : '#'}
              onClick={(e) => mode !== 'live' && e.preventDefault()}
              className="inline-flex items-center justify-center px-6 py-3 text-sm font-medium rounded-md transition-colors bg-white text-black hover:bg-gray-100"
            >
              {buttonText}
            </a>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
