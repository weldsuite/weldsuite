import { Loader2 } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';

export interface PageLoaderProps {
  label?: string;
  className?: string;
  fullScreen?: boolean;
}

export function PageLoader({ label = 'Loading...', className, fullScreen = true }: PageLoaderProps) {
  return (
    <div
      className={cn(
        'w-full flex items-center justify-center',
        fullScreen ? 'min-h-screen' : 'h-full min-h-[calc(100vh-8rem)] pb-[60px]',
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}
