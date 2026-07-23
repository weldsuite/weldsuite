
import { useState } from 'react';
import { Copy, Check, ChevronDown, ChevronRight, Code2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';

interface WidgetInstallationPanelProps {
  widgetId: string;
}

export function WidgetInstallationPanel({ widgetId }: WidgetInstallationPanelProps) {
  const t = useTranslations();
  const [copied, setCopied] = useState<string | null>(null);
  const [expandedFramework, setExpandedFramework] = useState<string | null>('vanilla');

  const copyToClipboard = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const toggleFramework = (framework: string) => {
    setExpandedFramework(expandedFramework === framework ? null : framework);
  };

  const CodeBlock = ({ code, copyKey }: { code: string; copyKey: string }) => (
    <div className="relative group">
      <pre className="bg-gray-50 dark:bg-background/50 border border-gray-200 dark:border-border rounded-lg p-3 overflow-x-auto text-xs font-mono">
        <code className="text-gray-900 dark:text-foreground">{code}</code>
      </pre>
      <Button
        variant="ghost"
        onClick={() => copyToClipboard(code, copyKey)}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-white dark:bg-secondary border border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-accent transition-colors opacity-0 group-hover:opacity-100"
        title={t('sweep.welddesk.widgetInstallation.copyCodeTitle')}
      >
        {copied === copyKey ? (
          <Check className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />
        ) : (
          <Copy className="w-3.5 h-3.5 text-gray-600 dark:text-muted-foreground" />
        )}
      </Button>
    </div>
  );

  const FrameworkSection = ({
    id,
    title,
    children
  }: {
    id: string;
    title: string;
    children: React.ReactNode
  }) => {
    const isExpanded = expandedFramework === id;

    return (
      <div className="border-b border-gray-200 dark:border-border last:border-0">
        <Button
          variant="ghost"
          onClick={() => toggleFramework(id)}
          className="w-full flex items-center justify-between px-3 py-3 hover:bg-gray-50 dark:hover:bg-background/30 transition-colors"
        >
          <span className="text-xs font-medium text-gray-900 dark:text-foreground">{title}</span>
          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-gray-500 dark:text-muted-foreground" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-gray-500 dark:text-muted-foreground" />
          )}
        </Button>
        {isExpanded && (
          <div className="px-3 pb-3 space-y-2">
            {children}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="border-t border-gray-200 dark:border-border mt-6 pt-6 -mx-3.5 px-3.5">
      <div className="flex items-center gap-2 mb-5">
        <div className="w-6 h-6 rounded-md flex items-center justify-center bg-gray-100 dark:bg-secondary">
          <Code2 className="w-3.5 h-3.5 text-gray-600 dark:text-muted-foreground" />
        </div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-foreground">{t('sweep.welddesk.widgetInstallation.installationTitle')}</h3>
      </div>

      {/* Widget ID */}
      <div className="mb-4">
        <label className="text-xs font-medium text-gray-700 dark:text-muted-foreground block mb-1.5">{t('sweep.welddesk.widgetInstallation.widgetIdLabel')}</label>
        <div className="relative">
          <input
            type="text"
            value={widgetId}
            readOnly
            className="w-full px-3 py-2 text-xs font-mono bg-gray-50 dark:bg-background/50 border border-gray-200 dark:border-border rounded-lg text-gray-900 dark:text-foreground pr-10"
          />
          <Button
            variant="ghost"
            onClick={() => copyToClipboard(widgetId, 'widgetId')}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-sm hover:bg-gray-200 dark:hover:bg-secondary transition-colors"
            title={t('sweep.welddesk.widgetInstallation.copyWidgetIdTitle')}
          >
            {copied === 'widgetId' ? (
              <Check className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />
            ) : (
              <Copy className="w-3.5 h-3.5 text-gray-600 dark:text-muted-foreground" />
            )}
          </Button>
        </div>
      </div>

      {/* Framework Instructions */}
      <div className="border border-gray-200 dark:border-border rounded-lg overflow-hidden">
        {/* Vanilla JavaScript */}
        <FrameworkSection id="vanilla" title="Vanilla JavaScript / HTML">
          <div className="space-y-2">
            <p className="text-xs text-gray-600 dark:text-muted-foreground">{t('sweep.welddesk.widgetInstallation.addToHtmlFile')}</p>
            <CodeBlock
              copyKey="vanilla"
              code={`<!-- Load from CDN -->
<script src="https://unpkg.com/@weldsuite/helpdesk-widget-sdk@latest/dist/index.umd.js"></script>

<script>
  HelpdeskWidget.initHelpdeskWidget({
    widgetId: '${widgetId}'
  });
</script>`}
            />
          </div>
        </FrameworkSection>

        {/* React */}
        <FrameworkSection id="react" title="React / Next.js">
          <div className="space-y-2">
            <p className="text-xs text-gray-600 dark:text-muted-foreground">{t('sweep.welddesk.widgetInstallation.installPackage')}</p>
            <CodeBlock
              copyKey="react-install"
              code={`npm install @weldsuite/helpdesk-widget-sdk`}
            />
            <p className="text-xs text-gray-600 dark:text-muted-foreground mt-3">{t('sweep.welddesk.widgetInstallation.useComponent')}</p>
            <CodeBlock
              copyKey="react-component"
              code={`import { HelpdeskWidgetReact } from '@weldsuite/helpdesk-widget-sdk/react';

function App() {
  return (
    <>
      <h1>My App</h1>
      <HelpdeskWidgetReact widgetId="${widgetId}" />
    </>
  );
}`}
            />
          </div>
        </FrameworkSection>

        {/* Vue */}
        <FrameworkSection id="vue" title="Vue 3">
          <div className="space-y-2">
            <p className="text-xs text-gray-600 dark:text-muted-foreground">{t('sweep.welddesk.widgetInstallation.installPackage')}</p>
            <CodeBlock
              copyKey="vue-install"
              code={`npm install @weldsuite/helpdesk-widget-sdk`}
            />
            <p className="text-xs text-gray-600 dark:text-muted-foreground mt-3">{t('sweep.welddesk.widgetInstallation.useComponent')}</p>
            <CodeBlock
              copyKey="vue-component"
              code={`<script setup>
import { HelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk/vue';
</script>

<template>
  <div>
    <h1>My App</h1>
    <HelpdeskWidget widget-id="${widgetId}" />
  </div>
</template>`}
            />
          </div>
        </FrameworkSection>

        {/* Angular */}
        <FrameworkSection id="angular" title="Angular">
          <div className="space-y-2">
            <p className="text-xs text-gray-600 dark:text-muted-foreground">{t('sweep.welddesk.widgetInstallation.installPackage')}</p>
            <CodeBlock
              copyKey="angular-install"
              code={`npm install @weldsuite/helpdesk-widget-sdk`}
            />
            <p className="text-xs text-gray-600 dark:text-muted-foreground mt-3">{t('sweep.welddesk.widgetInstallation.useComponent')}</p>
            <CodeBlock
              copyKey="angular-component"
              code={`import { HelpdeskWidgetComponent } from '@weldsuite/helpdesk-widget-sdk/angular';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [HelpdeskWidgetComponent],
  template: \`
    <h1>My App</h1>
    <helpdesk-widget [widgetId]="'${widgetId}'"></helpdesk-widget>
  \`
})
export class AppComponent {}`}
            />
          </div>
        </FrameworkSection>

        {/* Svelte */}
        <FrameworkSection id="svelte" title="Svelte">
          <div className="space-y-2">
            <p className="text-xs text-gray-600 dark:text-muted-foreground">{t('sweep.welddesk.widgetInstallation.installPackage')}</p>
            <CodeBlock
              copyKey="svelte-install"
              code={`npm install @weldsuite/helpdesk-widget-sdk`}
            />
            <p className="text-xs text-gray-600 dark:text-muted-foreground mt-3">{t('sweep.welddesk.widgetInstallation.useComponent')}</p>
            <CodeBlock
              copyKey="svelte-component"
              code={`<script>
  import { HelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk/svelte';
</script>

<h1>My App</h1>
<HelpdeskWidget widgetId="${widgetId}" />`}
            />
          </div>
        </FrameworkSection>
      </div>

      {/* Documentation Link */}
      <div className="mt-3">
        <a
          href="https://docs.weldsuite.org/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-gray-900 dark:text-foreground leading-relaxed hover:bg-gray-100 dark:hover:bg-secondary flex items-center justify-between px-3 py-2 border border-gray-200 dark:border-border rounded-md transition-colors"
        >
          {t('sweep.welddesk.widgetInstallation.viewFullDocumentation')}
          <ChevronRight className="w-3.5 h-3.5" />
        </a>
      </div>
    </div>
  );
}
