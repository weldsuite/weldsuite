import Link from 'next/link';
import { ArrowRight, Building2, Coins, Globe, Headphones, Package } from 'lucide-react';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { requireAdmin } from '@/lib/auth';
import { getAppStats } from '@/lib/apps-data';
import { adminPricingCopy } from '@/lib/i18n';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const admin = await requireAdmin();
  const appStats = await getAppStats();

  const greetingName = admin.name?.split(' ')[0] || admin.email.split('@')[0];
  const pricing = adminPricingCopy();

  const cards = [
    {
      href: '/support',
      icon: Headphones,
      title: 'Support Inbox',
      description: 'Enterprise support channels',
      stat: null as string | null,
    },
    {
      href: '/apps',
      icon: Package,
      title: 'App Catalog',
      description: 'Apps shown in the App Store',
      stat: `${appStats.published} published · ${appStats.total} total`,
    },
    {
      href: '/workspaces',
      icon: Building2,
      title: 'Workspaces',
      description: 'Tenants, members and deletion schedules',
      stat: null as string | null,
    },
    {
      href: '/ai-costs',
      icon: Coins,
      title: 'AI Costs',
      description: 'Gateway spend versus what we billed',
      stat: null as string | null,
    },
    {
      href: '/domain-pricing',
      icon: Globe,
      title: pricing.cardTitle,
      description: pricing.cardDescription,
      stat: null as string | null,
    },
  ];

  return (
    <PageContent>
      <PageBody className="space-y-8">
        <PageHeading
          title={`Welcome back, ${greetingName}`}
          description="WeldSuite internal administration."
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => (
            <Link key={card.href} href={card.href} className="group">
              <Card className="h-full py-6 transition-all hover:border-primary/50 hover:shadow-sm">
                <CardContent className="px-6">
                  <div className="flex items-start justify-between">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                      <card.icon className="h-5 w-5 text-primary" />
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                  <h3 className="mt-4 text-sm font-medium">{card.title}</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">{card.description}</p>
                  {card.stat && (
                    <p className="mt-3 text-xs font-medium tabular-nums text-foreground/80">
                      {card.stat}
                    </p>
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </PageBody>
    </PageContent>
  );
}
