import { useAppAccess } from '@/hooks/use-app-access';
import { PageLoader } from '@/components/page-loader';
import { Link } from '@/lib/router';
import { usePathname } from '@/lib/router';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';
import { ModuleContent } from '@/components/layout/module-content';

export default function WeldStashLayout({ children }: { children: React.ReactNode }) {
  const t = getTranslations('common');
  const { isInstalled, isLoading } = useAppAccess('weldstash');
  const pathname = usePathname();

  const tabs = [
    { href: '/weldstash', label: t.weldstash.tabs.overview, match: (p: string) => p === '/weldstash' },
    { href: '/weldstash/products', label: t.weldstash.tabs.products, match: (p: string) => p.startsWith('/weldstash/products') },
    { href: '/weldstash/suppliers', label: t.weldstash.tabs.suppliers, match: (p: string) => p.startsWith('/weldstash/suppliers') },
    { href: '/weldstash/warehouses', label: t.weldstash.tabs.warehouses, match: (p: string) => p.startsWith('/weldstash/warehouses') },
    { href: '/weldstash/stock', label: t.weldstash.tabs.stock, match: (p: string) => p.startsWith('/weldstash/stock') },
  ];

  if (isLoading) return <PageLoader />;
  if (!isInstalled) {
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        {t.weldstash.notInstalled}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <header className="border-b bg-background">
        <div className="container mx-auto max-w-[1600px] px-6 pt-5">
          <h1 className="text-2xl font-semibold">{t.weldstash.appTitle}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t.weldstash.appSubtitle}</p>
          <nav className="flex gap-1 mt-4 -mb-px">
            {tabs.map((tab) => {
              const isActive = tab.match(pathname);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className={cn(
                    'px-3 py-2 text-sm border-b-2 transition-colors',
                    isActive
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  {tab.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <ModuleContent className="overflow-auto">{children}</ModuleContent>
    </div>
  );
}
