import React from 'react';
import { cn } from '@/lib/utils';

interface ProjectToolbarProps {
  leftContent?: React.ReactNode;
  rightContent?: React.ReactNode;
  paddingLeft?: string;
  paddingRight?: string;
  paddingTop?: string;
  paddingBottom?: string;
  leftContentMargin?: string;
  rightContentMargin?: string;
  hideBorder?: boolean;
  className?: string;
}

export function ProjectToolbar({
  leftContent,
  rightContent,
  paddingLeft = '16px',
  paddingRight = '16px',
  paddingTop = '10px',
  paddingBottom = '10px',
  leftContentMargin,
  rightContentMargin,
  hideBorder = false,
  className,
}: ProjectToolbarProps) {
  return (
    <div
      className={cn(
        'bg-background sticky top-0 z-10 w-full max-w-full',
        !hideBorder && 'border-b',
        className
      )}
      style={{
        paddingTop,
        paddingBottom,
      }}
    >
      <div
        className="flex items-center gap-2 px-3 md:px-0 overflow-x-auto md:overflow-x-visible md:flex-wrap md:justify-between [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] w-full"
        style={{
          paddingLeft: undefined,
          paddingRight: undefined,
          WebkitOverflowScrolling: 'touch',
        }}
      >
        <div
          className="flex items-center gap-2 flex-shrink-0 md:flex-shrink md:flex-wrap md:pl-[var(--toolbar-padding-left)]"
          style={{
            marginLeft: leftContentMargin,
            '--toolbar-padding-left': leftContentMargin ? undefined : paddingLeft,
          } as React.CSSProperties}
        >
          {leftContent}
        </div>
        <div
          className="flex items-center gap-2 md:gap-3 flex-shrink-0 md:flex-shrink md:flex-wrap md:pr-[var(--toolbar-padding-right)] ml-auto"
          style={{
            marginRight: rightContentMargin,
            '--toolbar-padding-right': rightContentMargin ? undefined : paddingRight,
          } as React.CSSProperties}
        >
          {rightContent}
        </div>
      </div>
    </div>
  );
}
