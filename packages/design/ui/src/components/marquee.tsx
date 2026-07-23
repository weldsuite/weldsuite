"use client";

import * as React from "react";
import { cn } from "../lib/utils";

interface MarqueeProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Optional CSS class name to apply custom styles
   */
  className?: string;
  /**
   * Whether to reverse the animation direction
   * @default false
   */
  reverse?: boolean;
  /**
   * Whether to pause the animation on hover
   * @default false
   */
  pauseOnHover?: boolean;
  /**
   * Content to be displayed in the marquee
   */
  children: React.ReactNode;
  /**
   * Whether to animate vertically instead of horizontally
   * @default false
   */
  vertical?: boolean;
  /**
   * Number of times to repeat the content
   * @default 4
   */
  repeat?: number;
}

// Generate unique ID for keyframes
let marqueeStyleId = 0;

function Marquee({
  className,
  reverse = false,
  pauseOnHover = false,
  children,
  vertical = false,
  repeat = 4,
  ...props
}: MarqueeProps) {
  const [styleId] = React.useState(() => `marquee-${++marqueeStyleId}`);

  // Inject keyframes into document head
  React.useEffect(() => {
    const styleEl = document.createElement('style');
    styleEl.id = styleId;
    styleEl.textContent = `
      @keyframes ${styleId}-scroll {
        from {
          transform: ${vertical ? 'translateY(0)' : 'translateX(0)'};
        }
        to {
          transform: ${vertical ? 'translateY(calc(-100% - var(--gap)))' : 'translateX(calc(-100% - var(--gap)))'};
        }
      }
    `;
    document.head.appendChild(styleEl);

    return () => {
      const el = document.getElementById(styleId);
      if (el) el.remove();
    };
  }, [styleId, vertical]);

  return (
    <div
      {...props}
      className={cn(
        "group flex overflow-hidden p-2 [--duration:40s] [--gap:1rem] [gap:var(--gap)]",
        {
          "flex-row": !vertical,
          "flex-col": vertical,
        },
        className
      )}
    >
      {Array(repeat)
        .fill(0)
        .map((_, i) => (
          <div
            key={i}
            className={cn("flex shrink-0 justify-around [gap:var(--gap)]", {
              "flex-row": !vertical,
              "flex-col": vertical,
            })}
            style={{
              animation: `${styleId}-scroll var(--duration) linear infinite`,
              animationDirection: reverse ? 'reverse' : 'normal',
              animationPlayState: 'running',
            }}
            onMouseEnter={pauseOnHover ? (e) => {
              (e.currentTarget as HTMLElement).style.animationPlayState = 'paused';
            } : undefined}
            onMouseLeave={pauseOnHover ? (e) => {
              (e.currentTarget as HTMLElement).style.animationPlayState = 'running';
            } : undefined}
          >
            {children}
          </div>
        ))}
    </div>
  );
}

export { Marquee };
