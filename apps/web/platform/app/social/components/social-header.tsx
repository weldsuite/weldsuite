import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { usePathname } from '@/lib/router';
import { BreadcrumbHeader, BreadcrumbSegment } from '@/components/breadcrumb-header';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { ComposerDialog } from './composer-dialog';

interface SocialHeaderProps {
  onWeldAgentToggle?: (isOpen: boolean) => void;
  onCalendarToggle?: (isOpen: boolean) => void;
  onNotificationsToggle?: (isOpen: boolean) => void;
}

export function SocialHeader({
  onWeldAgentToggle,
  onCalendarToggle,
  onNotificationsToggle,
}: SocialHeaderProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const pathname = usePathname();
  const [composeOpen, setComposeOpen] = useState(false);

  // Labels for the second breadcrumb segment, keyed by the route below /social.
  // Hardcoded English mirrors the sidebar labels in MODULE_CONFIGS.social.
  const routeLabels: Record<string, string> = {
    dashboard: t.social.dashboard.title,
    queue: st('sweep.miscA.socialHeader.queue'),
    calendar: t.social.calendar.title,
    drafts: t.social.posts.drafts,
    analytics: t.social.analytics.title,
    accounts: t.social.accounts.title,
    approvals: st('sweep.miscA.socialHeader.approvals'),
    campaigns: t.social.campaigns.title,
    team: t.social.team.title,
    settings: t.social.settings.title,
  };

  const segments: BreadcrumbSegment[] = useMemo(() => {
    const result: BreadcrumbSegment[] = [{ label: t.social.title, href: '/social' }];
    const parts = pathname.split('/').filter(Boolean);

    // /social index is the dashboard view — show it as a leaf segment.
    if (parts.length <= 1) {
      result.push({ label: t.social.dashboard.title });
      return result;
    }

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const href = '/' + parts.slice(0, i + 1).join('/');
      const label =
        routeLabels[part] ?? part.charAt(0).toUpperCase() + part.slice(1).replace(/-/g, ' ');
      result.push({ label, href });
    }

    return result;
  }, [pathname, t]);

  return (
    <>
      <BreadcrumbHeader
        segments={segments}
        showBackButton
        moduleKey="social"
        onWeldAgentToggle={onWeldAgentToggle}
        onCalendarToggle={onCalendarToggle}
        onNotificationsToggle={onNotificationsToggle}
        actions={
          <Button size="sm" onClick={() => setComposeOpen(true)}>
            <Plus className="h-4 w-4" />
            {t.social.posts.newPost}
          </Button>
        }
      />
      <ComposerDialog open={composeOpen} onOpenChange={setComposeOpen} />
    </>
  );
}
