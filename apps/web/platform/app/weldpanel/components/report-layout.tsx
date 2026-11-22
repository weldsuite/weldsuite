/**
 * An analysis page (Insights, Funnels, Retention, …) in the platform's flat layout: the standard
 * toolbar row across the page (the report actions on the left, the period and other controls on
 * the right), then the report, scrolling under it. With `sidebar` the report's setup sits in a
 * 400px column at the right of the page (below `lg` it covers the report, opened from a button in
 * the row), the date range (`dateRange`) at its top. The page name is in the breadcrumb (render it
 * in `AnalyticsListPage`) and in a heading for screen readers.
 */

import { useState, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import type { PanelDateRange } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { EditorPanelBody, EditorPanelCloseButton, EditorSidePanel } from '@weldsuite/ui/components/editor-side-panel';
import { ListToolbar } from '@weldsuite/ui/components/list-toolbar';
import { useI18n } from '@/lib/i18n/provider';
import { DateRangePicker } from './date-range-picker';
import { LabeledField } from './labeled-field';

export interface ReportLayoutProps {
  /** The page name, for the screen-reader heading. */
  title: string;
  /** Save as report, Add to dashboard, Annotations: left of the row. */
  actions: ReactNode;
  /** Right of the row: the date range, and any other control of the whole report. */
  controls: ReactNode;
  /** The report's setup as a column at the right of the page, under its title. */
  sidebar?: { title: string; content: ReactNode };
  /** The report's period, at the top of the sidebar. */
  dateRange?: { value: PanelDateRange; onChange: (range: PanelDateRange) => void };
  children: ReactNode;
}

export function ReportLayout({ title, actions, controls, sidebar, dateRange, children }: Readonly<ReportLayoutProps>) {
  const { t } = useI18n();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarToggle = sidebar && (
    <Button type="button" size="sm" variant="outline" className="lg:hidden" onClick={() => setSidebarOpen(true)}>
      <SlidersHorizontal />
      {sidebar.title}
    </Button>
  );

  return (
    <div className="relative flex h-full overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 className="sr-only">{title}</h1>
        <ListToolbar
          leading={actions}
          actionButtons={
            <>
              {sidebarToggle}
              {controls}
            </>
          }
        />
        <div className="flex-1 overflow-y-auto">
          <div className="container mx-auto grid max-w-[1600px] gap-6 p-6">{children}</div>
        </div>
      </div>
      {sidebar && (
        <EditorSidePanel open={sidebarOpen} aria-label={sidebar.title}>
          <div className="flex h-[53px] shrink-0 items-center justify-between border-b px-4">
            <h2 className="text-sm font-semibold">{sidebar.title}</h2>
            <div className="lg:hidden">
              <EditorPanelCloseButton onClick={() => setSidebarOpen(false)} />
            </div>
          </div>
          <EditorPanelBody>
            {dateRange && (
              <LabeledField label={t.weldpanel.analytics.range.label}>
                <DateRangePicker value={dateRange.value} onChange={dateRange.onChange} className="h-9 w-full justify-start" />
              </LabeledField>
            )}
            {sidebar.content}
          </EditorPanelBody>
        </EditorSidePanel>
      )}
    </div>
  );
}
