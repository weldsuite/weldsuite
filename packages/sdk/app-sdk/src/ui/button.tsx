import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
export type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
}

const variantClass: Record<ButtonVariant, string> = {
  default: '',
  destructive: 'wui-btn--destructive',
  outline: 'wui-btn--outline',
  secondary: 'wui-btn--secondary',
  ghost: 'wui-btn--ghost',
  link: 'wui-btn--link',
};

const sizeClass: Record<ButtonSize, string> = {
  default: '',
  sm: 'wui-btn--sm',
  lg: 'wui-btn--lg',
  icon: 'wui-btn--icon',
};

/** Suite-styled button (platform Button variants). */
export function Button({
  variant = 'default',
  size = 'default',
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn('wui-btn', variantClass[variant], sizeClass[size], className)}
      {...props}
    />
  );
}
