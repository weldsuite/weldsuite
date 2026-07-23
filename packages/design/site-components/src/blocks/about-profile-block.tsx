"use client";

import React from "react";
import { cn } from "@weldsuite/ui/lib/utils";

interface AboutProfileBlockProps {
  name?: string;
  handle?: string;
  image?: string;
  title?: string;
  titleHighlight?: string;
  description1?: string;
  description2?: string;
  backgroundColor?: string;
  textColor?: string;
  cardBackgroundColor?: string;
  cardTextColor?: string;
  className?: string;
  mode?: 'live' | 'edit';
  store?: any;
}

export function AboutProfileBlock({
  name = "John Doe",
  handle = "@shadcnblocks.com",
  image = "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/guri4/img14.png",
  title = "Shaping ideas with clarity and",
  titleHighlight = "impact",
  description1 = "Lorem ipsum dolor, sit amet consectetur adipisicing elit. Eveniet voluptate saepe quas cum reprehenderit eligendi inventore animi excepturi sapiente earum.",
  description2 = "Lorem ipsum dolor, sit amet consectetur adipisicing elit. Eveniet voluptate saepe quas cum reprehenderit eligendi inventore animi excepturi sapiente earum.",
  backgroundColor = "#09090b",
  textColor = "#fafafa",
  cardBackgroundColor = "#fafafa",
  cardTextColor = "#09090b",
  className,
  mode = 'live',
  store,
}: AboutProfileBlockProps) {
  return (
    <section
      className={cn("py-32", className)}
      style={{
        backgroundColor: backgroundColor,
        color: textColor,
      }}
    >
      <div className="container mx-auto px-4">
        <div className="flex flex-col items-center justify-center gap-16 lg:flex-row lg:gap-[10vw]">
          {/* Profile Card */}
          <div
            className="w-[320px] flex-shrink-0 rotate-[-6deg] border p-1"
            style={{
              backgroundColor: cardBackgroundColor,
              color: cardTextColor,
            }}
          >
            <img
              src={image}
              alt={name}
              className="pointer-events-none h-[440px] w-full object-cover"
            />

            <div className="pt-2 pb-1">
              <p
                className="text-lg font-medium tracking-tight"
                style={{ color: cardTextColor }}
              >
                {name}
              </p>
              <p
                className="text-sm"
                style={{ color: `${cardTextColor}80` }}
              >
                {handle}
              </p>
            </div>
          </div>

          {/* Content */}
          <div className="w-[320px] flex-shrink-0 space-y-6">
            <h1 className="mb-10 text-5xl font-medium tracking-tight">
              {title}{" "}
              <span className="italic">{titleHighlight}</span>
            </h1>
            <p className="text-sm lg:text-base" style={{ color: textColor }}>
              {description1}
            </p>
            <p className="text-sm lg:text-base" style={{ color: textColor }}>
              {description2}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
