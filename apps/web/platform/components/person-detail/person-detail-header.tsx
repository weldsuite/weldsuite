
import { useRouter } from '@/lib/router';
import { ChevronLeft, ChevronDown } from 'lucide-react';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useTranslations } from '@weldsuite/i18n/client';

export interface PersonDetailHeaderProps {
  /** Display name/title */
  name: string;
  /** Avatar initials or image URL */
  avatar: string;
  /** Back button URL */
  backUrl: string;
  /** Back button label */
  backLabel?: string;
  /** Primary action button */
  primaryAction?: {
    label: string;
    icon?: ReactNode;
    onClick?: () => void;
    href?: string;
  };
  /** Dropdown menu items */
  dropdownItems?: ReactNode;
  /** Additional action buttons */
  additionalActions?: ReactNode;
  /** Custom class name for the header row */
  className?: string;
}

export function PersonDetailHeader({
  name,
  avatar,
  backUrl,
  backLabel,
  primaryAction,
  dropdownItems,
  additionalActions,
  className,
}: PersonDetailHeaderProps) {
  const t = useTranslations();
  const router = useRouter();
  const resolvedBackLabel = backLabel ?? t('sweep.weldcrm.customerDetailView.back');

  return (
    <>
      {/* Back link */}
      <div className="mb-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 -ml-3"
          onClick={() => router.push(backUrl)}
        >
          <ChevronLeft className="h-4 w-4 mr-0.5" />
          <span className="hidden sm:inline">{resolvedBackLabel}</span>
          <span className="sm:hidden">{t('sweep.weldcrm.customerDetailView.back')}</span>
        </Button>
      </div>

      {/* Header */}
      <div className="bg-background">
        <div className="container mx-auto pb-4 md:pb-[30px] max-w-7xl">
          <div className={cn("py-2 md:py-4", className)}>
            <div className="flex flex-row justify-between items-center gap-3">
              <div className="flex gap-3 items-center min-w-0">
                <Avatar className="h-9 w-9 md:h-11 md:w-11 rounded-lg flex-shrink-0">
                  <AvatarFallback className="bg-primary/10 text-primary text-xs md:text-sm font-semibold rounded-lg">
                    {avatar}
                  </AvatarFallback>
                </Avatar>
                <h1 className="text-xl md:text-3xl font-semibold tracking-tight truncate">
                  #{name}
                </h1>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {dropdownItems && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="h-8 text-sm px-3 shadow-none flex items-center gap-1.5">
                        <span>{t('sweep.weldcrm.personDetailHeader.more')}</span>
                        <ChevronDown className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {dropdownItems}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {additionalActions}
                {primaryAction && (
                  <Button
                    className="h-8 text-sm px-3 shadow-none flex items-center gap-1.5"
                    onClick={primaryAction.onClick || (primaryAction.href ? () => window.location.href = primaryAction.href! : undefined)}
                  >
                    {primaryAction.icon}
                    <span className="hidden sm:inline">{primaryAction.label}</span>
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
