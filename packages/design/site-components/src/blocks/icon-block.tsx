"use client";

import React from 'react';
import {
  Star,
  Heart,
  ShoppingBag,
  Truck,
  Shield,
  Check,
  Mail,
  Phone,
  MapPin,
  Clock,
  Award,
  Gift,
  type LucideIcon
} from 'lucide-react';

interface IconBlockProps {
  icon?: string;
  size?: number;
  color?: string;
  alignment?: 'left' | 'center' | 'right';
  mode?: string;
}

const iconMap: Record<string, LucideIcon> = {
  star: Star,
  heart: Heart,
  shoppingBag: ShoppingBag,
  truck: Truck,
  shield: Shield,
  check: Check,
  mail: Mail,
  phone: Phone,
  mapPin: MapPin,
  clock: Clock,
  award: Award,
  gift: Gift,
};

export function IconBlock({
  icon = 'star',
  size = 24,
  color = '#000000',
  alignment = 'center',
  mode = 'live'
}: IconBlockProps) {
  const Icon = iconMap[icon] || Star;

  const alignmentClass = {
    left: 'justify-start',
    center: 'justify-center',
    right: 'justify-end',
  }[alignment];

  return (
    <div className={`flex ${alignmentClass}`}>
      <Icon size={size} style={{ color }} />
    </div>
  );
}
