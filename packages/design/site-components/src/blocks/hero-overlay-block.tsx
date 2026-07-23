"use client";

import React from 'react';
import { ArrowRight } from "lucide-react";

export interface HeroOverlayBlockProps {
  heading?: string;
  description?: string;
  buttonText?: string;
  buttonLink?: string;
  imageUrl?: string;
  minHeight?: string;
  headingFontFamily?: string;
  mode?: 'live' | 'edit' | 'preview';
}

export function HeroOverlayBlock({
  heading = "Find Your Perfect Home in Your City",
  description = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt Lorem ipsum dolor sit amet, consectetur adipiscing elit,",
  buttonText = "Contact Us now",
  buttonLink = "#",
  imageUrl = "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/highRise.jpg",
  minHeight = "100vh",
  headingFontFamily = "Playfair Display, serif",
  mode = 'live',
}: HeroOverlayBlockProps) {
  const isEditing = mode === 'edit' || mode === 'preview';

  return (
    <section className="py-32">
      <div
        className="container mx-auto px-4 relative"
        style={{ minHeight }}
      >
        {/* Text content with blur background */}
        <div className="absolute bottom-45 z-10 lg:max-w-xl">
          <div className="absolute top-0 size-full blur-2xl bg-background z-1" />
          <h1
            className="relative z-20 text-left text-5xl tracking-tighter lg:text-6xl"
            style={{ fontFamily: headingFontFamily }}
          >
            {heading}
          </h1>
          <p className="text-muted-foreground relative z-20 mt-8">
            {description}
          </p>
        </div>

        {/* Button */}
        <div className="lg:right-25 lg:bottom-45 absolute bottom-20 z-10 max-w-xl">
          <a
            href={isEditing ? undefined : buttonLink}
            onClick={(e) => isEditing && e.preventDefault()}
            className={`group mt-10 flex w-fit items-center justify-center gap-2 rounded-full border px-4 py-2 tracking-tight bg-primary text-primary-foreground hover:bg-primary/90 transition-colors ${
              isEditing ? 'pointer-events-none' : ''
            }`}
          >
            {buttonText}
            <ArrowRight className="size-4 -rotate-45 transition-all ease-out group-hover:rotate-0" />
          </a>
        </div>

        {/* Image */}
        <div className="absolute -top-20 right-0 w-[27rem] max-w-xl">
          <img
            src={imageUrl}
            className="rounded-2xl object-cover"
            alt=""
            style={{
              animation: 'fadeIn 0.5s ease-in-out',
            }}
          />
        </div>
      </div>
    </section>
  );
}
