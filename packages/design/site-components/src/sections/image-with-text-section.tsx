"use client";

import React, { useEffect } from 'react';
import { ArrowRight } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';

interface ImageWithTextSectionProps {
  image?: string;
  heading?: string;
  text?: string;
  imagePosition?: 'left' | 'right';
  buttonText?: string;
  buttonLink?: string;
  backgroundColor?: string;
  textColor?: string;
  paddingTop?: number;
  paddingBottom?: number;
  imageWidth?: number;
  sectionId?: string;
  textFont?: string;
  textFontWeight?: string;
  textSize?: string;
}

export function ImageWithTextSection({
  image = 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=800&h=600&fit=crop',
  heading = 'Our Story',
  text = 'Discover the passion and craftsmanship behind our brand',
  imagePosition = 'left',
  buttonText = 'Learn More',
  buttonLink = '/about',
  backgroundColor = '#ffffff',
  textColor = '#000000',
  paddingTop = 80,
  paddingBottom = 80,
  imageWidth = 50,
  sectionId,
  textFont = 'Inter',
  textFontWeight = 'font-normal',
  textSize = 'text-lg',
}: ImageWithTextSectionProps) {
  // Load Google Font if needed
  useEffect(() => {
    if (textFont && textFont !== 'system-ui' && textFont !== 'Inter') {
      // Check if font is already loaded
      const existingLink = document.querySelector(`link[href*="${textFont.replace(' ', '+')}"]`);
      if (!existingLink) {
        const link = document.createElement('link');
        link.href = `https://fonts.googleapis.com/css2?family=${textFont.replace(' ', '+')}:wght@300;400;500;600;700&display=swap`;
        link.rel = 'stylesheet';
        document.head.appendChild(link);
      }
    }
  }, [textFont]);

  return (
    <section
      className="px-4 md:px-8"
      style={{
        backgroundColor,
        paddingTop: `${paddingTop}px`,
        paddingBottom: `${paddingBottom}px`
      }}
    >
      <div className="container mx-auto" style={{ maxWidth: '1400px' }}>
        <div className={`grid grid-cols-1 md:grid-cols-5 gap-16 items-center ${imagePosition === 'right' ? 'md:grid-flow-dense' : ''}`}>
          {/* Image */}
          <div className={`md:col-span-3 ${imagePosition === 'right' ? 'md:col-start-3' : ''}`}>
            <div className="aspect-[16/10] overflow-hidden rounded-lg bg-gray-100">
              <img
                src={image}
                alt={heading}
                className="w-full h-full object-cover"
              />
            </div>
          </div>

          {/* Text Content */}
          <div className={`md:col-span-2 ${imagePosition === 'right' ? 'md:col-start-1 md:row-start-1' : ''}`}>
            <h2
              className="text-4xl md:text-5xl font-bold tracking-tight mb-6"
              style={{
                color: textColor
              }}
            >
              {heading}
            </h2>
            <p
              className={cn(
                "mb-8 leading-relaxed max-w-lg",
                textSize || "text-lg",
                textFontWeight || "font-normal"
              )}
              style={{
                color: textColor,
                opacity: 0.8,
                fontFamily: textFont !== 'system-ui' ? textFont : undefined
              }}
            >
              {text}
            </p>
            {buttonText && (
              <a
                href={buttonLink}
                className="inline-flex items-center gap-2 px-6 py-3 bg-black text-white font-medium hover:bg-gray-800 transition-all rounded-md"
              >
                {buttonText}
              </a>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
