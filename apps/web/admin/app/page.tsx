import Link from 'next/link';
import { ArrowRight, Headphones, Package } from 'lucide-react';
import { requireAdmin } from '@/lib/auth';
import { getAppStats } from '@/lib/apps-data';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const admin = await requireAdmin();
  const appStats = await getAppStats();

  const greetingName = admin.name?.split(' ')[0] || admin.email.split('@')[0];

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
  ];

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-5xl mx-auto p-8">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back, {greetingName}</h1>
        <p className="text-muted-foreground mt-1 mb-8">
          WeldSuite internal administration.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {cards.map((card) => (
            <Link
              key={card.href}
              href={card.href}
              className="group rounded-xl border bg-card p-6 hover:border-blue-500/50 hover:shadow-sm transition-all"
            >
              <div className="flex items-start justify-between">
                <div className="h-10 w-10 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                  <card.icon className="h-5 w-5 text-blue-600" />
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <h3 className="font-medium text-sm mt-4">{card.title}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">{card.description}</p>
              {card.stat && (
                <p className="text-xs font-medium text-foreground/80 mt-3 tabular-nums">{card.stat}</p>
              )}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
