
import * as React from 'react';
import { Menu, Home } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { useMobileNav } from '@/contexts/mobile-nav-context';
import { cn } from '@/lib/utils';
import { useTheme } from '@/hooks/use-theme';

interface MobileHeaderProps {
  className?: string;
}

export function MobileHeader({ className }: MobileHeaderProps) {
  const t = useTranslations();
  const { isOpen, toggleOpen, moduleInfo, showWeldAgent, toggleWeldAgent, headerVariant } = useMobileNav();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const Icon = moduleInfo?.icon || Home;
  const name = moduleInfo?.name || 'WeldSuite';
  const logo = moduleInfo?.logo;
  const isGlass = headerVariant === 'glass';

  return (
    <header
      className={cn(
        // Drop below the sheet overlay (z-50) when the mobile menu is open so the
        // overlay's bg-black/50 dims the header the same as the rest of the page.
        'md:hidden fixed top-0 left-0 right-0 flex h-14 items-center gap-3 px-4',
        isOpen ? 'z-40' : 'z-[60]',
        isGlass
          ? 'bg-white/10 backdrop-blur-xl border-b border-white/10'
          : 'border-b bg-background',
        className
      )}
    >
      <Button
        variant="outline"
        size="icon"
        className={cn(
          "h-8 w-8",
          isGlass
            ? "bg-white/15 hover:bg-white/25 backdrop-blur-md border-white/20 text-white"
            : "border-gray-200 dark:border-border"
        )}
        onClick={toggleOpen}
        aria-label={t('sweep.shared.toggleNavigationMenu')}
      >
        <Menu className="h-4 w-4" />
      </Button>
      <div className={cn("flex items-center gap-2 flex-1", isGlass && "text-white")}>
        {logo ? (
          <img
            src={isDark || isGlass ? logo.textDark : logo.textLight}
            alt={name}
            width={80}
            height={20}
            className="h-5 w-auto"
          />
        ) : (
          <>
            {!moduleInfo?.hideIconOnMobile && <Icon className="h-5 w-5" />}
            <span className="font-semibold">{name}</span>
          </>
        )}
      </div>
      <Button
        onClick={toggleWeldAgent}
        variant={showWeldAgent ? "default" : "outline"}
        size="sm"
        className={cn(
          "gap-2 shadow-none",
          isGlass && !showWeldAgent && "bg-white/15 hover:bg-white/25 backdrop-blur-md border-white/20 text-white",
          showWeldAgent && "bg-primary text-primary-foreground hover:bg-primary/90"
        )}
      >
        <img
          src="/assets/images/weldagent/icon.svg"
          alt="WeldAgent"
          width={16}
          height={16}
          className="h-4 w-4"
        />
      </Button>
    </header>
  );
}
