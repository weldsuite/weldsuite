import { describe, expect, it } from 'vitest';
import { installSnippets } from './install-snippets';

describe('installSnippets', () => {
  it('names only the widget on Global, where the SDK default host is right', () => {
    const snippet = installSnippets('widget_1');
    for (const code of Object.values(snippet)) {
      expect(code).toContain('widget_1');
      expect(code).not.toContain('baseUrl');
    }
    expect(snippet.vanilla).toContain("widgetId: 'widget_1'\n  });");
  });

  it("points every framework at the deployment's own widget host", () => {
    const snippet = installSnippets('widget_1', 'https://widget.weldsuite.eu');
    expect(snippet.vanilla).toContain("widgetId: 'widget_1',\n    api: { baseUrl: 'https://widget.weldsuite.eu' }");
    expect(snippet.react).toContain(`<HelpdeskWidgetReact widgetId="widget_1" api={{ baseUrl: 'https://widget.weldsuite.eu' }} />`);
    expect(snippet.vue).toContain(`<HelpdeskWidget widget-id="widget_1" :api="{ baseUrl: 'https://widget.weldsuite.eu' }" />`);
    expect(snippet.angular).toContain(`[widgetId]="'widget_1'" [baseUrl]="'https://widget.weldsuite.eu'"`);
    expect(snippet.svelte).toContain('<HelpdeskWidget widgetId="widget_1" baseUrl="https://widget.weldsuite.eu" />');
  });
});
