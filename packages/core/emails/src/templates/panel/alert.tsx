/**
 * WeldPanel: an alert fired, resolved, or was tested. Sent to the members the
 * alert names; the same copy goes to Slack, WeldChat and in-app
 * (./monitor-text.ts).
 */

import { Actions, Button, Details, EmailLayout, Heading, Kicker, Paragraph } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';
import { alertConditionText, formatAlertPeriod, formatPanelValue, panelAlertText, type PanelAlertEmailProps } from './monitor-text';

export type { PanelAlertEmailProps } from './monitor-text';

export default defineTemplate<PanelAlertEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldPanel' },

  subject: (props, { locale }) => {
    const t = emailStrings(locale).panel.alert;
    const subject = { fired: t.subjectFired, resolved: t.subjectResolved, test: t.subjectTest }[props.event];
    return fill(subject, { alert: props.alertName });
  },

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).panel.alert;
    const text = panelAlertText(props, locale);
    const value = props.value === null ? null : formatPanelValue(props.value, 'number', locale);
    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={value === null ? text.title : fill(t.preview, { metric: props.metric, value })}
        footer={t.footer}
      >
        <Kicker>{fill(t.kicker, { project: props.projectName })}</Kicker>
        <Heading>{text.title}</Heading>
        <Paragraph>{text.body}</Paragraph>
        <Details
          rows={[
            { label: t.metric, value: props.metric },
            { label: t.value, value: value ?? '' },
            { label: t.limit, value: props.bound === null ? '' : formatPanelValue(props.bound, 'number', locale) },
            { label: t.period, value: formatAlertPeriod(props.period, props.interval, locale) },
            { label: t.condition, value: alertConditionText(props.condition, locale) },
            { label: t.checked, value: t.intervals[props.interval] },
          ]}
        />
        <Actions>
          <Button accent={accentOf(brand)} href={props.url}>
            {t.button}
          </Button>
        </Actions>
      </EmailLayout>
    );
  },

  previews: {
    fired: {
      props: {
        alertName: 'Signups dropped',
        projectName: 'Shop',
        event: 'fired',
        metric: 'Signed up',
        value: 42,
        bound: 100,
        condition: { type: 'threshold', operator: 'below', value: 100 },
        interval: 'daily',
        period: '2026-11-16',
        url: 'https://app.weldsuite.org/weldpanel/alerts?alert=pnal_1',
      },
    },
    resolved: {
      props: {
        alertName: 'Checkout errors',
        projectName: 'Shop',
        event: 'resolved',
        metric: '$exception',
        value: 3,
        bound: 18.5,
        condition: { type: 'anomaly', sensitivity: 'medium' },
        interval: 'hourly',
        period: '2026-11-16T10:00',
        url: 'https://app.weldsuite.org/weldpanel/alerts?alert=pnal_2',
      },
    },
    change: {
      props: {
        alertName: 'Weekly visitors',
        projectName: 'Docs',
        event: 'fired',
        metric: 'Pageviews',
        value: 12_400,
        bound: 9_600,
        condition: { type: 'change', direction: 'increase', percent: 25 },
        interval: 'weekly',
        period: '2026-11-09',
        url: 'https://app.weldsuite.org/weldpanel/alerts?alert=pnal_3',
      },
    },
    test: {
      props: {
        alertName: 'Signups dropped',
        projectName: 'Shop',
        event: 'test',
        metric: 'Signed up',
        value: null,
        bound: null,
        condition: { type: 'threshold', operator: 'above', value: 1000 },
        interval: 'daily',
        period: null,
        url: 'https://app.weldsuite.org/weldpanel/alerts?alert=pnal_1',
      },
    },
  },
});
