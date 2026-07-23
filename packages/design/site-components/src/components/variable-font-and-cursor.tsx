"use client";

import React, { useEffect, useState, RefObject } from "react";
import { cn } from "@weldsuite/ui/lib/utils";

interface FontVariationAxis {
  name: string;
  min: number;
  max: number;
}

interface FontVariationMapping {
  x?: FontVariationAxis;
  y?: FontVariationAxis;
}

interface VariableFontAndCursorProps {
  label: string;
  className?: string;
  style?: React.CSSProperties;
  fontVariationMapping?: FontVariationMapping;
  containerRef: RefObject<HTMLDivElement>;
}

export function VariableFontAndCursor({
  label,
  className,
  style,
  fontVariationMapping = {
    y: { name: "wght", min: 100, max: 900 },
    x: { name: "slnt", min: 0, max: -10 },
  },
  containerRef,
}: VariableFontAndCursorProps) {
  const [fontVariationSettings, setFontVariationSettings] = useState<string>(
    `"wght" 400, "slnt" 0`
  );

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      // Normalize x and y to 0-1 range based on container size
      const normalizedX = Math.max(0, Math.min(1, x / rect.width));
      const normalizedY = Math.max(0, Math.min(1, y / rect.height));

      const settings: string[] = [];

      if (fontVariationMapping.x) {
        const { name, min, max } = fontVariationMapping.x;
        const value = min + normalizedX * (max - min);
        settings.push(`"${name}" ${value.toFixed(2)}`);
      }

      if (fontVariationMapping.y) {
        const { name, min, max } = fontVariationMapping.y;
        const value = min + normalizedY * (max - min);
        settings.push(`"${name}" ${value.toFixed(2)}`);
      }

      if (settings.length > 0) {
        setFontVariationSettings(settings.join(", "));
      }
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener("mousemove", handleMouseMove);
    }

    return () => {
      if (container) {
        container.removeEventListener("mousemove", handleMouseMove);
      }
    };
  }, [containerRef, fontVariationMapping]);

  return (
    <span
      className={cn("transition-all duration-75", className)}
      style={{
        fontVariationSettings,
        fontFamily: "'Inter', sans-serif",
        ...style,
      }}
    >
      {label}
    </span>
  );
}
