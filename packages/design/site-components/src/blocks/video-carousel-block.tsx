"use client";

import { AudioLines } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { cn } from "@weldsuite/ui/lib/utils";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@weldsuite/ui/components/carousel";

interface VideoSectionProps {
  videoSrc: string;
  thumbnailSrc: string;
  studioName: string;
  projectTitle: string;
}

const VideoSection: React.FC<VideoSectionProps> = ({
  videoSrc,
  thumbnailSrc,
  studioName,
  projectTitle,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  }, []);

  useEffect(() => {
    if (videoRef.current) {
      if (isHovered) {
        videoRef.current.play();
      } else {
        videoRef.current.pause();
        videoRef.current.currentTime = 0;
      }
    }
  }, [isHovered]);

  const handleMouseEnter = () => {
    setIsHovered(true);
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
  };

  return (
    <div
      className="group relative h-[60vh] w-full cursor-pointer overflow-hidden md:h-[70vh]"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Thumbnail Image */}
      <img
        src={thumbnailSrc}
        alt={projectTitle}
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ease-in-out ${
          isHovered ? "opacity-0" : "opacity-100"
        }`}
      />

      {/* Video */}
      <video
        ref={videoRef}
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ease-in-out ${
          isHovered ? "opacity-100" : "opacity-0"
        }`}
        muted
        loop
        playsInline
        preload="metadata"
      >
        <source src={videoSrc} type="video/mp4" />
        Your browser does not support the video tag.
      </video>

      <div className="absolute inset-0 bg-black/30 transition-all duration-500 group-hover:bg-black/20" />

      <div className="absolute inset-0 bottom-12 flex items-end">
        <div className="px-6 text-left text-white sm:px-8 md:px-12 lg:px-16 xl:px-20">
          <p className="mb-2 text-xs font-medium tracking-wider uppercase opacity-80 sm:mb-3 sm:text-sm md:mb-4 md:text-base">
            {studioName}
          </p>
          <h2 className="max-w-md text-2xl font-light tracking-tight sm:text-3xl md:text-4xl lg:max-w-lg">
            {projectTitle}
          </h2>
        </div>
      </div>
    </div>
  );
};

interface VideoItem {
  videoSrc: string;
  thumbnailSrc: string;
  studioName: string;
  projectTitle: string;
}

const DEFAULT_VIDEO_SECTIONS: VideoItem[] = [
  {
    thumbnailSrc: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/photos/jeremy-bishop-iEjCQtcsVPY-unsplash.jpg",
    videoSrc: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/3571264-hd_1280_720_30fps.mp4",
    studioName: "MERIDIAN FILMS",
    projectTitle: "Coastal Reflections",
  },
  {
    thumbnailSrc: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/photos/carles-rabada-f7UprkNqi08-unsplash.jpg",
    videoSrc: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/1448735-hd_1366_720_24fps.mp4",
    studioName: "ZENITH VISUALS",
    projectTitle: "Ethereal Moments",
  },
  {
    thumbnailSrc: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/photos/sam-wermut-FiUuNWxnb3k-unsplash.jpg",
    videoSrc: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/19348567-hd_1280_720_25fps.mp4",
    studioName: "NEXUS CREATIVE",
    projectTitle: "Deserted Frontiers",
  },
  {
    thumbnailSrc: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/photos/ines-alvarez-fdez-VjRc6HDXJ5s-unsplash.jpg",
    videoSrc: "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/9882072-hd_1280_720_30fps.mp4",
    studioName: "PRISM STUDIOS",
    projectTitle: "Nature's Symphony",
  },
];

interface VideoCarouselBlockProps {
  title?: string;
  subtitle?: string;
  videos?: VideoItem[];
  backgroundColor?: string;
  textColor?: string;
  className?: string;
  mode?: 'live' | 'edit';
  store?: any;
}

export function VideoCarouselBlock({
  title = "Explore Our Projects",
  subtitle = "Our Work",
  videos = DEFAULT_VIDEO_SECTIONS,
  backgroundColor = "#ffffff",
  textColor = "#000000",
  className,
  mode = 'live',
  store,
}: VideoCarouselBlockProps) {
  return (
    <section
      className={cn("w-full", className)}
      style={{
        backgroundColor: backgroundColor,
        color: textColor,
      }}
    >
      {/* Header Section */}
      <div className="container py-16">
        <div className="text-left" style={{ color: textColor }}>
          <h1 className="mb-4 text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl lg:mb-8 lg:text-8xl">
            {title}
          </h1>

          <div className="flex items-center">
            <p className="mr-4 text-sm font-medium tracking-wider uppercase opacity-80">
              {subtitle}
            </p>
            <div className="opacity-60">
              <AudioLines className="h-6 w-6" />
            </div>
          </div>
        </div>
      </div>

      {/* Full Width Carousel */}
      <div className="w-full">
        <Carousel
          opts={{
            align: "start",
            loop: true,
          }}
          className="w-full"
        >
          <CarouselContent className="-ml-2 md:-ml-4">
            {videos.map((section, index) => (
              <CarouselItem
                key={index}
                className="pl-2 md:basis-4/5 md:pl-4 lg:basis-3/4 xl:basis-2/3"
              >
                <VideoSection
                  videoSrc={section.videoSrc}
                  thumbnailSrc={section.thumbnailSrc}
                  studioName={section.studioName}
                  projectTitle={section.projectTitle}
                />
              </CarouselItem>
            ))}
          </CarouselContent>
          <CarouselPrevious className="left-4 md:left-8" />
          <CarouselNext className="right-4 md:right-8" />
        </Carousel>
      </div>
    </section>
  );
}
