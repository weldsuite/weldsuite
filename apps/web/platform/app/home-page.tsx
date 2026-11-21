import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useUser } from '@/lib/auth';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { Link } from '@/lib/router';
import { BreadcrumbHeader } from '@/components/breadcrumb-header';
import { ModuleContent } from '@/components/layout/module-content';
import { AgentChatInput, AgentSuggestions } from '@/components/weldagent/agent-chat-input';
import { useI18n } from '@/lib/i18n/provider';
import { Settings2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { AppIcon } from '@/components/app-icon';
import { useUserPreferences } from '@/hooks/queries/use-settings-queries';
import { HOME_WIDGETS, emptySlots, isWidgetEnabled, type NullableSlot } from '@/lib/home-widgets/registry';
import type { HomeWidgetSlot, WidgetId } from '@/lib/home-widgets/types';
import { isFeatureAvailable, isModuleOffered } from '@/lib/edition';

function resolveHomeSlots(prefs: ReturnType<typeof useUserPreferences>['data']): [NullableSlot, NullableSlot] {
  const persisted = prefs?.uiPreferences?.homeWidgets?.slots;
  if (!persisted) return emptySlots();
  return persisted.map((slot) => {
    if (!slot) return null;
    const def = HOME_WIDGETS[slot.widgetId as WidgetId];
    // Edition flags (4.F3): a widget whose module this deployment doesn't serve stays empty,
    // and so does a coming-soon widget that was saved before it was disabled.
    if (!def || !isWidgetEnabled(def.id)) return null;
    const parsed = def.schema.safeParse(slot.settings);
    return {
      widgetId: slot.widgetId as WidgetId,
      settings: parsed.success ? parsed.data : def.defaultSettings,
    } as HomeWidgetSlot;
  }) as [NullableSlot, NullableSlot];
}

function HomeWidgetsArea() {
  const { t, format } = useI18n();
  const prefsQuery = useUserPreferences();
  const slots = resolveHomeSlots(prefsQuery.data);
  const filled = slots.filter((s): s is HomeWidgetSlot => s !== null);

  if (filled.length === 0) {
    return (
      <div className="flex min-h-[360px] flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/40 px-6 py-8 text-center">
        <h3 className="mb-1.5 text-[15px] font-semibold text-foreground">{t.weldsuiteHome.empty.title}</h3>
        <p className="mb-5 max-w-[340px] text-sm leading-relaxed text-muted-foreground">
          {t.weldsuiteHome.empty.description}
        </p>
        <Button asChild size="sm">
          <Link href="/settings/apps/weldsuite">{t.weldsuiteHome.empty.cta}</Link>
        </Button>
      </div>
    );
  }

  // Each widget is titled and links to its app; one control leads back to the widget settings (TASK-1427).
  return (
    <div className="flex flex-col gap-4">
      {filled.map((slot, i) => {
        const def = HOME_WIDGETS[slot.widgetId];
        if (!def) return null;
        const Render = def.HomeRender;
        const title = t.weldsuiteHome.widgets[slot.widgetId].title;
        // Every widget module but `analytics` is an app at `/<module>`. Not
        // `lib/apps/catalog`: it imports the master database client, which
        // can't be bundled for the browser.
        const appPath = def.module === 'analytics' ? undefined : `/${def.module}`;
        return (
          <section key={`${i}-${slot.widgetId}`} aria-label={title} className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <AppIcon icon={def.module} className="h-4 w-4 shrink-0" />
              {appPath ? (
                <Link
                  href={appPath}
                  title={format(t.weldsuiteHome.page.openApp, { app: t.weldsuiteHome.groups[def.module] })}
                  className="text-sm font-medium text-foreground hover:underline underline-offset-2"
                >
                  {title}
                </Link>
              ) : (
                <h2 className="text-sm font-medium text-foreground">{title}</h2>
              )}
              {i === 0 && (
                <Button asChild variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs text-muted-foreground">
                  <Link href="/settings/apps/weldsuite">
                    <Settings2 className="h-3.5 w-3.5" />
                    {t.weldsuiteHome.page.customizeWidgets}
                  </Link>
                </Button>
              )}
            </div>
            <Render settings={slot.settings as never} />
          </section>
        );
      })}
    </div>
  );
}

export default function HomePage() {
  const { t } = useI18n();
  const tp = t.weldsuiteHome.page;
  const { user } = useUser();
  const navigate = useNavigate();
  const router = useRouter();
  const firstName = user?.firstName || user?.fullName?.split(' ')[0] || tp.fallbackName;
  const greeting = (() => {
    const hour = new Date().getHours();
    if (hour < 12) return tp.greetingMorning;
    if (hour < 18) return tp.greetingAfternoon;
    return tp.greetingEvening;
  })();

  const [input, setInput] = useState('');
  // The suggestion buttons always sit just above the input. We size the
  // spacer between the widgets and the suggestions so that:
  //  - when everything fits, the suggestions are pinned in view (default look);
  //  - when it doesn't fit, the spacer pushes the suggestions to exactly the
  //    bottom fold, so they're hidden until a smooth scroll brings them up to
  //    rest cleanly above the input — never cut off or cramped.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const widgetsRef = useRef<HTMLDivElement | null>(null);
  const suggestionsRef = useRef<HTMLDivElement | null>(null);
  const suggestionsHeightRef = useRef(0);
  const [spacerHeight, setSpacerHeight] = useState(12);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const widgets = widgetsRef.current;
    if (!scroll || !widgets) return;

    const GAP = 12; // minimum gap between the widgets and the suggestions

    const recompute = () => {
      if (suggestionsRef.current) {
        suggestionsHeightRef.current = suggestionsRef.current.offsetHeight;
      }
      const styles = getComputedStyle(scroll);
      const padding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
      const available = scroll.clientHeight - padding;
      const widgetsH = widgets.offsetHeight;
      const suggestionsH = suggestionsHeightRef.current;
      const fits = widgetsH + GAP + suggestionsH <= available;
      // Pin in view when it fits; otherwise drop the suggestions to the fold.
      const next = fits ? available - widgetsH - suggestionsH : available - widgetsH;
      setSpacerHeight(Math.max(GAP, next));
    };

    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(scroll);
    ro.observe(widgets);
    return () => ro.disconnect();
  }, [input]);

  // Edition flags (4.F3): the agent composer needs the agent module and its AI.
  const agentOffered = isModuleOffered('agent') && isFeatureAvailable('assistant-ai');

  // Load the chat page's chunk up front so the handoff below never waits on it
  // (or flashes the route skeleton) mid-transition.
  useEffect(() => {
    if (!agentOffered) return;
    router.preloadRoute({ to: '/new-chat', search: { prompt: undefined, conversation: undefined } }).catch(() => {});
  }, [router, agentOffered]);

  const startNewChat = (prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    // View transition (off app-wide, see main.tsx) so the composer stays put
    // while the chat page fades in around it — see `.weldagent-composer-vt`.
    navigate({ to: '/new-chat', search: { prompt: trimmed, conversation: undefined }, viewTransition: true });
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden text-card-foreground">
      <BreadcrumbHeader
        segments={[
          { label: 'WeldSuite', href: '/' },
          { label: tp.breadcrumbHome, href: '/' },
        ]}
      />

      <ModuleContent className="flex flex-col overflow-hidden">
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 pt-6 pb-3 flex flex-col">
            <div ref={widgetsRef} className="w-full max-w-3xl mx-auto flex-shrink-0">
              <div className="mb-6">
                <h1 className="text-[29px] font-medium tracking-tight text-foreground">
                  {greeting}, {firstName}
                </h1>
              </div>

              <HomeWidgetsArea />
            </div>

            {/*
              Spacer between the widgets and the suggestions. Its height is
              computed so the suggestions are pinned in view on tall screens and
              pushed to the bottom fold on short ones (revealed by scrolling).
              flex-1 lets it grow to fill any extra space (e.g. while typing).
            */}
            <div className="flex-1" style={{ minHeight: spacerHeight }} />

            {agentOffered && !input.trim() && (
              <div ref={suggestionsRef} className="w-full max-w-3xl mx-auto flex-shrink-0">
                <AgentSuggestions onSelect={startNewChat} />
              </div>
            )}
          </div>

          {agentOffered && (
            <div className="flex-shrink-0 px-6 pb-6">
              <div className="w-full max-w-3xl mx-auto weldagent-composer-vt">
                <AgentChatInput value={input} onChange={setInput} onSubmit={startNewChat} autoFocus />
              </div>
            </div>
          )}
        </div>
      </ModuleContent>
    </div>
  );
}
