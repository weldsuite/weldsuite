"use client";

import React from 'react';
import { cn } from '@weldsuite/ui/lib/utils';

interface PoweredByBadgeProps {
  className?: string;
  variant?: 'simple' | 'badge' | 'footer';
}

export function PoweredByBadge({ className, variant = 'simple' }: PoweredByBadgeProps) {
  if (variant === 'badge') {
    return (
      <div className={cn("inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-muted/50 border", className)}>
        <span className="text-xs text-muted-foreground">Built with</span>
        <a
          href="https://weldcommerce.app"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-semibold text-foreground hover:text-primary transition-colors"
        >
          WeldCommerce
        </a>
      </div>
    );
  }

  if (variant === 'footer') {
    return (
      <div className={cn("text-center py-4 border-t mt-8", className)}>
        <p className="text-sm text-muted-foreground">
          Built with{' '}
          <a
            href="https://weldcommerce.app"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-foreground hover:text-primary transition-colors"
          >
            WeldCommerce
          </a>
          {' '}website builder
        </p>
      </div>
    );
  }

  return (
    <div className={cn("text-center py-2", className)}>
      <p className="text-xs text-muted-foreground">
        Powered by{' '}
        <a
          href="https://weldcommerce.app"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium hover:underline"
        >
          WeldCommerce
        </a>
      </p>
    </div>
  );
}
