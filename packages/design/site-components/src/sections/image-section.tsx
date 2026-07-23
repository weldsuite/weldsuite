"use client";

import Image from "next/image";

interface ImageSectionProps {
  src?: string;
  alt?: string;
  caption?: string;
  fullWidth?: boolean;
  height?: number;
  store?: any;
  settings?: any;
}

export default function ImageSection({
  src = "/placeholder.jpg",
  alt = "Image",
  caption,
  fullWidth = false,
  height = 400,
  store,
  settings
}: ImageSectionProps) {
  return (
    <section className={`py-12 ${fullWidth ? '' : 'px-4'}`}>
      <div className={`${fullWidth ? '' : 'container mx-auto'}`}>
        <div className="relative" style={{ height: `${height}px` }}>
          <Image
            src={src}
            alt={alt}
            fill
            className="object-cover"
          />
        </div>
        {caption && (
          <p className="text-center text-sm text-muted-foreground mt-4">
            {caption}
          </p>
        )}
      </div>
    </section>
  );
}