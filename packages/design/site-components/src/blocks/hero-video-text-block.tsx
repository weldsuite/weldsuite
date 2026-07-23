"use client";

import React from 'react';
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { cn } from "@weldsuite/ui/lib/utils";
import { VideoText } from "../components/video-text";

// Child Block: Video Text Heading
export interface HeroVideoTextHeadingBlockProps {
  videoUrl?: string;
  text?: string;
  fontFamily?: string;
  fontSize?: string;
  className?: string;
  mode?: 'live' | 'edit' | 'preview';
  store?: any;
}

export function HeroVideoTextHeadingBlock({
  videoUrl = "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ocean1080.mov",
  text = "Blocks",
  fontFamily = "Cal Sans, system-ui, sans-serif",
  fontSize = "200px",
  className,
  mode = 'live',
  store,
  // Also accept from settings prop spread
  settings,
  ...rest
}: HeroVideoTextHeadingBlockProps & { settings?: any }) {
  // Handle both direct props and nested settings
  const actualText = text || settings?.text || "Blocks";
  const actualVideoUrl = videoUrl || settings?.videoUrl || "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ocean1080.mov";
  const actualFontFamily = fontFamily || settings?.fontFamily || "Cal Sans, system-ui, sans-serif";
  const actualFontSize = fontSize || settings?.fontSize || "200px";

  return (
    <motion.div
      initial={{ opacity: 0, scale: 1.1 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3 }}
      className={cn("relative w-full h-[250px]", className)}
    >
      <VideoText
        src={actualVideoUrl}
        className={cn("font-bold tracking-tighter")}
        fontSize={actualFontSize}
        fontFamily={actualFontFamily}
      >
        {actualText}
      </VideoText>
    </motion.div>
  );
}

// Child Block: Description
export interface HeroVideoTextDescriptionBlockProps {
  description?: string;
  textColor?: string;
  fontSize?: string;
  maxWidth?: string;
  className?: string;
  mode?: 'live' | 'edit' | 'preview';
  store?: any;
}

export function HeroVideoTextDescriptionBlock({
  description = "Lorem ipsum dolor sit amet consectetur adipisicing elit. Ab sapiente quisquam debitis error vero possimus amet",
  textColor,
  fontSize = "lg",
  maxWidth = "xl",
  className,
  mode = 'live',
  store,
}: HeroVideoTextDescriptionBlockProps) {
  const maxWidthClasses: Record<string, string> = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    '2xl': 'max-w-2xl',
    '3xl': 'max-w-3xl',
    full: 'max-w-full',
  };

  const fontSizeClasses: Record<string, string> = {
    sm: 'text-sm',
    base: 'text-base',
    lg: 'text-lg',
    xl: 'text-xl',
    '2xl': 'text-2xl',
  };

  return (
    <p
      className={cn(
        "text-center",
        maxWidthClasses[maxWidth] || 'max-w-xl',
        fontSizeClasses[fontSize] || 'text-lg',
        className
      )}
      style={{ color: textColor || 'hsl(var(--muted-foreground))' }}
    >
      {description}
    </p>
  );
}

// Child Block: Button
export interface HeroVideoTextButtonBlockProps {
  buttonText?: string;
  buttonLink?: string;
  backgroundColor?: string;
  textColor?: string;
  showIcon?: boolean;
  className?: string;
  mode?: 'live' | 'edit' | 'preview';
  store?: any;
}

export function HeroVideoTextButtonBlock({
  buttonText = "Get Started",
  buttonLink = "#",
  backgroundColor,
  textColor,
  showIcon = true,
  className,
  mode = 'live',
  store,
}: HeroVideoTextButtonBlockProps) {
  const isEditing = mode === 'edit' || mode === 'preview';

  if (!buttonText) return null;

  return (
    <a
      href={isEditing ? undefined : buttonLink}
      onClick={(e) => isEditing && e.preventDefault()}
      className={cn(
        "group flex w-fit items-center justify-center gap-2 rounded-full px-6 py-3 text-md tracking-tight transition-colors",
        !backgroundColor && "bg-secondary hover:bg-secondary/80",
        isEditing && "pointer-events-none",
        className
      )}
      style={{
        backgroundColor: backgroundColor || undefined,
        color: textColor || undefined,
      }}
    >
      <span>{buttonText}</span>
      {showIcon && (
        <ArrowRight className="size-4 -rotate-45 transition-all ease-out group-hover:ml-2 group-hover:rotate-0" />
      )}
    </a>
  );
}

// Parent Block: Hero Video Text Container
export interface HeroVideoTextBlockProps {
  backgroundColor?: string;
  paddingTop?: number;
  paddingBottom?: number;
  gap?: number;
  className?: string;
  mode?: 'live' | 'edit' | 'preview';
  store?: any;
  children?: React.ReactNode;
  // Legacy props for backward compatibility (when no children)
  videoUrl?: string;
  text?: string;
  description?: string;
  buttonText?: string;
  buttonLink?: string;
  fontFamily?: string;
  textColor?: string;
}

export function HeroVideoTextBlock({
  backgroundColor = "transparent",
  paddingTop = 128,
  paddingBottom = 128,
  gap = 24,
  className,
  mode = 'live',
  store,
  children,
  // Legacy props
  videoUrl,
  text,
  description,
  buttonText,
  buttonLink,
  fontFamily,
  textColor,
}: HeroVideoTextBlockProps) {
  // Check if children are provided and not empty
  const hasChildren = React.Children.count(children) > 0;

  // If children are provided, render them
  if (hasChildren) {
    return (
      <section
        className={cn("w-full", className)}
        style={{
          backgroundColor,
          paddingTop: `${paddingTop}px`,
          paddingBottom: `${paddingBottom}px`,
        }}
      >
        <div className="container mx-auto px-4">
          <div
            className="flex flex-col items-center justify-center"
            style={{ gap: `${gap}px` }}
          >
            {children}
          </div>
        </div>
      </section>
    );
  }

  // Fallback: render with legacy props (backward compatibility)
  return (
    <section
      className={cn("w-full", className)}
      style={{
        backgroundColor,
        paddingTop: `${paddingTop}px`,
        paddingBottom: `${paddingBottom}px`,
      }}
    >
      <div className="container mx-auto px-4">
        <div
          className="flex flex-col items-center justify-center"
          style={{ gap: `${gap}px` }}
        >
          <HeroVideoTextHeadingBlock
            videoUrl={videoUrl}
            text={text}
            fontFamily={fontFamily}
            mode={mode}
            store={store}
          />
          <HeroVideoTextDescriptionBlock
            description={description}
            textColor={textColor}
            mode={mode}
            store={store}
          />
          <HeroVideoTextButtonBlock
            buttonText={buttonText}
            buttonLink={buttonLink}
            mode={mode}
            store={store}
          />
        </div>
      </div>
    </section>
  );
}
