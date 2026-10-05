/**
 * Strings of the system emails rendered by `@weldsuite/emails`.
 *
 * Not part of the `en` bundle the apps load: only the email renderer imports
 * this file (`@weldsuite/i18n/locales/en/emails`), so mail copy never ships to
 * the browser. `{name}` placeholders are filled by the renderer.
 */
export const emails = {
  layout: {
    sentVia: 'Sent via {product}',
    linkFallback: 'Or open this link:',
  },
  dates: {
    allDay: '{date} (all day)',
  },
  calendar: {
    subject: {
      invite: 'Invitation: {title}',
      update: 'Updated: {title}',
      reschedule: 'Rescheduled: {title}',
      cancel: 'Cancelled: {title}',
      removed: 'You were removed from: {title}',
    },
    preview: {
      invite: '{organizer} invited you to {title}',
      update: '{organizer} updated {title}',
      reschedule: '{organizer} moved {title} to a new time',
      cancel: '{organizer} cancelled {title}',
      removed: '{organizer} removed you from {title}',
    },
    intro: {
      invite: '{organizer} invited you to an event.',
      update: '{organizer} updated an event.',
      reschedule: '{organizer} moved an event to a new time.',
      cancel: '{organizer} cancelled an event.',
      removed: '{organizer} removed you from an event.',
    },
    when: 'When',
    where: 'Where',
    joinWeldMeet: 'Join WeldMeet meeting',
    joinVideo: 'Join video meeting',
    viewInCalendar: 'View in WeldCalendar',
    footer: "If you didn't expect this invitation, you can ignore this email.",
  },
  booking: {
    confirmed: {
      subject: 'Booking confirmed: {page} on {date}',
      preview: 'Your meeting with {host} is confirmed for {date}.',
      kicker: 'Booking confirmed',
      intro: 'Hi {name}, your meeting with {host} is confirmed. The invitation is attached, so you can add it to your calendar.',
    },
    host: 'Host',
    date: 'Date',
    time: 'Time',
    location: 'Location',
    phone: 'Phone',
    videoCall: 'Video call',
    joinVideoCall: 'Join video call',
    messageFrom: 'A note from {host}',
    manage: {
      withLinks: 'Need to make a change? You can {reschedule} or {cancel} this booking, or reply to this email to reach {host}.',
      withoutLinks: 'Need to make a change? Reply to this email to reach {host}.',
      reschedule: 'reschedule',
      cancel: 'cancel',
    },
  },
  notifications: {
    open: 'Open in WeldSuite',
    footer: "You're receiving this because email notifications are on.",
    manage: 'Notification settings',
  },
};
