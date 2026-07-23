"use client";

import React, { useState, useEffect } from 'react';

export interface CountdownBlockProps {
  endDate?: string;
  showDays?: boolean;
  showHours?: boolean;
  showMinutes?: boolean;
  showSeconds?: boolean;
  size?: 'sm' | 'md' | 'lg';
  labels?: {
    days?: string;
    hours?: string;
    minutes?: string;
    seconds?: string;
  };
  textColor?: string;
  backgroundColor?: string;
  mode?: 'live' | 'preview';
}

export function CountdownBlock({
  endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  showDays = true,
  showHours = true,
  showMinutes = true,
  showSeconds = true,
  size = 'md',
  labels = {
    days: 'Days',
    hours: 'Hours',
    minutes: 'Minutes',
    seconds: 'Seconds',
  },
  textColor = '#000000',
  backgroundColor = '#f3f4f6',
  mode = 'live'
}: CountdownBlockProps) {
  const [timeLeft, setTimeLeft] = useState({
    days: 0,
    hours: 0,
    minutes: 0,
    seconds: 0,
  });

  useEffect(() => {
    const calculateTimeLeft = () => {
      const difference = new Date(endDate).getTime() - new Date().getTime();

      if (difference > 0) {
        setTimeLeft({
          days: Math.floor(difference / (1000 * 60 * 60 * 24)),
          hours: Math.floor((difference / (1000 * 60 * 60)) % 24),
          minutes: Math.floor((difference / 1000 / 60) % 60),
          seconds: Math.floor((difference / 1000) % 60),
        });
      } else {
        setTimeLeft({ days: 0, hours: 0, minutes: 0, seconds: 0 });
      }
    };

    calculateTimeLeft();
    const timer = setInterval(calculateTimeLeft, 1000);

    return () => clearInterval(timer);
  }, [endDate]);

  const sizeClasses = {
    sm: {
      number: 'text-2xl md:text-3xl',
      label: 'text-xs',
      padding: 'p-3',
    },
    md: {
      number: 'text-4xl md:text-5xl',
      label: 'text-sm',
      padding: 'p-4',
    },
    lg: {
      number: 'text-5xl md:text-6xl',
      label: 'text-base',
      padding: 'p-6',
    },
  }[size];

  const units = [
    { value: timeLeft.days, label: labels.days, show: showDays },
    { value: timeLeft.hours, label: labels.hours, show: showHours },
    { value: timeLeft.minutes, label: labels.minutes, show: showMinutes },
    { value: timeLeft.seconds, label: labels.seconds, show: showSeconds },
  ].filter((unit) => unit.show);

  return (
    <div className="flex gap-4 justify-center flex-wrap">
      {units.map((unit, index) => (
        <div
          key={index}
          className={`rounded-lg ${sizeClasses.padding} min-w-[80px] text-center`}
          style={{ backgroundColor }}
        >
          <div className={`font-bold ${sizeClasses.number}`} style={{ color: textColor }}>
            {String(unit.value).padStart(2, '0')}
          </div>
          <div className={`uppercase ${sizeClasses.label} opacity-70`} style={{ color: textColor }}>
            {unit.label}
          </div>
        </div>
      ))}
    </div>
  );
}
