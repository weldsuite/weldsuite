"use client";

import React, { useEffect, useState } from "react";

export interface CountdownTimerBlockProps {
  endDate?: string;
  mode?: 'live' | 'edit' | 'preview';
}

interface TimeLeft {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export function CountdownTimerBlock({
  endDate = "2025-12-31",
  mode = 'live',
}: CountdownTimerBlockProps) {
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
    <div className="flex items-center justify-center gap-4">
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
  );
}
