import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useRouter } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import {
  ChevronLeft,
  Loader2,
  CheckCircle,
  Globe,
  FileText,
  Mail,
  TrendingUp,
  Headphones,
  MessageSquare,
  CheckSquare,
  Server,
  Calculator,
  Layers,
  type LucideIcon,
} from 'lucide-react';

interface Resource {
  label: string;
  href: string;
  icon: LucideIcon;
}

interface IntegrationDetailLayoutProps {
  name: string;
  description: string;
  category: string;
  icon: React.ReactNode;
  connected: boolean;
  isLoading?: boolean;
  isWorking?: boolean;
  canManage?: boolean;
  connectLabel?: string;
  disconnectLabel?: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
  provider?: string;
  resources?: Resource[];
  overview: string;
  children?: React.ReactNode;
  backHref?: string;
  backLabel?: string;
}

function getCategoryIcon(category: string): LucideIcon {
  const c = category.toLowerCase();
  if (c.includes('sales') || c.includes('marketing') || c.includes('crm') || c.includes('commerce') || c === 'customers') return TrendingUp;
  if (c.includes('customer support') || c.includes('helpdesk') || (c.includes('support') && !c.includes('chat'))) return Headphones;
  if (c.includes('communication') || c.includes('mail') || c.includes('chat') || c.includes('meet') || c.includes('email')) return MessageSquare;
  if (c.includes('productivity') || c.includes('project') || c.includes('task') || c.includes('calendar') || c === 'work') return CheckSquare;
  if (c.includes('infrastructure') || c.includes('host') || c.includes('storage') || c.includes('drive') || c.includes('domain')) return Server;
  if (c.includes('finance') || c.includes('accounting') || c.includes('books') || c.includes('billing')) return Calculator;
  if (c.includes('developer') || c.includes('api') || c.includes('mcp')) return Server;
  return Layers;
}

export function IntegrationDetailLayout({
  name,
  description,
  category,
  icon,
  connected,
  isLoading,
  isWorking,
  canManage = true,
  connectLabel,
  disconnectLabel,
  onConnect,
  onDisconnect,
  provider = 'WeldSuite',
  resources = [],
  overview,
  children,
  backHref = '/settings/integrations',
  backLabel,
}: IntegrationDetailLayoutProps) {
  const t = useTranslations();
  const router = useRouter();
  const CategoryIcon = getCategoryIcon(category);
  const resolvedConnectLabel = connectLabel ?? t('sweep.settings.integrationConnectionCard.connect');
  const resolvedDisconnectLabel = disconnectLabel ?? t('sweep.settings.integrationConnectionCard.disconnect');
  const resolvedBackLabel = backLabel ?? t('sweep.settings.integrationDetailLayout.back');

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 pt-8 pb-[72px]">
        {/* Back Link */}
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push(backHref)}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-8"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          {resolvedBackLabel}
        </Button>

        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 rounded-xl bg-white dark:bg-background border border-gray-200 dark:border-border flex items-center justify-center shrink-0">
              {icon}
            </div>
            <div className="relative top-px">
              <div className="flex items-center gap-2 mb-0 leading-tight">
                <h1 className="text-2xl font-semibold text-foreground leading-tight">{name}</h1>
              </div>
              <p className="text-muted-foreground">{description}</p>
            </div>
          </div>

          {canManage ? (
            <Button
              variant={connected ? 'outline' : 'default'}
              disabled={isLoading || isWorking}
              className={connected ? 'hover:text-destructive' : ''}
              onClick={() => {
                if (connected) onDisconnect?.();
                else onConnect?.();
              }}
            >
              {isWorking || isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : connected ? (
                resolvedDisconnectLabel
              ) : (
                resolvedConnectLabel
              )}
            </Button>
          ) : connected ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
              <CheckCircle className="h-4 w-4" />
              {t('sweep.settings.integrationConnectionCard.connected')}
            </span>
          ) : null}
        </div>

        <hr className="border-border/70 mb-8" />

        {/* Two Column Layout */}
        <div className="flex gap-16">
          {/* Left Sidebar */}
          <div className="w-48 shrink-0">
            <div className="mb-6">
              <p className="text-xs text-muted-foreground mb-2">{t('sweep.settings.integrationDetailLayout.category')}</p>
              <div className="flex items-center gap-2">
                <CategoryIcon className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm text-foreground">{category}</span>
              </div>
            </div>

            <div className="mb-6">
              <p className="text-xs text-muted-foreground mb-2">{t('sweep.settings.integrationDetailLayout.builtBy')}</p>
              <div className="flex items-center gap-2">
                <img
                  src="/assets/images/weldsuite/logo-light.png"
                  alt="WeldSuite"
                  className="h-4 w-4 dark:hidden"
                />
                <img
                  src="/assets/images/weldsuite/logo-dark.png"
                  alt="WeldSuite"
                  className="h-4 w-4 hidden dark:block"
                />
                <span className="text-sm text-foreground">WeldSuite</span>
              </div>
            </div>

            {resources.length > 0 && (
              <div className="mb-6">
                <p className="text-xs text-muted-foreground mb-2">{t('sweep.settings.integrationDetailLayout.resources')}</p>
                <div className="space-y-2">
                  {resources.map(({ label, href, icon: Icon }) => (
                    <a
                      key={label}
                      href={href}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="flex items-center gap-2 text-sm text-foreground hover:text-primary transition-colors"
                    >
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      {label}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Main Content */}
          <div className="flex-1 min-w-0">
            <div className="mb-10">
              <h2 className="text-xl font-semibold text-foreground mb-4">{t('sweep.settings.integrationDetailLayout.overview')}</h2>
              <p className="text-muted-foreground leading-relaxed">{overview}</p>
            </div>

            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

;
