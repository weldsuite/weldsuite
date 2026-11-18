/**
 * WeldPanel scheduled report: a saved report (its headline numbers with the
 * change against the period before, and its top rows) or a dashboard (one
 * block per report tile, at most 12). Numbers arrive raw; the copy and the
 * formatting are shared with Slack, WeldChat and in-app (./monitor-text.ts).
 */

import { Fragment } from 'react';
import { Actions, Button, Details, EmailLayout, Heading, Kicker, List, Paragraph, Strong, TextLink } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';
import { formatPanelChange, formatPanelValue, type PanelReportDigestEmailProps } from './monitor-text';

export type { PanelDigestBlock, PanelDigestFigure, PanelDigestRow, PanelReportDigestEmailProps } from './monitor-text';

export default defineTemplate<PanelReportDigestEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldPanel' },

  subject: (props, { locale }) => fill(emailStrings(locale).panel.reportDigest.subject, { name: props.subscriptionName, target: props.targetName }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).panel.reportDigest;
    const dashboard = props.targetType === 'dashboard';
    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={fill(t.preview, { target: props.targetName })}
        footer={fill(t.footer, { name: props.subscriptionName })}
      >
        <Kicker>{fill(t.kicker, { project: props.projectName })}</Kicker>
        <Heading>{props.targetName}</Heading>
        <Paragraph>{dashboard ? t.introDashboard : t.introReport}</Paragraph>
        {props.blocks.map((block, index) => {
          const empty = block.headline.length === 0 && block.rows.length === 0;
          const title = <Strong>{block.title}</Strong>;
          return (
            <Fragment key={index}>
              {dashboard ? <Paragraph>{block.url ? <TextLink href={block.url}>{title}</TextLink> : title}</Paragraph> : null}
              {block.failed ? <Paragraph muted>{t.failed}</Paragraph> : null}
              {!block.failed && block.openOnly ? <Paragraph muted>{t.openToSee}</Paragraph> : null}
              {!block.failed && !block.openOnly && empty ? <Paragraph muted>{t.noData}</Paragraph> : null}
              <Details
                rows={block.headline.map((figure) => {
                  const change = formatPanelChange(figure, locale);
                  const value = formatPanelValue(figure.value, figure.format, locale);
                  return { label: figure.label, value: change ? `${value} · ${change}` : value };
                })}
              />
              <List
                title={dashboard ? '' : block.title}
                items={block.rows.map((row) => ({ primary: row.label, aside: formatPanelValue(row.value, row.format, locale) }))}
              />
            </Fragment>
          );
        })}
        {props.moreCount ? <Paragraph muted>{fill(t.more, { count: props.moreCount })}</Paragraph> : null}
        <Actions>
          <Button accent={accentOf(brand)} href={props.url}>
            {t.button}
          </Button>
        </Actions>
      </EmailLayout>
    );
  },

  previews: {
    report: {
      props: {
        subscriptionName: 'Monday traffic',
        projectName: 'Shop',
        targetType: 'report',
        targetName: 'Website overview',
        blocks: [
          {
            title: 'Top pages',
            headline: [
              { label: 'Visitors', value: 12_840, previous: 11_020, format: 'number' },
              { label: 'Pageviews', value: 40_112, previous: 40_112, format: 'number' },
              { label: 'Bounce rate', value: 0.412, previous: 0.455, format: 'percent' },
            ],
            rows: [
              { label: '/', value: 9_120, format: 'number' },
              { label: '/pricing', value: 3_310, format: 'number' },
              { label: '/blog/launch', value: 1_204, format: 'number' },
            ],
          },
        ],
        url: 'https://app.weldsuite.org/weldpanel?report=pnr_1',
      },
    },
    dashboard: {
      props: {
        subscriptionName: 'Weekly product health',
        projectName: 'App',
        targetType: 'dashboard',
        targetName: 'Product health',
        blocks: [
          {
            title: 'Signups',
            headline: [{ label: 'Signed up', value: 312, previous: 0, format: 'number' }],
            rows: [],
            url: 'https://app.weldsuite.org/weldpanel/insights?report=pnr_2',
          },
          {
            title: 'Checkout funnel',
            headline: [{ label: 'Conversion', value: 0.231, previous: null, format: 'percent' }],
            rows: [
              { label: 'Viewed cart', value: 1_200, format: 'number' },
              { label: 'Paid', value: 277, format: 'number' },
            ],
            url: 'https://app.weldsuite.org/weldpanel/funnels?report=pnr_3',
          },
          { title: 'Retention', headline: [], rows: [], failed: true, url: null },
          { title: 'Paths', headline: [], rows: [] },
          { title: 'Web vitals', headline: [], rows: [], openOnly: true, url: 'https://app.weldsuite.org/weldpanel/insights?report=pnr_4' },
        ],
        moreCount: 2,
        url: 'https://app.weldsuite.org/weldpanel/dashboards/pnd_1',
      },
    },
  },
});
