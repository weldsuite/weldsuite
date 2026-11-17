/**
 * Integrations tab, laid out as the App Store: a categories column on the
 * left and app cards on the right. WeldCRM, WeldDesk and WeldFlow run on
 * every response; their card opens the settings (field mapping, a test run)
 * in place, with a back arrow. WeldConnect and webhooks, which already have
 * the form response events, open a page that links to them.
 */

import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ShieldOff, Webhook } from 'lucide-react';
import { FORM_INTEGRATION_KINDS, type FormDetail, type FormIntegration, type FormIntegrationKind } from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';
import { useFormIntegrations } from '@/hooks/queries/use-weldforms-results-queries';
import { FormGate, FormTabFrame } from '../results/form-gate';
import { AppCardButton, CATEGORY_TITLE, IntegrationHeader, IntegrationLogo, IntegrationStatus } from './app-tile';
import { CrmCard } from './crm-card';
import { DeskCard } from './desk-card';
import { FlowCard } from './flow-card';

/** Every card on the tab: the integration kinds, and the two that live elsewhere. */
const APP_IDS = [...FORM_INTEGRATION_KINDS, 'connect', 'webhooks'] as const;
type AppId = (typeof APP_IDS)[number];

/** The app each card belongs to, for its logo. */
const APP_CODES: Record<Exclude<AppId, 'webhooks'>, string> = { crm: 'weldcrm', desk: 'welddesk', flow: 'weldflow', connect: 'weldconnect' };

/** The App Store's categories the cards fall in, in its order. */
const CATEGORIES: ReadonlyArray<{ id: 'customers' | 'work' | 'developers'; apps: readonly AppId[] }> = [
  { id: 'customers', apps: ['crm', 'desk'] },
  { id: 'work', apps: ['flow', 'connect'] },
  { id: 'developers', apps: ['webhooks'] },
];

const LINKS: Record<'connect' | 'webhooks', string> = { connect: '/weldconnect', webhooks: '/settings/webhooks' };

function isKind(app: AppId): app is FormIntegrationKind {
  return (FORM_INTEGRATION_KINDS as readonly string[]).includes(app);
}

function AppLogo({ app }: Readonly<{ app: AppId }>) {
  return app === 'webhooks' ? <IntegrationLogo icon={Webhook} /> : <IntegrationLogo code={APP_CODES[app]} />;
}

export default function IntegrationsTabPage() {
  const { formId = '' } = useParams({ strict: false });
  return <FormGate formId={formId}>{(form) => <IntegrationsContent key={form.id} form={form} />}</FormGate>;
}

function IntegrationsContent({ form }: Readonly<{ form: FormDetail }>) {
  const { t } = useI18n();
  const ti = t.weldformsResults.integrations;
  const query = useFormIntegrations(form.id);
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const open = APP_IDS.find((app) => app === search.app) ?? null;

  const openApp = (app: AppId | null) =>
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const next = { ...prev };
        delete next.app;
        if (app) next.app = app;
        return next;
      },
    });

  if (!form.permissions.edit) {
    return (
      <FormTabFrame>
        <EmptyState icon={ShieldOff} title={ti.noAccessTitle} description={ti.noAccessDescription} />
      </FormTabFrame>
    );
  }
  if (query.isLoading) return <PageLoader fullScreen={false} />;
  if (query.error || !query.data) {
    return (
      <FormTabFrame>
        <ErrorState message={t.weldformsResults.common.loadFailed} onRetry={() => void query.refetch()} />
      </FormTabFrame>
    );
  }

  const byKind = (kind: FormIntegrationKind): FormIntegration | null => query.data.find((integration) => integration.kind === kind) ?? null;
  const info: Record<AppId, { name: string; subtitle: string; description: string }> = {
    crm: { name: ti.crm.title, subtitle: ti.crm.creates, description: ti.crm.description },
    desk: { name: ti.desk.title, subtitle: ti.desk.creates, description: ti.desk.description },
    flow: { name: ti.flow.title, subtitle: ti.flow.creates, description: ti.flow.description },
    connect: { name: ti.connect.title, subtitle: ti.connect.creates, description: ti.connect.description },
    webhooks: { name: ti.webhooks.title, subtitle: ti.webhooks.creates, description: ti.webhooks.description },
  };
  const categoryLabel = { customers: t.navigation.appstore.categoryCustomers, work: t.navigation.appstore.categoryWork, developers: ti.categoryDevelopers };

  if (open && isKind(open)) {
    const integration = byKind(open);
    // Keyed by what was saved, so the form state restarts from the saved config after a save.
    const key = `${open}-${integration?.id}-${integration?.updatedAt}`;
    const props = { form, integration, onBack: () => openApp(null) };
    return (
      <FormTabFrame narrow>
        {open === 'crm' && <CrmCard key={key} {...props} />}
        {open === 'desk' && <DeskCard key={key} {...props} />}
        {open === 'flow' && <FlowCard key={key} {...props} />}
      </FormTabFrame>
    );
  }
  if (open === 'connect' || open === 'webhooks') {
    return (
      <FormTabFrame narrow>
        <IntegrationHeader logo={<AppLogo app={open} />} title={info[open].name} description={info[open].description} onBack={() => openApp(null)}>
          <Button asChild variant="outline">
            <Link href={LINKS[open]}>{ti[open].open}</Link>
          </Button>
        </IntegrationHeader>
      </FormTabFrame>
    );
  }

  const scrollToCategory = (id: string) => document.getElementById(`integrations-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="relative flex h-full justify-center overflow-y-auto">
      {/* As tall as the cards (at least the tab), so the categories column and its divider run to the bottom. */}
      <div className="relative flex min-h-full w-full max-w-[1150px] self-start">
        <nav className="hidden border-r border-border py-6 md:flex md:w-60 md:shrink-0 md:flex-col md:pl-8" aria-label={t.navigation.appstore.categories}>
          <div className="sticky top-6 w-full self-start">
            <h2 className={cn(CATEGORY_TITLE, 'mb-4')}>{t.navigation.appstore.categories}</h2>
            <div className="flex flex-col gap-1">
              {CATEGORIES.map((category) => (
                <Button
                  key={category.id}
                  variant="ghost"
                  onClick={() => scrollToCategory(category.id)}
                  className="-ml-3 mr-3 cursor-pointer justify-start rounded-lg border-none px-3 py-2 text-left text-sm font-normal text-muted-foreground transition-all hover:bg-accent hover:text-foreground"
                >
                  {categoryLabel[category.id]}
                </Button>
              ))}
            </div>
          </div>
        </nav>

        <div className="min-w-0 flex-1 p-4 md:p-6 md:pl-8">
          {CATEGORIES.map((category, index) => (
            <section key={category.id} id={`integrations-${category.id}`} className="scroll-mt-6" aria-labelledby={`integrations-${category.id}-title`}>
              {index > 0 && <div className="my-8 border-t border-dashed border-border" />}
              <h3 id={`integrations-${category.id}-title`} className={cn(CATEGORY_TITLE, 'mb-4')}>
                {categoryLabel[category.id]}
              </h3>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {category.apps.map((app) => (
                  <AppCardButton
                    key={app}
                    logo={<AppLogo app={app} />}
                    name={info[app].name}
                    subtitle={info[app].subtitle}
                    description={info[app].description}
                    badge={isKind(app) ? <IntegrationStatus integration={byKind(app)} /> : undefined}
                    onClick={() => openApp(app)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
