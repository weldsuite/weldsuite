import { useState } from 'react';
import { Info, AlertTriangle, CheckCircle2, Lightbulb, X } from 'lucide-react';
import { Alert } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@weldsuite/ui/lib/utils';

export interface InfoBannerProps {
  /**
   * The banner content to display
   */
  children: React.ReactNode;

  /**
   * Visual variant for the banner
   * - info: General informational message (blue)
   * - warning: Warning or caution (yellow)
   * - success: Success or confirmation message (green)
   * - tip: Helpful tip or suggestion (purple)
   * @default "info"
   */
  variant?: 'info' | 'warning' | 'success' | 'tip';

  /**
   * Optional title for the banner
   */
  title?: string | React.ReactNode;

  /**
   * Whether the banner can be dismissed
   * @default false
   */
  dismissible?: boolean;

  /**
   * Callback when banner is dismissed (optional)
   */
  onDismiss?: () => void;

  /**
   * Optional custom className
   */
  className?: string;
}

const variantConfig = {
  info: {
    icon: Info,
    className:
      'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100',
    iconClassName: 'text-blue-600 dark:text-blue-400',
  },
  warning: {
    icon: AlertTriangle,
    className:
      'border-yellow-200 bg-yellow-50 text-yellow-900 dark:border-yellow-900 dark:bg-yellow-950 dark:text-yellow-100',
    iconClassName: 'text-yellow-600 dark:text-yellow-400',
  },
  success: {
    icon: CheckCircle2,
    className:
      'border-green-200 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950 dark:text-green-100',
    iconClassName: 'text-green-600 dark:text-green-400',
  },
  tip: {
    icon: Lightbulb,
    className:
      'border-purple-200 bg-purple-50 text-purple-900 dark:border-purple-900 dark:bg-purple-950 dark:text-purple-100',
    iconClassName: 'text-purple-600 dark:text-purple-400',
  },
};

/**
 * InfoBanner - Full-width contextual banner for page or section-level information
 *
 * @example
 * <InfoBanner variant="warning" title="Action Required" dismissible>
 *   Please complete your tax settings before creating invoices.
 * </InfoBanner>
 */
export function InfoBanner({
  children,
  variant = 'info',
  title,
  dismissible = false,
  onDismiss,
  className,
}: InfoBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  const config = variantConfig[variant];
  const Icon = config.icon;

  if (dismissed) {
    return null;
  }

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };

  return (
    <Alert className={cn(config.className, 'relative', className)}>
      <Icon className={cn(config.iconClassName)} />
      <div className="col-start-2">
        {title && <div className="font-semibold mb-1 text-sm">{title}</div>}
        <div className="text-sm leading-relaxed">{children}</div>
      </div>
      {dismissible && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 absolute top-2 right-2 opacity-70 hover:opacity-100"
          onClick={handleDismiss}
          aria-label="Dismiss banner"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </Alert>
  );
}
