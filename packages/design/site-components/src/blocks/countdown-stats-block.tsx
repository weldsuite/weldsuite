"use client";

import React, { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@weldsuite/ui/lib/utils";

export interface CountdownStatsBlockProps {
  title?: string;
  endDate?: string;
  buttonText?: string;
  buttonLink?: string;
  mode?: 'live' | 'edit' | 'preview';
}

interface TimeLeft {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export function CountdownStatsBlock({
  title = "50 new blocks every month",
  endDate = "2025-12-31",
  buttonText = "Join The Waitlist",
  buttonLink = "#",
  mode = 'live',
}: CountdownStatsBlockProps) {
  const isEditing = mode === 'edit' || mode === 'preview';
  const [timeLeft, setTimeLeft] = useState<TimeLeft>({
    days: 0,
    hours: 0,
    minutes: 0,
    seconds: 0,
  });

  useEffect(() => {
    const calculateTimeLeft = () => {
      const end = new Date(endDate);
      const difference = end.getTime() - new Date().getTime();

      if (difference > 0) {
        const days = Math.floor(difference / (1000 * 60 * 60 * 24));
        const hours = Math.floor((difference / (1000 * 60 * 60)) % 24);
        const minutes = Math.floor((difference / 1000 / 60) % 60);
        const seconds = Math.floor((difference / 1000) % 60);

        setTimeLeft({ days, hours, minutes, seconds });
      } else {
        setTimeLeft({ days: 0, hours: 0, minutes: 0, seconds: 0 });
      }
    };

    calculateTimeLeft();
    const timer = setInterval(calculateTimeLeft, 1000);

    return () => clearInterval(timer);
  }, [endDate]);

  return (
    <section className="py-32">
      <div className="container mx-auto flex items-center justify-center">
        <DottedDiv className="w-full" style={{ height: '424px' }}>
          <div className="flex h-full w-full flex-col items-center justify-center">
            <p className="tracking-tight opacity-50 md:text-lg">
              {title}
            </p>
            <div className="flex items-center justify-center gap-4 my-4">
              <div className="flex flex-col items-center">
                <span className="text-3xl font-semibold tracking-tight sm:text-5xl">
                  {String(timeLeft.days).padStart(2, '0')}
                </span>
                <span className="text-sm text-gray-500">Days</span>
              </div>
              <div className="text-2xl font-bold">:</div>
              <div className="flex flex-col items-center">
                <span className="text-3xl font-semibold tracking-tight sm:text-5xl">
                  {String(timeLeft.hours).padStart(2, '0')}
                </span>
                <span className="text-sm text-gray-500">Hours</span>
              </div>
              <div className="text-2xl font-bold">:</div>
              <div className="flex flex-col items-center">
                <span className="text-3xl font-semibold tracking-tight sm:text-5xl">
                  {String(timeLeft.minutes).padStart(2, '0')}
                </span>
                <span className="text-sm text-gray-500">Minutes</span>
              </div>
              <div className="text-2xl font-bold">:</div>
              <div className="flex flex-col items-center">
                <span className="text-3xl font-semibold tracking-tight sm:text-5xl">
                  {String(timeLeft.seconds).padStart(2, '0')}
                </span>
                <span className="text-sm text-gray-500">Seconds</span>
              </div>
            </div>
            <a
              href={isEditing ? undefined : buttonLink}
              onClick={isEditing ? (e) => e.preventDefault() : undefined}
              className="group mt-7 flex w-fit items-center justify-center gap-2 rounded-xl bg-secondary px-4 py-2 text-md tracking-tight shadow-none hover:bg-secondary/80 transition-colors"
            >
              <span>{buttonText}</span>
              <ArrowRight className="size-4 -rotate-45 transition-all ease-out group-hover:ml-3 group-hover:rotate-0" />
            </a>
          </div>
        </DottedDiv>
      </div>
    </section>
  );
}

const DottedDiv = ({
  children,
  className,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) => (
  <div
    className={cn("relative h-full w-full overflow-hidden sm:p-4", className)}
    style={style}
  >
    {children}
  </div>
);
