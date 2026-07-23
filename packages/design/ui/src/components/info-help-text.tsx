import { Info, AlertTriangle, Lightbulb } from 'lucide-react';
import { Alert } from '@weldsuite/ui/components/alert';
import { cn } from '@weldsuite/ui/lib/utils';

export interface InfoHelpTextProps {
  /**
   * The help text content to display
   */
  children: React.ReactNode;

  /**
   * Visual variant for the help text
   * - info: General informational help (blue)
   * - warning: Warning or caution (yellow)
   * - tip: Helpful tip or suggestion (green)
   * @default "info"
   */
  variant?: 'info' | 'warning' | 'tip';

  /**
   * Optional title for the help text
   */
  title?: string | React.ReactNode;

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
  tip: {
    icon: Lightbulb,
    className:
      'border-green-200 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950 dark:text-green-100',
    iconClassName: 'text-green-600 dark:text-green-400',
  },
};

/**
 * InfoHelpText - Standalone help text block with icon for inline explanations
 *
 * @example
 * <InfoHelpText variant="warning" title="Important">
 *   Changing this setting will affect all existing entries.
 * </InfoHelpText>
 */
export function InfoHelpText({ children, variant = 'info', title, className }: InfoHelpTextProps) {
  const config = variantConfig[variant];
  const Icon = config.icon;

  return (
    <Alert className={cn(config.className, className)}>
      <Icon className={cn(config.iconClassName)} />
      <div className="col-start-2">
        {title && <div className="font-semibold mb-1 text-sm">{title}</div>}
        <div className="text-sm leading-relaxed">{children}</div>
      </div>
    </Alert>
  );
}
