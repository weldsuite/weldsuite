"use client";

import { useState, useEffect, RefObject } from "react";

interface MousePosition {
  x: number;
  y: number;
}

export function useMousePosition(
  containerRef?: RefObject<HTMLElement>
): MousePosition {
  const [mousePosition, setMousePosition] = useState<MousePosition>({
    x: 0,
    y: 0,
  });

  useEffect(() => {
    const updateMousePosition = (event: MouseEvent) => {
      if (containerRef?.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setMousePosition({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      } else {
        setMousePosition({
          x: event.clientX,
          y: event.clientY,
        });
      }
    };

    const container = containerRef?.current || window;
    container.addEventListener("mousemove", updateMousePosition as EventListener);

    return () => {
      container.removeEventListener("mousemove", updateMousePosition as EventListener);
    };
  }, [containerRef]);

  return mousePosition;
}
