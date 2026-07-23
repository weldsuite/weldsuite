"use client";

import React from "react";
import { motion } from "framer-motion";
import { cn } from "@weldsuite/ui/lib/utils";
import { VideoText } from "../components/video-text";

interface HeroVideoTextOverlayBlockProps {
  heading?: string;
  videoSrc?: string;
  backgroundImage?: string;
  backgroundOpacity?: number;
  sectionHeight?: number;
  fontFamily?: string;
  paddingTop?: number;
  paddingBottom?: number;
  className?: string;
  mode?: 'live' | 'edit';
  store?: any;
}

export function HeroVideoTextOverlayBlock({
  heading = "Blocks",
  videoSrc = "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/landscape.mp4",
  backgroundImage = "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/landscape6.jpeg",
  backgroundOpacity = 20,
  sectionHeight = 800,
  fontFamily = "Playfair Display",
  paddingTop = 128,
  paddingBottom = 128,
  className,
  mode = 'live',
  store,
}: HeroVideoTextOverlayBlockProps) {
  return (
    <section
      className={cn(
        "relative flex flex-col items-center justify-center overflow-hidden",
        className,
      )}
      style={{
        height: `${sectionHeight}px`,
        paddingTop: `${paddingTop}px`,
        paddingBottom: `${paddingBottom}px`
      }}
    >
      <div className="container">
        <div
          className="absolute inset-0 overflow-hidden bg-cover bg-center bg-no-repeat"
          style={{
            backgroundImage: `url('${backgroundImage}')`,
            opacity: backgroundOpacity / 100,
          }}
        />
        <div className="flex flex-col items-center justify-center gap-4">
          <motion.div
            initial={{ opacity: 0, scale: 1.1 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.3 }}
            className="relative flex h-[250px] w-full items-center"
          >
            <VideoText
              src={videoSrc}
              className="font-playfair text-[15rem] font-bold tracking-tighter"
              fontFamily={fontFamily}
            >
              {heading}
            </VideoText>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
