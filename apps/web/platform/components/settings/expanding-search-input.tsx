import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';

interface ExpandingSearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/**
 * Icon button that expands into an inline search input on click and collapses
 * again on blur while empty. Shared by the settings tables (activity log,
 * roles, custom fields, API keys, shortcuts, ticket settings, ...).
 */
export function ExpandingSearchInput({ value, onChange, placeholder }: ExpandingSearchInputProps) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  return (
    <div className="relative flex items-center">
      <div
        className={cn(
          'flex items-center transition-all duration-200 ease-out',
          open ? 'w-48' : 'w-8',
        )}
      >
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-8 w-8 p-0 flex-shrink-0 transition-opacity duration-200',
            open && 'opacity-0 pointer-events-none absolute',
          )}
          onClick={() => setOpen(true)}
        >
          <Search className="h-4 w-4" />
        </Button>
        <div
          className={cn(
            'relative transition-all duration-200 ease-out',
            open ? 'opacity-100 w-48' : 'opacity-0 w-0 pointer-events-none',
          )}
        >
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            placeholder={placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => !value && setOpen(false)}
            className="h-8 w-full pl-8 pr-3 text-sm border border-border rounded-md bg-background focus:outline-none"
          />
        </div>
      </div>
    </div>
  );
}
