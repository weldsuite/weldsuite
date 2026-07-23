import {
  Hash,
  Ban,
  CircleCheck,
  Calculator,
  BarChart3,
  CheckSquare,
  Percent,
  GaugeCircle,
  Square,
  Copy,
} from 'lucide-react';
import { FieldType, CalculationType, CalculationOption } from '../types';

// Get default width for a field type
export function getDefaultWidthForFieldType(type: FieldType): number {
  switch (type) {
    case 'checkbox':
      return 100;
    case 'text':
      return 200;
    case 'number':
      return 120;
    case 'email':
      return 220;
    case 'phone':
      return 150;
    case 'single-select':
      return 150;
    case 'multi-select':
      return 200;
    case 'currency':
      return 120;
    case 'date':
      return 140;
    case 'url':
      return 200;
    case 'percent':
      return 100;
    case 'location':
      return 180;
    case 'company':
      return 280;
    case 'rating':
      return 120;
    default:
      return 150;
  }
}

// Get default value for a field type
export function getDefaultValueForFieldType(type: FieldType): any {
  switch (type) {
    case 'checkbox':
      return false;
    case 'text':
    case 'email':
    case 'phone':
    case 'url':
      return '';
    case 'number':
    case 'currency':
    case 'percent':
      return 0;
    case 'date':
      return null;
    case 'single-select':
      return null;
    case 'multi-select':
      return [];
    case 'location':
      return { city: '', state: '', country: '' };
    case 'rating':
      return 0;
    default:
      return '';
  }
}

// Get calculation options for a field type
export function getCalculationOptions(fieldType: FieldType): CalculationOption[] {
  const commonOptions: CalculationOption[] = [
    { value: 'count', label: 'Count all', icon: Hash },
    { value: 'count_empty', label: 'Count empty', icon: Ban },
    { value: 'count_not_empty', label: 'Count not empty', icon: CircleCheck },
    { value: 'count_duplicates', label: 'Count duplicates', icon: Copy },
    { value: 'percent_empty', label: 'Percent empty', icon: Percent },
    { value: 'percent_not_empty', label: 'Percent filled', icon: Percent },
    { value: 'percent_unique', label: 'Percent unique', icon: Percent },
  ];

  if (fieldType === 'number' || fieldType === 'currency' || fieldType === 'percent') {
    return [
      ...commonOptions,
      { value: 'sum', label: 'Sum', icon: Calculator },
      { value: 'average', label: 'Average', icon: BarChart3 },
      { value: 'median', label: 'Median', icon: GaugeCircle },
    ];
  }

  if (fieldType === 'checkbox') {
    return [
      ...commonOptions,
      { value: 'checked', label: 'Checked', icon: CheckSquare },
      { value: 'unchecked', label: 'Unchecked', icon: Square },
      { value: 'percent_checked', label: 'Percent checked', icon: Percent },
      { value: 'percent_unchecked', label: 'Percent unchecked', icon: Percent },
    ];
  }

  return commonOptions;
}

// Format currency value
export function formatCurrency(value: number, options?: { compact?: boolean }): string {
  if (options?.compact && Math.abs(value) >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`;
  }
  return `$${value.toLocaleString()}`;
}

// Format date value
export function formatDate(
  value: Date | string | null | undefined,
  options?: { format?: 'short' | 'medium' | 'long' }
): string {
  if (!value) return '';

  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return '';

  const formatOption = options?.format || 'medium';

  switch (formatOption) {
    case 'short':
      return date.toLocaleDateString('en-US', {
        month: 'numeric',
        day: 'numeric',
      });
    case 'medium':
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    case 'long':
      return date.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      });
    default:
      return date.toLocaleDateString();
  }
}

// Format percent value
export function formatPercent(value: number): string {
  return `${value}%`;
}
