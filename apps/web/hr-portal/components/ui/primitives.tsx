'use client';

import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type LabelHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none min-h-[44px]',
        variant === 'primary' && 'portal-btn-primary text-white hover:opacity-90',
        variant === 'secondary' && 'border border-gray-300 bg-white text-gray-900 hover:bg-gray-50',
        variant === 'ghost' && 'text-gray-600 hover:bg-gray-100',
        className,
      )}
      {...props}
    />
  );
});

export const Card = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function Card(
  { className, ...props },
  ref,
) {
  return <div ref={ref} className={cx('rounded-lg border border-gray-200 bg-white p-4 sm:p-5', className)} {...props} />;
});

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cx('block text-sm font-medium text-gray-700 mb-1.5', className)} {...props} />;
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cx(
        'w-full rounded-md border border-gray-300 px-3 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-0',
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cx(
        'w-full rounded-md border border-gray-300 px-3 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-gray-400',
        className,
      )}
      {...props}
    />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cx(
        'w-full rounded-md border border-gray-300 px-3 py-2.5 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gray-400',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
});

export function PageHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 mb-5">
      <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">{title}</h1>
      {action}
    </div>
  );
}
