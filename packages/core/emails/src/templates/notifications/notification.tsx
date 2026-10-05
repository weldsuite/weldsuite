/**
 * Email copy of an in-app notification (chat DM, mention, thread reply, missed
 * call, task assigned, agent run, …). One generic template: the notification
 * already carries its own title and body, the email only frames them.
 */

import {
  Actions,
  Button,
  EmailLayout,
  Heading,
  LinkFallback,
  MultilineText,
  Quote,
  TextLink,
} from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings } from '../../i18n';

export interface NotificationEmailProps {
  /** Notification title, used as heading and subject. */
  title: string;
  /** The message, quoted in a panel (a chat message, a comment, a task title). */
  body?: string | null;
  /** Deep link into the platform. */
  actionUrl?: string | null;
  /** Button text; defaults to "Open in WeldSuite". */
  actionLabel?: string | null;
  /** Link to the notification settings page. */
  settingsUrl?: string | null;
}

export default defineTemplate<NotificationEmailProps>({
  defaultBrand: { kind: 'weldsuite' },

  subject: (props) => props.title,

  Component: (props) => {
    const { locale, brand } = props;
    const accent = accentOf(brand);
    const t = emailStrings(locale).notifications;
    const body = props.body?.trim();

    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={body ? body.slice(0, 140) : props.title}
        footer={
          <>
            {t.footer}{props.settingsUrl ? ' · ' : null}
            {props.settingsUrl ? <TextLink href={props.settingsUrl} muted>{t.manage}</TextLink> : null}
          </>
        }
      >
        <Heading>{props.title}</Heading>
        {body ? (
          <Quote>
            <MultilineText text={body} />
          </Quote>
        ) : null}
        {props.actionUrl ? (
          <>
            <Actions>
              <Button accent={accent} href={props.actionUrl}>{props.actionLabel?.trim() || t.open}</Button>
            </Actions>
            <LinkFallback label={emailStrings(locale).layout.linkFallback} href={props.actionUrl} />
          </>
        ) : null}
      </EmailLayout>
    );
  },

  previews: {
    mention: {
      brand: { kind: 'weldsuite', module: 'WeldChat' },
      props: {
        title: 'Sanne mentioned you in #marketing',
        body: '@Tom can you check the copy for the October newsletter before Friday?',
        actionUrl: 'https://app.weldsuite.org/weldchat',
        settingsUrl: 'https://app.weldsuite.org/settings/notifications',
      },
    },
    taskAssigned: {
      brand: { kind: 'weldsuite', module: 'WeldFlow' },
      props: {
        title: 'Tom assigned you a task',
        body: 'Prepare Q4 budget review',
        actionUrl: 'https://app.weldsuite.org/weldflow/tasks/123',
        actionLabel: 'View task',
        settingsUrl: 'https://app.weldsuite.org/settings/notifications',
      },
    },
  },
});
