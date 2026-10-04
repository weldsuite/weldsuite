import { useLayoutEffect, useRef, useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { useNavigate } from '@tanstack/react-router';
import { Link } from '@/lib/router';
import { BreadcrumbHeader } from '@/components/breadcrumb-header';
import { ModuleContent } from '@/components/layout/module-content';
import { AgentChatInput, AgentSuggestions } from '@/components/weldagent/agent-chat-input';
import { useI18n } from '@/lib/i18n/provider';
import { Button } from '@weldsuite/ui/components/button';
import { useUserPreferences } from '@/hooks/queries/use-settings-queries';
import { HOME_WIDGETS, emptySlots, type NullableSlot } from '@/lib/home-widgets/registry';
import type { HomeWidgetSlot, WidgetId } from '@/lib/home-widgets/types';

function resolveHomeSlots(prefs: ReturnType<typeof useUserPreferences>['data']): [NullableSlot, NullableSlot] {
  const persisted = prefs?.uiPreferences?.homeWidgets?.slots;
  if (!persisted) return emptySlots();
  return persisted.map((slot) => {
    if (!slot) return null;
    const def = HOME_WIDGETS[slot.widgetId as WidgetId];
    if (!def) return null;
    const parsed = def.schema.safeParse(slot.settings);
    return {
      widgetId: slot.widgetId as WidgetId,
      settings: parsed.success ? parsed.data : def.defaultSettings,
    } as HomeWidgetSlot;
  }) as [NullableSlot, NullableSlot];
}

function HomeWidgetsArea() {
  const { t } = useI18n();
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

  return (
    <div className="flex flex-col gap-4">
      {filled.map((slot, i) => {
        const def = HOME_WIDGETS[slot.widgetId];
        if (!def) return null;
        const Render = def.HomeRender;
        return (
          <div key={`${i}-${slot.widgetId}`}>
            <Render settings={slot.settings as never} />
          </div>
        );
      })}
    </div>
  );
}

export default function HomePage() {
  const { user } = useUser();
  const navigate = useNavigate();
  const firstName = user?.firstName || user?.fullName?.split(' ')[0] || 'there';
  const greeting = (() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
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

  const startNewChat = (prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    navigate({ to: '/new-chat', search: { prompt: trimmed, conversation: undefined } });
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden text-card-foreground">
      <BreadcrumbHeader
        segments={[
          { label: 'WeldSuite', href: '/' },
          { label: 'Home', href: '/' },
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

            {!input.trim() && (
              <div ref={suggestionsRef} className="w-full max-w-3xl mx-auto flex-shrink-0">
                <AgentSuggestions onSelect={startNewChat} />
              </div>
            )}
          </div>

          <div className="flex-shrink-0 px-6 pb-6">
            <div className="w-full max-w-3xl mx-auto">
              <AgentChatInput value={input} onChange={setInput} onSubmit={startNewChat} autoFocus />
            </div>
          </div>
        </div>
      </ModuleContent>
    </div>
  );
}
