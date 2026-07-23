
import { Button } from "@weldsuite/ui/components/button";
import { Badge } from "@weldsuite/ui/components/badge";
import { LucideIcon, Copy, ArrowLeft } from "lucide-react";
import { ReactNode, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from '@weldsuite/i18n/client';

export interface StatusBadgeConfig {
  label: string;
  icon: LucideIcon;
  className: string;
}

export interface DetailAction {
  label: string;
  icon: LucideIcon;
  onClick?: () => void;
  variant?: "default" | "outline" | "ghost" | "destructive";
  disabled?: boolean;
  title?: string;
  iconPosition?: "left" | "right";
}

export interface EntityDetailHeaderProps {
  /** Main entity ID to display */
  entityId?: string;
  /** Title prefix (e.g., "Cycle Count", "Purchase Order") */
  entityType?: string;
  /** Direct title string (alternative to entityType + entityId) */
  title?: string;
  /** Subtitle/description text */
  subtitle?: string;
  /** Icon to display next to the title */
  icon?: LucideIcon;
  /** Badge element to display next to the title */
  badge?: ReactNode;
  /** Action buttons (used when title/subtitle pattern is used) */
  actions?: DetailAction[];
  /** Status configuration */
  status?: {
    value: string;
    config: Record<string, StatusBadgeConfig>;
  };
  /** Priority configuration */
  priority?: {
    value: string;
    variant: "default" | "secondary" | "destructive" | "outline";
  };
  /** Quick action buttons (icons only) */
  quickActions?: DetailAction[];
  /** Primary action buttons (with labels) */
  primaryActions?: DetailAction[];
  /** Show back button */
  showBackButton?: boolean;
  /** Back button callback */
  onBack?: () => void;
  /** Avatar element to display before the title */
  avatar?: ReactNode;
  /** Children content (typically stats cards or tabs) */
  children?: ReactNode;
  /** Vertically center actions with title */
  centerActions?: boolean;
}

export function EntityDetailHeader({
  entityId,
  entityType,
  title,
  subtitle,
  icon: IconProp,
  badge,
  actions = [],
  status,
  priority,
  quickActions = [],
  primaryActions = [],
  showBackButton = false,
  onBack,
  avatar,
  children,
  centerActions = false,
}: EntityDetailHeaderProps) {
  const t = useTranslations();
  const [isHoveringTitle, setIsHoveringTitle] = useState(false);

  // Merge actions into primaryActions if using the title/subtitle pattern
  const resolvedPrimaryActions = primaryActions.length > 0 ? primaryActions : actions;

  const handleCopyId = () => {
    if (entityId) {
      navigator.clipboard.writeText(entityId);
      toast.success(
        t('sweep.entities.idCopiedToClipboard', {
          entityType: entityType || t('sweep.entities.entityFallback'),
        }),
      );
    }
  };

  return (
    <div className="bg-background">
      <div className="container mx-auto pb-[30px] max-w-[1200px]">
        {/* Header */}
        <div className="bg-background">
          <div className="pt-2 pb-4">
            <div className={`flex justify-between ${centerActions ? 'items-center' : 'items-start'}`}>
              <div className={`flex gap-3 ${centerActions ? 'items-center' : 'items-start'}`}>
                {showBackButton && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={onBack}
                    className="h-9 w-9 mt-0.5"
                  >
                    <ArrowLeft className="h-5 w-5" />
                  </Button>
                )}
                <div>
                  <div
                    className="flex items-center gap-3"
                    onMouseEnter={() => setIsHoveringTitle(true)}
                    onMouseLeave={() => setIsHoveringTitle(false)}
                  >
                    {avatar}
                    {IconProp && <IconProp className="h-6 w-6 text-muted-foreground" />}
                    <h1 className="text-3xl font-semibold tracking-tight">
                      {title || `${entityType} #${entityId}`}
                    </h1>
                    {badge}
                    {entityId && isHoveringTitle && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleCopyId}
                        className="h-7 w-7 -ml-1 mt-1"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                  {subtitle && (
                    <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* Quick Actions (icon only) */}
                {quickActions.map((action) => (
                  <Button
                    key={action.label}
                    variant={action.variant || "outline"}
                    size="icon"
                    className="h-8 w-8 shadow-none"
                    title={action.title || action.label}
                    onClick={action.onClick}
                    disabled={action.disabled}
                  >
                    <action.icon className="h-4 w-4" />
                  </Button>
                ))}

                {/* Primary Actions (with labels) */}
                {resolvedPrimaryActions.map((action) => (
                  <Button
                    key={action.label}
                    variant={action.variant || "default"}
                    onClick={action.onClick}
                    disabled={action.disabled}
                    className={`h-8 text-sm px-3 shadow-none ${action.iconPosition === "right" ? "flex items-center gap-1.5" : "flex items-center gap-1.5"}`}
                  >
                    {action.iconPosition === "right" ? (
                      <>
                        <span>{action.label}</span>
                        <action.icon className="h-4 w-4" />
                      </>
                    ) : (
                      <>
                        <action.icon className="h-4 w-4" />
                        <span>{action.label}</span>
                      </>
                    )}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Status Cards */}
        {(status || priority) && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-2">
            {status && (
              <div className="bg-white dark:bg-background rounded-md border border-gray-200 dark:border-border p-4">
                <p className="text-xs text-gray-500 dark:text-muted-foreground font-medium">
                  {t('sweep.entities.fieldStatus')}
                </p>
                <div className="flex items-center gap-2 mt-1">
                  {(() => {
                    const statusInfo = status.config[status.value];
                    if (!statusInfo) return null;
                    const Icon = statusInfo.icon;
                    return (
                      <Badge variant="outline" className={statusInfo.className}>
                        <Icon className="h-3 w-3 mr-1" />
                        <span>{statusInfo.label}</span>
                      </Badge>
                    );
                  })()}
                </div>
              </div>
            )}

            {priority && (
              <div className="bg-white dark:bg-background rounded-md border border-gray-200 dark:border-border p-4">
                <p className="text-xs text-gray-500 dark:text-muted-foreground font-medium">
                  {t('sweep.entities.fieldPriority')}
                </p>
                <div className="mt-1">
                  <Badge variant={priority.variant}>{priority.value}</Badge>
                </div>
              </div>
            )}

            {children}
          </div>
        )}
      </div>
    </div>
  );
}
