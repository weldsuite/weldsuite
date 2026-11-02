/**
 * Widget strings in the visitor's language (browser setting), en or nl.
 *
 * Only the rating, away-hours and sign-in copy goes through here so far; the
 * rest of the messenger is still English-only.
 */

import type { ExpectedReplyTime } from './api/types';

const en = {
  rating: {
    prompt: 'How did we do?',
    hint: 'Rate this conversation',
    star: '{rating} out of 5',
    labels: ['Terrible', 'Bad', 'OK', 'Good', 'Amazing'],
    commentPlaceholder: 'Tell us more (optional)',
    submit: 'Send',
    thanks: 'Thanks for your feedback!',
    failed: "Couldn't send your rating. Please try again.",
    rated: 'You rated this conversation {rating}/5',
  },
  away: {
    title: "We're away right now",
    message: "Leave a message and we'll get back to you by email.",
    backAt: 'Back at {time}',
    backOn: 'Back {day} at {time}',
    emailTitle: 'Leave your email so we can reply',
    emailHint: "We're away right now, so we'll answer by email.",
  },
  replyTime: {
    few_minutes: 'Usually replies in a few minutes',
    hour: 'Usually replies within an hour',
    few_hours: 'Usually replies in a few hours',
    day: 'Usually replies within a day',
  } satisfies Record<ExpectedReplyTime, string>,
  signIn: {
    title: 'Sign in to chat with us',
    message: 'Sign in on {site} to chat with us.',
    messageNoSite: 'Sign in on this website to chat with us.',
    hint: 'Once you are signed in, your conversations show up here.',
  },
};

type WidgetStrings = typeof en;

const nl: WidgetStrings = {
  rating: {
    prompt: 'Hoe hebben we het gedaan?',
    hint: 'Beoordeel dit gesprek',
    star: '{rating} van 5',
    labels: ['Heel slecht', 'Slecht', 'Oké', 'Goed', 'Geweldig'],
    commentPlaceholder: 'Vertel ons meer (optioneel)',
    submit: 'Versturen',
    thanks: 'Bedankt voor je feedback!',
    failed: 'Je beoordeling kon niet worden verstuurd. Probeer het opnieuw.',
    rated: 'Je hebt dit gesprek beoordeeld met {rating}/5',
  },
  away: {
    title: 'We zijn er nu niet',
    message: 'Laat een bericht achter, dan reageren we per e-mail.',
    backAt: 'Terug om {time}',
    backOn: 'Terug op {day} om {time}',
    emailTitle: 'Laat je e-mailadres achter zodat we kunnen reageren',
    emailHint: 'We zijn er nu niet, dus we antwoorden per e-mail.',
  },
  replyTime: {
    few_minutes: 'Reageert meestal binnen een paar minuten',
    hour: 'Reageert meestal binnen een uur',
    few_hours: 'Reageert meestal binnen een paar uur',
    day: 'Reageert meestal binnen een dag',
  },
  signIn: {
    title: 'Log in om met ons te chatten',
    message: 'Log in op {site} om met ons te chatten.',
    messageNoSite: 'Log in op deze website om met ons te chatten.',
    hint: 'Zodra je bent ingelogd, zie je hier je gesprekken.',
  },
};

export type WidgetLocale = 'en' | 'nl';

export function detectLocale(languages: readonly string[] = globalThis.navigator?.languages ?? []): WidgetLocale {
  const first = languages[0]?.toLowerCase() ?? '';
  return first.startsWith('nl') ? 'nl' : 'en';
}

export const locale: WidgetLocale = detectLocale();
export const t: WidgetStrings = locale === 'nl' ? nl : en;

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match: string, key: string) => (key in values ? String(values[key]) : match));
}

/** "Back at 09:00" today, otherwise "Back Monday at 09:00", in the visitor's own timezone. */
export function backAtText(nextOpenAt: string, now: Date = new Date()): string {
  const at = new Date(nextOpenAt);
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at);
  if (at.toDateString() === now.toDateString()) return fill(t.away.backAt, { time });
  const day = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(at);
  return fill(t.away.backOn, { day, time });
}
