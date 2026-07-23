"use client";

import { useRouter as useNextRouter } from "next/navigation";
import { useCallback } from "react";

export function useRouter() {
  const router = useNextRouter();

  const push = useCallback((href: string) => {
    // Check if browser supports View Transitions API
    if (document.startViewTransition) {
      document.startViewTransition(() => {
        router.push(href);
      });
    } else {
      // Fallback: Manual fade transition
      const rightColumn = document.querySelector('.transition-container');
      if (rightColumn) {
        rightColumn.classList.add('fade-out');
        setTimeout(() => {
          router.push(href);
        }, 300);
      } else {
        router.push(href);
      }
    }
  }, [router]);

  const back = useCallback(() => {
    if (document.startViewTransition) {
      document.startViewTransition(() => {
        router.back();
      });
    } else {
      const rightColumn = document.querySelector('.transition-container');
      if (rightColumn) {
        rightColumn.classList.add('fade-out');
        setTimeout(() => {
          router.back();
        }, 300);
      } else {
        router.back();
      }
    }
  }, [router]);

  return { ...router, push, back };
}