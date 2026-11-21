/**
 * The helpdesk widget's install code per framework. With `widgetUrl` (a
 * deployment's own widget host, `/config.json`'s `helpdeskWidgetUrl`) each one
 * points the SDK at it; without, the SDK's default
 * (`https://widget.weldsuite.org`) applies and the code stays as short as before.
 * Vanilla, React and Vue pass it as `api.baseUrl`; the Svelte and Angular
 * components take `baseUrl`.
 */
export function installSnippets(widgetId: string, widgetUrl?: string) {
  const vanillaHost = widgetUrl ? `,\n    api: { baseUrl: '${widgetUrl}' }` : '';
  const reactHost = widgetUrl ? ` api={{ baseUrl: '${widgetUrl}' }}` : '';
  const vueHost = widgetUrl ? ` :api="{ baseUrl: '${widgetUrl}' }"` : '';
  const angularHost = widgetUrl ? ` [baseUrl]="'${widgetUrl}'"` : '';
  const svelteHost = widgetUrl ? ` baseUrl="${widgetUrl}"` : '';
  return {
    vanilla: `<!-- Load from CDN -->
<script src="https://unpkg.com/@weldsuite/helpdesk-widget-sdk@latest/dist/index.umd.js"></script>

<script>
  HelpdeskWidget.initHelpdeskWidget({
    widgetId: '${widgetId}'${vanillaHost}
  });
</script>`,
    react: `import { HelpdeskWidgetReact } from '@weldsuite/helpdesk-widget-sdk/react';

function App() {
  return (
    <>
      <h1>My App</h1>
      <HelpdeskWidgetReact widgetId="${widgetId}"${reactHost} />
    </>
  );
}`,
    vue: `<script setup>
import { HelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk/vue';
</script>

<template>
  <div>
    <h1>My App</h1>
    <HelpdeskWidget widget-id="${widgetId}"${vueHost} />
  </div>
</template>`,
    angular: `import { HelpdeskWidgetComponent } from '@weldsuite/helpdesk-widget-sdk/angular';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [HelpdeskWidgetComponent],
  template: \`
    <h1>My App</h1>
    <helpdesk-widget [widgetId]="'${widgetId}'"${angularHost}></helpdesk-widget>
  \`
})
export class AppComponent {}`,
    svelte: `<script>
  import { HelpdeskWidget } from '@weldsuite/helpdesk-widget-sdk/svelte';
</script>

<h1>My App</h1>
<HelpdeskWidget widgetId="${widgetId}"${svelteHost} />`,
  };
}
