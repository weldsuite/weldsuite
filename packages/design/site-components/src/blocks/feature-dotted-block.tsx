"use client";

import { ArrowUpRight, ChevronRight, ChevronUp } from "lucide-react";
import React from "react";
import { cn } from "@weldsuite/ui/lib/utils";

interface FeatureDottedBlockProps {
  badgeText?: string;
  heading?: string;
  description?: string;
  buttonText?: string;
  buttonLink?: string;
  cardDate?: string;
  cardMonth?: string;
  cardTitle?: string;
  cardDescription?: string;
  cardImage?: string;
  cardLinkText?: string;
  cardLinkUrl?: string;
  backgroundColor?: string;
  textColor?: string;
  className?: string;
  mode?: 'live' | 'edit' | 'preview';
  store?: any;
}

const DottedDiv = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => (
  <div className={cn("relative", className)}>
    {children}
  </div>
);

export function FeatureDottedBlock({
  badgeText = "Copy paste Blocks for your app",
  heading = "The Blocks Built\nWith Shadcn\n& Tailwind.",
  description = "Finely crafted components built with React, Tailwind and Shadcn UI. Developers can copy and paste these blocks directly into their project.",
  buttonText = "Get Started",
  buttonLink = "#",
  cardDate = "2025",
  cardMonth = "March",
  cardTitle = "New\nCollection",
  cardDescription = "Discover our latest release of beautifully crafted components.",
  cardImage = "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/photos/simone-hutsch-5oYbG-sEImY-unsplash.jpg",
  cardLinkText = "See All",
  cardLinkUrl = "#",
  backgroundColor,
  textColor,
  className,
  mode = 'live',
  store,
}: FeatureDottedBlockProps) {
  const isEditing = mode === 'edit' || mode === 'preview';

  // Split heading into lines for line breaks
  const headingLines = heading.split('\n');

  return (
    <section className={cn("bg-background py-32", className)} style={{ backgroundColor }}>
      <div className="container mx-auto px-4">
        <div className="relative flex flex-col items-center lg:pt-8">
        <DottedDiv>
          <div className="grid lg:grid-cols-2">
            {/* Left Content */}
            <div className="flex w-full flex-col gap-8 px-10 py-20 md:px-14">
              <div
                className="flex w-fit cursor-pointer items-center gap-4 rounded-full border px-6 py-2 transition-all ease-in-out hover:gap-6"
              >
                <span className="text-sm font-medium tracking-tight text-muted-foreground">
                  {badgeText}
                </span>
                <ChevronRight className="size-4" />
              </div>
              <h1
                className="text-5xl font-semibold tracking-tighter md:text-7xl"
                style={{ color: textColor }}
              >
                {headingLines.map((line, i) => (
                  <React.Fragment key={i}>
                    {line}
                    {i < headingLines.length - 1 && <br />}
                  </React.Fragment>
                ))}
              </h1>
              <p className="tracking-tight text-muted-foreground md:text-xl">
                {description}
              </p>
              <div className="flex w-full gap-2">
                <a
                  href={isEditing ? undefined : buttonLink}
                  onClick={(e) => isEditing && e.preventDefault()}
                  className={cn(
                    "text-md h-12 flex items-center justify-center w-fit rounded-full bg-primary px-10 text-primary-foreground hover:bg-primary/90 transition-colors",
                    isEditing && "pointer-events-none"
                  )}
                >
                  {buttonText}
                </a>
                <a
                  href={isEditing ? undefined : buttonLink}
                  onClick={(e) => isEditing && e.preventDefault()}
                  className={cn(
                    "text-md h-12 w-12 flex items-center justify-center rounded-full border transition-all ease-in-out hover:rotate-45",
                    isEditing && "pointer-events-none"
                  )}
                >
                  <ArrowUpRight />
                </a>
              </div>
            </div>

            {/* Right Content */}
            <DottedDiv className="group size-full place-self-end p-4 lg:w-4/6">
              <div className="relative h-full w-full bg-muted/50 p-4 transition-all ease-in-out group-hover:bg-muted">
                {/* Bg Image div */}
                <div className="relative h-full w-full overflow-hidden rounded-3xl">
                  <img
                    src={cardImage}
                    alt="Feature image"
                    className="h-full w-full object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent"></div>
                </div>

                <div className="absolute top-4 -ml-4 flex h-full w-full flex-col items-center justify-between p-10">
                  <p className="flex w-full items-center text-xl tracking-tighter text-white">
                    {cardDate} <span className="mx-2 h-2.5 w-[1px] bg-white" />
                    {cardMonth}
                  </p>
                  <div className="flex flex-col items-center justify-center">
                    <h2 className="text-center text-6xl font-semibold tracking-tight text-white">
                      {cardTitle.split('\n').map((line, i) => (
                        <React.Fragment key={i}>
                          {line}
                          {i < cardTitle.split('\n').length - 1 && <br />}
                        </React.Fragment>
                      ))}
                    </h2>
                    <div className="mt-2 h-1 w-6 rounded-full bg-white" />
                    <p className="mt-10 max-w-sm px-2 text-center text-lg leading-5 font-light tracking-tighter text-white/80">
                      {cardDescription}
                    </p>
                  </div>
                  <a
                    href={isEditing ? undefined : cardLinkUrl}
                    onClick={(e) => isEditing && e.preventDefault()}
                    className={cn(
                      "group mb-6 flex cursor-pointer flex-col items-center justify-center text-white",
                      isEditing && "pointer-events-none"
                    )}
                  >
                    <ChevronUp
                      size={30}
                      className="transition-all ease-in-out group-hover:-translate-y-2"
                    />
                    <p className="text-xl tracking-tight text-white">
                      {cardLinkText}
                    </p>
                  </a>
                </div>
              </div>
            </DottedDiv>
          </div>
        </DottedDiv>
        </div>
      </div>
    </section>
  );
}
