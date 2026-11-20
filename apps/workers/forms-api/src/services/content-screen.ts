/**
 * The publish-time content screen (weldsuite-documentation/plans/weldforms.md, "Bot checks and
 * abuse"): a synchronous, cheap check for forms that look like phishing. A form
 * that trips it still publishes, but is held for staff review
 * (`form_link_registry.held_at`): respondents see "no longer available" until
 * staff release it. Only the form's own wording is checked, never answers.
 *
 * Two patterns:
 * - a question that asks for a credential (a password, a card's security code,
 *   a recovery phrase, an online-banking login);
 * - a brand name next to an account-takeover word ("Microsoft: verify your
 *   account"), in the title, the welcome screen or a question.
 *
 * A heuristic, tuned to leave ordinary forms alone ("Which Google product do you
 * use?" passes); an AI classifier on top is listed under "Later".
 */

import { fieldsOf } from '@weldsuite/forms-engine';
import type { FormDefinition } from '@weldsuite/forms-engine/definition';

const CREDENTIAL = new RegExp(
  [
    'passwords?',
    'passcode',
    'wachtwoord',
    'pincode',
    'pin code',
    '\\bpin\\b',
    'cvv',
    'cvc',
    'card number',
    'kaartnummer',
    'creditcard',
    'credit card',
    'security code',
    'beveiligingscode',
    'verification code',
    'verificatiecode',
    'one-time code',
    'recovery phrase',
    'seed phrase',
    'private key',
    'online banking',
    'internetbankieren',
    'bank login',
    'bank log-?in',
  ].join('|'),
  'i',
);

const BRAND_NAMES = [
  'microsoft',
  'office ?365',
  'outlook',
  'google',
  'gmail',
  'paypal',
  'apple ?id',
  'icloud',
  'amazon',
  'netflix',
  'facebook',
  'instagram',
  'whatsapp',
  'linkedin',
  'dhl',
  'ups',
  'fedex',
  'postnl',
  'ing',
  'rabobank',
  'abn ?amro',
  'bunq',
  'docusign',
  'wetransfer',
  'dropbox',
  'digid',
  'belastingdienst',
];
const BRANDS = new RegExp(`\\b(${BRAND_NAMES.join('|')})\\b`, 'i');
const TAKEOVER = /\b(verify|verification|sign ?in|log ?in|login|account|suspended|locked|confirm|security alert|unusual activity|update your|bevestig|inloggen|geblokkeerd)\b/i;

/** Why the form is held, or null when it looks fine. */
export function screenForm(title: string, def: FormDefinition): string | null {
  for (const field of fieldsOf(def)) {
    if (CREDENTIAL.test(field.title)) return `A question asks for a credential: "${field.title.slice(0, 120)}"`;
  }
  const headlines = [title, def.welcome?.title ?? '', ...fieldsOf(def).map((f) => f.title)];
  for (const text of headlines) {
    if (BRANDS.test(text) && TAKEOVER.test(text)) return `Looks like it imitates a brand: "${text.slice(0, 120)}"`;
  }
  return null;
}
