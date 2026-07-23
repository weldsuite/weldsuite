"use client";

import React from 'react';
import { ArrowRight } from "lucide-react";

export interface HeroArrowButtonBlockProps {
  text?: string;
  link?: string;
  mode?: 'live' | 'edit' | 'preview';
}

export function HeroArrowButtonBlock({
  text = "Get Started",
  link = "#",
  mode = 'live',
}: HeroArrowButtonBlockProps) {
  const isEditing = mode === 'edit' || mode === 'preview';

  return (
    <a
      href={isEditing ? undefined : link}
      onClick={(e) => isEditing && e.preventDefault()}
      className={`group mx-auto flex w-fit items-center justify-center gap-2 rounded-full px-4 py-2 text-md tracking-tight bg-secondary hover:bg-secondary/80 transition-colors ${
        isEditing ? 'pointer-events-none' : ''
      }`}
    >
      <span>{text}</span>
      <ArrowRight className="size-4 -rotate-45 transition-all ease-out group-hover:ml-3 group-hover:rotate-0" />
    </a>
  );
}
