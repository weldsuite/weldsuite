"use client";

import React from 'react';

interface SpacerBlockProps {
  height?: number;
  mode?: string;
}

export function SpacerBlock({
  height = 40,
  mode = 'live'
}: SpacerBlockProps) {
  const isEditing = mode === 'edit';

  return (
    <div
      className="flex-shrink-0"
      style={{ height: `${height}px`, width: '100%', alignSelf: 'stretch' }}
    />
  );
}
