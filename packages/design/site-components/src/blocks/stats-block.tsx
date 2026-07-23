"use client";

import React, { useState, useEffect, useRef } from 'react';

export interface StatsBlockProps {
  number?: string;
  label?: string;
  icon?: string;
  prefix?: string;
  suffix?: string;
  animateOnScroll?: boolean;
  duration?: number;
  numberColor?: string;
  labelColor?: string;
  iconColor?: string;
  mode?: 'live' | 'preview';
}

export function StatsBlock({
  number = '1000',
  label = 'Happy Customers',
  icon,
  prefix = '',
  suffix = '',
  animateOnScroll = true,
  duration = 2000,
  numberColor = '#000000',
  labelColor = '#6b7280',
  iconColor = '#3b82f6',
  mode = 'live'
}: StatsBlockProps) {
  const [displayNumber, setDisplayNumber] = useState(animateOnScroll ? '0' : number);
  const [hasAnimated, setHasAnimated] = useState(false);
  const blockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!animateOnScroll || hasAnimated) {
      setDisplayNumber(number);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setHasAnimated(true);
          animateNumber();
        }
      },
      { threshold: 0.5 }
    );

    if (blockRef.current) {
      observer.observe(blockRef.current);
    }

    return () => observer.disconnect();
  }, [animateOnScroll, hasAnimated, number]);

  const animateNumber = () => {
    const targetNumber = parseFloat(number.replace(/,/g, ''));
    const startTime = Date.now();
    const isDecimal = number.includes('.');

    const updateNumber = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      const easeOutQuad = (t: number) => t * (2 - t);
      const easedProgress = easeOutQuad(progress);

      const current = targetNumber * easedProgress;
      const formatted = isDecimal
        ? current.toFixed(1)
        : Math.floor(current).toLocaleString();

      setDisplayNumber(formatted);

      if (progress < 1) {
        requestAnimationFrame(updateNumber);
      } else {
        setDisplayNumber(number);
      }
    };

    requestAnimationFrame(updateNumber);
  };

  return (
    <div ref={blockRef} className="text-center p-6">
      {icon && (
        <div className="mb-4 flex justify-center">
          <div
            className="w-12 h-12 flex items-center justify-center rounded-full"
            style={{ backgroundColor: `${iconColor}20` }}
          >
            <span className="text-2xl" style={{ color: iconColor }}>
              {icon}
            </span>
          </div>
        </div>
      )}
      <div className="text-4xl md:text-5xl font-bold mb-2" style={{ color: numberColor }}>
        {prefix}
        {displayNumber}
        {suffix}
      </div>
      <div className="text-lg" style={{ color: labelColor }}>
        {label}
      </div>
    </div>
  );
}
