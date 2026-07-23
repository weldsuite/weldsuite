"use client";

import React, { useRef } from "react";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { cn } from "@weldsuite/ui/lib/utils";
import { useMousePosition } from "../hooks/use-mouse-position";
import { VariableFontAndCursor } from "../components/variable-font-and-cursor";

export type HeroLayout = 'contained' | 'fullWidth';

interface HeroInteractiveBlockProps {
  chapterLabel?: string;
  heading?: string;
  buttonText?: string;
  buttonLink?: string;
  backgroundImage?: string;
  showCoordinates?: boolean;
  backgroundColor?: string;
  textColor?: string;
  layout?: HeroLayout;
  labelFont?: string;
  headingFont?: string;
  className?: string;
  mode?: 'live' | 'edit';
  store?: any;
}

export function HeroInteractiveBlock({
  chapterLabel = "CHAPTER 01",
  heading = "BEYOND SPEED",
  buttonText = "Get Started",
  buttonLink = "#",
  backgroundImage = "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/bw15.jpeg",
  showCoordinates = true,
  backgroundColor = "#ffffff",
  textColor = "#ffffff",
  layout = "contained",
  labelFont = "Inter",
  headingFont = "Inter",
  className,
  mode = 'live',
  store,
}: HeroInteractiveBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { x, y } = useMousePosition(containerRef);

  const isFullWidth = layout === 'fullWidth';
  const isEditMode = mode === 'edit';

  return (
    <section
      className={cn(isFullWidth ? "" : "py-18", className)}
      style={{ backgroundColor }}
    >
      <div className={isFullWidth ? "" : "container mx-auto px-4"}>
        <div
          ref={containerRef}
          className={cn(
            "relative flex flex-col items-center justify-center overflow-hidden bg-cover bg-center",
            isFullWidth
              ? isEditMode
                ? "h-[100vh] w-full"
                : "h-screen w-screen"
              : "h-[85vh]"
          )}
          style={{
            backgroundImage: `url('${backgroundImage}')`,
          }}
        >
          {/* Coordinates display */}
          {showCoordinates && (
            <div className="absolute bottom-10 left-10 flex flex-col mix-blend-exclusion z-20">
              <p className="text-xs" style={{ color: textColor }}>
                x : {Math.round(x)}
              </p>
              <p className="text-xs" style={{ color: textColor }}>
                y : {Math.round(y)}
              </p>
            </div>
          )}

          {/* Crosshair lines */}
          <div
            className="pointer-events-none absolute top-0 h-full w-px -translate-x-1/2 z-10"
            style={{
              left: `${x}px`,
              backgroundColor: backgroundColor,
            }}
          />
          <div
            className="pointer-events-none absolute left-0 h-px w-full -translate-y-1/2 z-10"
            style={{
              top: `${y}px`,
              backgroundColor: backgroundColor,
            }}
          />
          <div
            className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-sm z-10"
            style={{
              top: `${y}px`,
              left: `${x}px`,
              backgroundColor: backgroundColor,
            }}
          />

          {/* Main content - centered */}
          <div className="relative z-20 flex flex-col items-center justify-center text-center mix-blend-exclusion -mt-16">
            <motion.p
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="text-lg mb-2"
              style={{ color: textColor, fontFamily: labelFont }}
            >
              {chapterLabel}
            </motion.p>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <VariableFontAndCursor
                label={heading}
                className="text-5xl tracking-[-5px] sm:text-7xl md:text-9xl md:tracking-[-13px]"
                style={{ color: textColor, fontFamily: headingFont }}
                fontVariationMapping={{
                  y: { name: "wght", min: 100, max: 900 },
                  x: { name: "slnt", min: 0, max: -10 },
                }}
                containerRef={containerRef as React.RefObject<HTMLDivElement>}
              />
            </motion.div>
          </div>

          {/* CTA Button - bottom center */}
          <a
            href={buttonLink}
            className="absolute bottom-10 group z-20 flex items-center gap-2 px-4 py-2 text-black transition-all duration-300 hover:gap-4"
            style={{ backgroundColor }}
          >
            {buttonText}
            <ArrowRight
              className="-rotate-45 transition-all duration-300 group-hover:rotate-0"
              size={16}
            />
          </a>
        </div>
      </div>
    </section>
  );
}
