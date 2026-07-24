import * as React from 'react';
import { cn } from '../../lib/utils';

interface RewardBadgeProps {
  icon?: string;
  color?: string;
  name: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function RewardBadge({ 
  icon, 
  color = '#3b82f6', 
  name, 
  size = 'md',
  className 
}: RewardBadgeProps) {
  const sizeClasses = {
    sm: 'w-12 h-12 text-lg',
    md: 'w-16 h-16 text-2xl',
    lg: 'w-20 h-20 text-3xl'
  };

  return (
    <div 
      className={cn(
        'relative inline-flex items-center justify-center rounded-full shadow-lg',
        sizeClasses[size],
        className
      )}
      style={{ backgroundColor: color }}
      title={name}
    >
      {icon ? (
        <span className="text-white">{icon}</span>
      ) : (
        <span className="text-white font-bold">
          {name.charAt(0).toUpperCase()}
        </span>
      )}
    </div>
  );
}