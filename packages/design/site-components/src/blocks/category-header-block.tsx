"use client";

import React from 'react';
import { cn } from '@weldsuite/ui/lib/utils';
import { ChevronRight } from 'lucide-react';

interface BreadcrumbLink {
  label: string;
  href: string;
}

export interface CategoryHeaderBlockProps {
  breadcrumb?: BreadcrumbLink[];
  title?: string;
  description?: string;
  background?: string;
  overlayOpacity?: number;
  textColor?: string;
  mode?: 'live' | 'preview' | 'edit';
  store?: {
    products?: any[];
    collections?: any[];
    [key: string]: any;
  };
}

const DEFAULT_BREADCRUMB: BreadcrumbLink[] = [
  { label: 'Home', href: '/' },
  { label: 'Shop', href: '/shop' },
  { label: 'Women', href: '/shop/women' },
];

export function CategoryHeaderBlock({
  breadcrumb = DEFAULT_BREADCRUMB,
  title = "Women's Collection",
  description = "Discover our curated selection of women's fashion, from everyday essentials to statement pieces that elevate your wardrobe.",
  background = "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/pexels-cottonbro-6764036-3.jpg",
  overlayOpacity = 50,
  textColor = '#ffffff',
  mode = 'live',
  store,
}: CategoryHeaderBlockProps) {
  return (
    <section className="relative min-h-[300px] md:min-h-[400px] flex items-center">
      {/* Background Image */}
      <div className="absolute inset-0">
        <img
          src={background}
          alt=""
          className="size-full object-cover object-center"
        />
        {/* Dark Overlay */}
        <div
          className="absolute inset-0 bg-black"
          style={{ opacity: overlayOpacity / 100 }}
        />
      </div>

      {/* Content */}
      <div className="container mx-auto px-4 relative z-10 py-12 md:py-16">
        {/* Breadcrumb */}
        {breadcrumb && breadcrumb.length > 0 && (
          <nav className="mb-6">
            <ol className="flex items-center gap-1 text-sm">
              {breadcrumb.map((link, index) => (
                <li key={index} className="flex items-center gap-1">
                  {index > 0 && (
                    <ChevronRight
                      className="h-4 w-4 opacity-60"
                      style={{ color: textColor }}
                    />
                  )}
                  <a
                    href={mode === 'live' ? link.href : '#'}
                    onClick={(e) => mode !== 'live' && e.preventDefault()}
                    className={cn(
                      "hover:underline transition-colors",
                      index === breadcrumb.length - 1 ? "opacity-60" : "opacity-80 hover:opacity-100"
                    )}
                    style={{ color: textColor }}
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        )}

        {/* Title */}
        <h1
          className="text-3xl md:text-4xl lg:text-5xl font-bold mb-4"
          style={{ color: textColor }}
        >
          {title}
        </h1>

        {/* Description */}
        {description && (
          <p
            className="text-base md:text-lg max-w-2xl opacity-90"
            style={{ color: textColor }}
          >
            {description}
          </p>
        )}
      </div>
    </section>
  );
}
