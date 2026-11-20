import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { parseRuntimeConfig, setRuntimeConfig } from '@/lib/runtime-config';
import { WidgetInstallationPanel } from './widget-installation-panel';

vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));

afterEach(() => setRuntimeConfig(null));

/** The snippet in the open (vanilla) section. */
const vanillaSnippet = () => screen.getByText(/initHelpdeskWidget/).textContent ?? '';

describe('WidgetInstallationPanel', () => {
  it("names the deployment's own widget host in the install code", () => {
    setRuntimeConfig(parseRuntimeConfig({ backend: 'rust', helpdeskWidgetUrl: 'https://widget.example.eu' }));
    render(<WidgetInstallationPanel widgetId="wgt_1" />);

    expect(vanillaSnippet()).toContain("widgetId: 'wgt_1'");
    expect(vanillaSnippet()).toContain("api: { baseUrl: 'https://widget.example.eu' }");
  });

  it("leaves the SDK's default host on Global", () => {
    render(<WidgetInstallationPanel widgetId="wgt_1" />);

    expect(vanillaSnippet()).toContain("widgetId: 'wgt_1'");
    expect(vanillaSnippet()).not.toContain('baseUrl');
  });
});
