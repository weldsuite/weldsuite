/**
 * The chat visuals gallery (`/design/chat-visuals`, ADR AGENT-016): where the
 * WeldSuite team designs the charts, figures, tables and record cards the AI
 * shows in chat. Every example renders with the real components, live while
 * its spec is edited, in both themes and at the widths the chat has (the
 * WeldAgent panel, a page, a phone). Behind the `chat-visuals-gallery` flag;
 * always on in local development.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Palette } from 'lucide-react';
import { toast } from 'sonner';
import type { ChatVisual as ChatVisualSpec } from '@weldsuite/app-api-client/schemas/chat-visuals';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { BreadcrumbHeader } from '@/components/breadcrumb-header';
import { ModuleContent } from '@/components/layout/module-content';
import { ChatVisual, fill } from '@/components/weldagent/visuals/chat-visual';
import { ChatVisualActionsProvider } from '@/components/weldagent/visuals/visual-actions-context';
import { useFeatureFlagStatus } from '@/hooks/queries/use-feature-flags-queries';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { EXAMPLES, EXAMPLE_ORDER, type ExampleKey } from './examples';
import { readSpec, SpecEditor, specText } from './spec-editor';
import { ThemedFrame } from './themed-frame';
import { TryWithAi } from './try-with-ai';

/** The chat's widths: the WeldAgent side panel, the Ask AI page, a phone. */
const WIDTHS = { panel: 400, page: 720, phone: 375 } as const;
type WidthKey = keyof typeof WIDTHS | 'all';

/** On in local development; elsewhere what the flag says (`undefined` while it loads). */
function useGalleryEnabled(): boolean | undefined {
  const flag = useFeatureFlagStatus('chat-visuals-gallery');
  return import.meta.env.DEV ? true : flag;
}

function Gallery() {
  const t = getTranslations('common').ai.visuals.gallery;
  const [selected, setSelected] = useState<ExampleKey | null>('bar');
  const [text, setText] = useState(() => specText(EXAMPLES.bar));
  const [width, setWidth] = useState<WidthKey>('page');
  const [tab, setTab] = useState('gallery');
  const result = useMemo(() => readSpec(text), [text]);
  // While the JSON is mid-edit (invalid), the previews keep the last spec that worked.
  const lastGood = useRef<ChatVisualSpec>(EXAMPLES.bar);
  useEffect(() => {
    if (result.ok) lastGood.current = result.visual;
  }, [result]);
  const visual = result.ok ? result.visual : lastGood.current;

  const pick = (key: ExampleKey) => {
    setSelected(key);
    setText(specText(EXAMPLES[key]));
  };
  const open = (spec: ChatVisualSpec) => {
    setSelected(null);
    setText(specText(spec));
    setTab('gallery');
  };
  const widths = width === 'all' ? (['panel', 'page', 'phone'] as const) : [width];

  return (
    <Tabs value={tab} onValueChange={setTab} className="gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">{t.intro}</p>
        <TabsList>
          <TabsTrigger value="gallery">{t.tabs.gallery}</TabsTrigger>
          <TabsTrigger value="ai">{t.tabs.ai}</TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="gallery">
        <div className="grid gap-6 xl:grid-cols-[180px_minmax(0,1fr)_360px]">
          <nav aria-label={t.examplesTitle} className="space-y-1">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.examplesTitle}</p>
            <ul className="flex flex-wrap gap-1 xl:flex-col">
              {EXAMPLE_ORDER.map((key) => (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => pick(key)}
                    aria-current={selected === key ? 'true' : undefined}
                    className={cn(
                      'w-full rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent',
                      selected === key && 'bg-accent font-medium',
                    )}
                  >
                    {t.examples[key]}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div className="min-w-0 space-y-8">
            <section className="space-y-2">
              <div>
                <h2 className="text-sm font-medium">{t.interactive}</h2>
                <p className="text-xs text-muted-foreground">{t.interactiveHint}</p>
              </div>
              <div className="max-w-[720px]">
                <ChatVisualActionsProvider ask={(prompt) => toast(fill(t.wouldAsk, { prompt }))} lookUpRecords={false}>
                  <ChatVisual visual={visual} className="my-0" />
                </ChatVisualActionsProvider>
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium">{t.frames}</h2>
                <ToggleGroup
                  type="single"
                  size="sm"
                  variant="outline"
                  value={width}
                  onValueChange={(next) => next && setWidth(next as WidthKey)}
                  aria-label={t.width}
                >
                  {(['panel', 'page', 'phone', 'all'] as const).map((key) => (
                    <ToggleGroupItem key={key} value={key} className="px-3 text-xs">
                      {t.widths[key]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              <div className="space-y-4 overflow-x-auto pb-2">
                {widths.map((key) => (
                  <div key={key} className="flex gap-4">
                    {(['light', 'dark'] as const).map((theme) => (
                      <figure key={theme} className="space-y-1">
                        <figcaption className="text-xs text-muted-foreground">
                          {t[theme]} · {t.widths[key]} {WIDTHS[key]}px
                        </figcaption>
                        <ThemedFrame theme={theme} width={WIDTHS[key]} title={`${t[theme]} ${WIDTHS[key]}px`}>
                          <ChatVisualActionsProvider lookUpRecords={false}>
                            <ChatVisual visual={visual} className="my-0" />
                          </ChatVisualActionsProvider>
                        </ThemedFrame>
                      </figure>
                    ))}
                  </div>
                ))}
              </div>
            </section>
          </div>

          <SpecEditor text={text} onChange={setText} onReset={() => setText(specText(EXAMPLES[selected ?? 'bar']))} />
        </div>
      </TabsContent>

      <TabsContent value="ai">
        <TryWithAi onOpen={open} />
      </TabsContent>
    </Tabs>
  );
}

export default function ChatVisualsGalleryPage() {
  const t = getTranslations('common').ai.visuals.gallery;
  const enabled = useGalleryEnabled();

  let body;
  if (enabled === undefined) body = <PageLoader />;
  else if (enabled) body = <Gallery />;
  else body = <EmptyState icon={Palette} title={t.notAvailable} className="py-24" />;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <BreadcrumbHeader
        segments={[
          { label: 'WeldSuite', href: '/' },
          { label: t.breadcrumb, href: '/design/chat-visuals' },
          { label: t.title, href: '/design/chat-visuals' },
        ]}
      />
      <ModuleContent className="overflow-y-auto">
        <div className="mx-auto w-full max-w-[1600px] px-6 py-6">{body}</div>
      </ModuleContent>
    </div>
  );
}
