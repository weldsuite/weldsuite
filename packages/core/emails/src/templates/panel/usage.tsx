/** WeldPanel: the workspace's events or recordings are near, at or over the plan allowance, or data is being dropped. Sent to workspace owners. */

import { Actions, Button, Details, EmailLayout, Heading, Kicker, Paragraph } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { formatDate } from '../../format';
import { emailStrings, fill } from '../../i18n';

export type PanelUsageEmailKind = 'near' | 'full' | 'replay_blocked' | 'events_blocked';

export interface PanelUsageEmailProps {
  workspaceName: string;
  /** `near`: 80% of an allowance. `full`: 100%. The blocked kinds: the wallet cannot pay and data is being dropped. */
  kind: PanelUsageEmailKind;
  events: { used: number; allowance: number };
  recordings: { used: number; allowance: number };
  /** ISO time the month's count starts again (start of next month, UTC). */
  resetsAt: string;
  /** Where the usage is shown. */
  url: string;
}

export default defineTemplate<PanelUsageEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldPanel' },

  subject: (props, { locale }) => {
    const t = emailStrings(locale).panel.usage;
    const subject = {
      near: t.subjectNear,
      full: t.subjectFull,
      replay_blocked: t.subjectReplayBlocked,
      events_blocked: t.subjectEventsBlocked,
    }[props.kind];
    return fill(subject, { workspace: props.workspaceName });
  },

  Component: (props) => {
    const { locale, brand, kind } = props;
    const t = emailStrings(locale).panel.usage;
    const number = new Intl.NumberFormat(locale);
    const blocked = kind === 'replay_blocked' || kind === 'events_blocked';
    const heading = { near: t.headingNear, full: t.headingFull, replay_blocked: t.headingReplayBlocked, events_blocked: t.headingEventsBlocked }[kind];
    const body = { near: t.bodyNear, full: t.bodyFull, replay_blocked: t.bodyReplayBlocked, events_blocked: t.bodyEventsBlocked }[kind];
    const previewTemplate = kind === 'full' ? t.previewFull : t.previewNear;
    const preview = blocked
      ? t.previewBlocked
      : fill(previewTemplate, { events: number.format(props.events.used), recordings: number.format(props.recordings.used) });
    const amount = (m: { used: number; allowance: number }) => fill(t.amount, { used: number.format(m.used), allowance: number.format(m.allowance) });
    return (
      <EmailLayout brand={brand} locale={locale} preview={preview} footer={t.footer}>
        <Kicker>{t.kicker}</Kicker>
        <Heading>{heading}</Heading>
        <Paragraph>{body}</Paragraph>
        <Details
          rows={[
            { label: t.events, value: amount(props.events) },
            { label: t.recordings, value: amount(props.recordings) },
          ]}
        />
        <Paragraph muted>{fill(t.resets, { date: formatDate(props.resetsAt, locale, 'UTC') })}</Paragraph>
        <Actions>
          <Button accent={accentOf(brand)} href={props.url}>
            {t.button}
          </Button>
        </Actions>
      </EmailLayout>
    );
  },

  previews: {
    near: {
      props: {
        workspaceName: 'Acme Staffing',
        kind: 'near',
        events: { used: 40_000, allowance: 50_000 },
        recordings: { used: 120, allowance: 500 },
        resetsAt: '2026-12-01T00:00:00.000Z',
        url: 'https://app.weldsuite.org/weldpanel/settings',
      },
    },
    full: {
      props: {
        workspaceName: 'Acme Staffing',
        kind: 'full',
        events: { used: 50_200, allowance: 50_000 },
        recordings: { used: 310, allowance: 500 },
        resetsAt: '2026-12-01T00:00:00.000Z',
        url: 'https://app.weldsuite.org/weldpanel/settings',
      },
    },
    replayBlocked: {
      props: {
        workspaceName: 'Acme Staffing',
        kind: 'replay_blocked',
        events: { used: 52_000, allowance: 50_000 },
        recordings: { used: 640, allowance: 500 },
        resetsAt: '2026-12-01T00:00:00.000Z',
        url: 'https://app.weldsuite.org/weldpanel/settings',
      },
    },
    eventsBlocked: {
      props: {
        workspaceName: 'Acme Staffing',
        kind: 'events_blocked',
        events: { used: 55_000, allowance: 50_000 },
        recordings: { used: 640, allowance: 500 },
        resetsAt: '2026-12-01T00:00:00.000Z',
        url: 'https://app.weldsuite.org/weldpanel/settings',
      },
    },
  },
});
