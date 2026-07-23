"use client";

import React from "react";
import { cn } from "@weldsuite/ui/lib/utils";

interface CtaBannerBlockProps {
  heading?: string;
  description?: string;
  primaryButtonText?: string;
  primaryButtonLink?: string;
  secondaryButtonText?: string;
  secondaryButtonLink?: string;
  backgroundImage?: string;
  overlayOpacity?: number;
  height?: number;
  borderRadius?: number;
  className?: string;
  mode?: 'live' | 'edit' | 'preview';
  store?: any;
}

export function CtaBannerBlock({
  heading = "Start your free trial today.",
  description = "Start with a 14-day free trial. No credit card required. No setup fees. Cancel anytime.",
  primaryButtonText = "Get Started",
  primaryButtonLink = "#",
  secondaryButtonText = "Learn More",
  secondaryButtonLink = "#",
  backgroundImage = "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/photos/pawel-czerwinski-O4fAgtXLRwI-unsplash.jpg",
  overlayOpacity = 40,
  height = 620,
  borderRadius = 16,
  className,
  mode = 'live',
  store,
}: CtaBannerBlockProps) {
  const isEditing = mode === 'edit' || mode === 'preview';

  return (
    <section className={cn("py-32", className)}>
      <div className="container mx-auto px-4">
        <div
          className="flex items-center justify-center overflow-hidden bg-cover bg-center"
          style={{
            height: `${height}px`,
            borderRadius: `${borderRadius}px`,
            backgroundImage: `linear-gradient(rgba(0,0,0,${overlayOpacity / 100}),rgba(0,0,0,0)),url('${backgroundImage}')`,
          }}
        >
          <div className="flex flex-col gap-8 p-4 text-center">
            <h2 className="text-5xl font-bold text-primary-foreground">
              {heading}
            </h2>
            <p className="text-lg text-primary-foreground">
              {description}
            </p>
            <div className="flex flex-col justify-center gap-2 sm:flex-row">
              {primaryButtonText && (
                <a
                  href={isEditing ? undefined : primaryButtonLink}
                  onClick={(e) => isEditing && e.preventDefault()}
                  className={cn(
                    "inline-flex items-center justify-center h-11 px-8 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium",
                    isEditing && "pointer-events-none"
                  )}
                >
                  {primaryButtonText}
                </a>
              )}
              {secondaryButtonText && (
                <a
                  href={isEditing ? undefined : secondaryButtonLink}
                  onClick={(e) => isEditing && e.preventDefault()}
                  className={cn(
                    "inline-flex items-center justify-center h-11 px-8 rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors font-medium",
                    isEditing && "pointer-events-none"
                  )}
                >
                  {secondaryButtonText}
                </a>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
