"use client";

import React from 'react';
import { cn } from '@weldsuite/ui/lib/utils';

type ImageMedia = {
  type: "image";
  alt: string;
  src: string;
  srcSet?: string;
  sizes?: string;
};

type VideoMedia = {
  type: "video";
  src: string;
};

type MediaItem = ImageMedia | VideoMedia;

interface ProductCategory {
  title: string;
  text: string;
  link: string;
  cta?: {
    link: string;
    text: string;
  };
  media: MediaItem;
}

export interface ProductCategoriesBlockProps {
  categories?: ProductCategory[];
  backgroundColor?: string;
  textColor?: string;
  buttonColor?: string;
  buttonTextColor?: string;
  imageRounding?: number;
  mode?: 'live' | 'preview' | 'edit';
  store?: {
    products?: any[];
    collections?: any[];
    [key: string]: any;
  };
}

const DEFAULT_CATEGORIES: ProductCategory[] = [
  {
    title: "Effortless Style",
    text: "Up to 50% off",
    link: "#",
    media: {
      type: "video",
      src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/6764045-hd_720_1280_25fps.mp4",
    },
  },
  {
    title: "Everyday Essentials",
    text: "Up to 50% off",
    cta: {
      link: "#",
      text: "See More",
    },
    link: "#",
    media: {
      type: "image",
      srcSet:
        "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/pexels-cottonbro-6764036-3.jpg 1920w, /images/block/ecommerce/clothes/pexels-cottonbro-6764036-2.jpg 1280w, /images/block/ecommerce/clothes/pexels-cottonbro-6764036-1.jpg 640w",
      src: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ecommerce/clothes/pexels-cottonbro-6764036-3.jpg",
      sizes: "(min-width: 1920px) 1920px, (min-width: 1280px) 1280px, 100vw",
      alt: "",
    },
  },
];

export function ProductCategoriesBlock({
  categories = DEFAULT_CATEGORIES,
  backgroundColor = '#ffffff',
  textColor = '#000000',
  buttonColor = '#000000',
  buttonTextColor = '#ffffff',
  imageRounding = 0,
  mode = 'live',
  store,
}: ProductCategoriesBlockProps) {
  const category1 = categories[0];
  const category2 = categories[1];

  if (!category1 || !category2) {
    return (
      <section className="py-32" style={{ backgroundColor }}>
        <div className="container mx-auto px-4">
          <p className="text-center text-gray-500">Please add at least 2 categories</p>
        </div>
      </section>
    );
  }

  return (
    <section className="py-32" style={{ backgroundColor }}>
      <div className="container mx-auto px-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 overflow-hidden">
          {/* First Category - Video/Left Column */}
          <div className="col-span-1">
            <div
              className="relative aspect-square size-full px-10 py-8 lg:aspect-auto lg:min-h-[600px] overflow-hidden"
              style={{ borderTopLeftRadius: `${imageRounding}px`, borderBottomLeftRadius: `${imageRounding}px` }}
            >
              <div className="relative z-10">
                <h2
                  className="mb-1 text-3xl leading-tight font-semibold sm:text-4xl"
                  style={{ color: textColor }}
                >
                  {category1.title}
                </h2>
                <p
                  className="text-xl leading-tight sm:text-2xl"
                  style={{ color: textColor }}
                >
                  {category1.text}
                </p>
              </div>
              <div className="absolute inset-0">
                {category1.media.type === 'video' ? (
                  <video
                    muted
                    autoPlay
                    loop
                    playsInline
                    className="size-full object-cover object-center"
                    src={category1.media.src}
                  />
                ) : (
                  <img
                    src={category1.media.src}
                    srcSet={(category1.media as ImageMedia).srcSet}
                    sizes={(category1.media as ImageMedia).sizes}
                    alt={(category1.media as ImageMedia).alt || ''}
                    className="size-full object-cover object-center"
                  />
                )}
              </div>
            </div>
          </div>

          {/* Second Category - Image/Right Column */}
          <div className="xl:col-span-2">
            <div
              className="relative aspect-square size-full px-10 py-8 before:pointer-events-none before:absolute before:inset-x-0 before:-bottom-px before:z-10 before:h-2/3 before:bg-gradient-to-t before:from-white/80 before:to-transparent lg:aspect-auto lg:min-h-[600px] overflow-hidden"
              style={{ borderTopRightRadius: `${imageRounding}px`, borderBottomRightRadius: `${imageRounding}px` }}
            >
              <div className="relative z-20 flex size-full flex-col items-center justify-end gap-3 pb-6">
                <div>
                  <h2
                    className="mb-1 text-center text-3xl leading-tight font-semibold sm:text-4xl"
                    style={{ color: textColor }}
                  >
                    {category2.title}
                  </h2>
                  <p
                    className="text-center text-xl leading-tight sm:text-2xl"
                    style={{ color: textColor }}
                  >
                    {category2.text}
                  </p>
                </div>
                {category2.cta && (
                  <a
                    href={mode === 'live' ? category2.cta.link : '#'}
                    onClick={(e) => mode !== 'live' && e.preventDefault()}
                    className="inline-flex items-center justify-center px-6 py-3 text-sm font-medium rounded-md transition-colors hover:opacity-90"
                    style={{ backgroundColor: buttonColor, color: buttonTextColor }}
                  >
                    {category2.cta.text}
                  </a>
                )}
              </div>
              <div className="absolute inset-0">
                {category2.media.type === 'image' ? (
                  <img
                    sizes={(category2.media as ImageMedia).sizes}
                    srcSet={(category2.media as ImageMedia).srcSet}
                    src={category2.media.src}
                    alt={(category2.media as ImageMedia).alt || ''}
                    className="size-full object-cover object-[50%_30%]"
                  />
                ) : (
                  <video
                    muted
                    autoPlay
                    loop
                    playsInline
                    className="size-full object-cover object-center"
                    src={category2.media.src}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
