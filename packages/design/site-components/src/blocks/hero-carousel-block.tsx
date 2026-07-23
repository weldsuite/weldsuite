"use client";

import React, { useEffect, useState } from "react";
import Autoplay from "embla-carousel-autoplay";
import { motion } from "framer-motion";
import { cn } from "@weldsuite/ui/lib/utils";
import { Button } from "@weldsuite/ui/components/button";
import {
  Carousel,
  type CarouselApi,
  CarouselContent,
  CarouselItem,
} from "@weldsuite/ui/components/carousel";

interface SlideItem {
  image: string;
  title: string;
  description: string;
  link: string;
  buttonText?: string;
}

interface HeroCarouselBlockProps {
  slides?: SlideItem[];
  sectionTitle?: string;
  sectionDescription?: string;
  sectionTitleAlign?: 'left' | 'center' | 'right';
  autoplayDelay?: number;
  backgroundColor?: string;
  textColor?: string;
  buttonVariant?: 'outline' | 'default' | 'secondary';
  imageRounding?: number;
  slideHeight?: number;
  contentPosition?: 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  textAlign?: 'left' | 'center' | 'right';
  paddingTop?: number;
  paddingBottom?: number;
  className?: string;
  mode?: 'live' | 'edit';
  store?: any;
}

const DEFAULT_SLIDES: SlideItem[] = [
  {
    image: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/bw12.jpeg",
    title: "Build Your Dream Home with us",
    description: "More than homes — we build dreams.",
    link: "#",
    buttonText: "Try it for free",
  },
  {
    image: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/bw13.jpeg",
    title: "Smart Homes",
    description: "Intelligent living spaces for the future",
    link: "#",
    buttonText: "Try it for free",
  },
  {
    image: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/bw14.jpeg",
    title: "Eco Friendly",
    description: "Sustainable and environmentally conscious homes",
    link: "#",
    buttonText: "Try it for free",
  },
  {
    image: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/bw16.jpeg",
    title: "Custom Builds",
    description: "Tailored solutions for your unique vision",
    link: "#",
    buttonText: "Try it for free",
  },
  {
    image: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/bw17.jpeg",
    title: "Premium Quality",
    description: "Excellence in every detail",
    link: "#",
    buttonText: "Try it for free",
  },
];

export function HeroCarouselBlock({
  slides = DEFAULT_SLIDES,
  sectionTitle = '',
  sectionDescription = '',
  sectionTitleAlign = 'center',
  autoplayDelay = 2000,
  backgroundColor = "#ffffff",
  textColor = "#ffffff",
  buttonVariant = "outline",
  imageRounding = 0,
  slideHeight = 600,
  contentPosition = 'bottom-right',
  textAlign = 'right',
  paddingTop = 128,
  paddingBottom = 128,
  className,
  mode = 'live',
  store,
}: HeroCarouselBlockProps) {
  // Position classes mapping
  const positionClasses = {
    'top-left': 'items-start justify-start',
    'top-center': 'items-center justify-start',
    'top-right': 'items-end justify-start',
    'center-left': 'items-start justify-center',
    'center': 'items-center justify-center',
    'center-right': 'items-end justify-center',
    'bottom-left': 'items-start justify-end',
    'bottom-center': 'items-center justify-end',
    'bottom-right': 'items-end justify-end',
  };

  const textAlignClasses = {
    'left': 'text-left',
    'center': 'text-center',
    'right': 'text-right',
  };
  const [api, setApi] = useState<CarouselApi>();
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    if (!api) return;

    api.on("select", () => {
      setCurrent(api.selectedScrollSnap());
    });
  }, [api]);

  const titleAlignClasses = {
    'left': 'text-left',
    'center': 'text-center',
    'right': 'text-right',
  };

  return (
    <section
      className={cn(className)}
      style={{ backgroundColor, paddingTop: `${paddingTop}px`, paddingBottom: `${paddingBottom}px` }}
    >
      {(sectionTitle || sectionDescription) && (
        <div className={cn("container mx-auto px-4 mb-12", titleAlignClasses[sectionTitleAlign])}>
          {sectionTitle && (
            <h2 className="text-4xl font-bold tracking-tight mb-4">{sectionTitle}</h2>
          )}
          {sectionDescription && (
            <p className={cn(
              "text-lg text-muted-foreground max-w-2xl",
              sectionTitleAlign === 'center' && "mx-auto",
              sectionTitleAlign === 'right' && "ml-auto"
            )}>{sectionDescription}</p>
          )}
        </div>
      )}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5 }}
      >
        <Carousel
          setApi={setApi}
          className="w-full"
          opts={{
            loop: true,
            slidesToScroll: 1,
          }}
          plugins={[
            Autoplay({
              delay: autoplayDelay,
              stopOnInteraction: true,
              stopOnMouseEnter: true,
            }),
          ]}
        >
          <CarouselContent className="flex w-full gap-4">
            {slides.map((slide, index) => (
              <CarouselItem key={index} className="w-full basis-[91%]">
                <div className="p-1">
                  <div
                    className={cn("relative flex flex-col bg-muted p-8 overflow-hidden", positionClasses[contentPosition])}
                    style={{ borderRadius: `${imageRounding}px`, height: `${slideHeight}px` }}
                  >
                    <div className="pointer-events-none absolute top-0 left-0 h-full w-full">
                      <img
                        src={slide.image}
                        alt={slide.title}
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <div
                      className={cn(
                        "z-10 flex flex-col",
                        textAlign === 'center' && "items-center",
                        textAlign === 'right' && "items-end",
                        textAlign === 'left' && "items-start"
                      )}
                      style={{ color: textColor }}
                    >
                      <h1 className={cn("max-w-lg text-6xl font-medium tracking-tight", textAlignClasses[textAlign])}>
                        {slide.title}
                      </h1>
                      <p className={cn("my-6 max-w-lg text-lg", textAlignClasses[textAlign])}>
                        {slide.description}
                      </p>
                      <a href={slide.link}>
                        <Button
                          variant={buttonVariant}
                          size="lg"
                          className="text-black"
                        >
                          {slide.buttonText || "Try it for free"}
                        </Button>
                      </a>
                    </div>
                  </div>
                </div>
              </CarouselItem>
            ))}
          </CarouselContent>

          {/* Navigation Dots */}
          <div className="mt-4 flex justify-center gap-2">
            {slides.map((_, index) => (
              <button
                key={index}
                onClick={() => api?.scrollTo(index)}
                className={cn(
                  "h-2.5 w-2.5 rounded-full transition-all",
                  current === index
                    ? "w-4 bg-primary"
                    : "bg-muted-foreground/50"
                )}
                aria-label={`Go to slide ${index + 1}`}
              />
            ))}
          </div>
        </Carousel>
      </motion.div>
    </section>
  );
}
