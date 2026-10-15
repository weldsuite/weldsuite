import { describe, expect, it } from 'vitest';
import {
  buildEmailFooter,
  buildTemplateValues,
  composeBody,
  DEFAULT_OPT_OUT_TEXT,
  renderStepContent,
  replySubject,
  singleLine,
  snippetOf,
} from './render';

const prospect = {
  email: 'jane@bigco.io',
  firstName: 'Jane',
  lastName: 'Doe',
  companyName: 'BigCo',
  title: 'CTO',
  customFields: { city: 'Utrecht', firstName: 'IGNORED' },
};
const sender = { firstName: 'Sam', lastName: 'Taylor' };

describe('buildTemplateValues', () => {
  it('exposes the prospect, the sender and the custom fields, built-ins winning', () => {
    expect(buildTemplateValues(prospect, sender)).toMatchObject({
      firstName: 'Jane',
      lastName: 'Doe',
      fullName: 'Jane Doe',
      email: 'jane@bigco.io',
      companyName: 'BigCo',
      title: 'CTO',
      senderFirstName: 'Sam',
      senderLastName: 'Taylor',
      senderFullName: 'Sam Taylor',
      city: 'Utrecht',
    });
  });

  it('leaves absent values null so fallbacks apply', () => {
    const v = buildTemplateValues({ ...prospect, firstName: null, lastName: null, customFields: null }, null);
    expect(v).toMatchObject({ firstName: null, fullName: null, senderFirstName: null, senderFullName: null });
  });
});

describe('renderStepContent', () => {
  const values = buildTemplateValues(prospect, sender);

  it('fills variables and fallbacks in subject and body', () => {
    const r = renderStepContent({ subject: 'Hi {{firstName|there}} at {{companyName}}', body: '{{city|your town}} / {{ title }}' }, values);
    expect(r).toEqual({ subject: 'Hi Jane at BigCo', body: 'Utrecht / CTO', missing: [] });
    const fallback = renderStepContent({ subject: 'Hi {{nickname|there}}', body: 'x' }, values);
    expect(fallback.subject).toBe('Hi there');
  });

  it('reports each unresolved variable once, across subject and body, and leaves the braces', () => {
    const r = renderStepContent({ subject: 'About {{recentNews}}', body: 'Saw {{recentNews}} and {{funding}}' }, values);
    expect(r.missing.sort()).toEqual(['funding', 'recentNews']);
    expect(r.subject).toBe('About {{recentNews}}');
  });

  it('keeps a header on one line even if a value carries a line break', () => {
    const r = renderStepContent({ subject: 'Hello {{name}}', body: 'x' }, { name: 'Jane\r\nBcc: attacker@evil.example' });
    expect(r.subject).toBe('Hello Jane Bcc: attacker@evil.example');
    expect(singleLine('a\nb\r\nc')).toBe('a b c');
  });
});

describe('subjects, body and footer', () => {
  it('prefixes Re: once', () => {
    expect(replySubject('Hello')).toBe('Re: Hello');
    expect(replySubject('Re: Hello')).toBe('Re: Hello');
    expect(replySubject('RE: Hello')).toBe('RE: Hello');
  });

  it('appends the signature unless the body already ends with it', () => {
    expect(composeBody('Hi Jane\n\n', 'Sam | Acme')).toBe('Hi Jane\n\nSam | Acme');
    expect(composeBody('Hi Jane\n\nSam | Acme', 'Sam | Acme')).toBe('Hi Jane\n\nSam | Acme');
    expect(composeBody('Hi Jane  ', null)).toBe('Hi Jane');
    expect(composeBody('Hi Jane', '   ')).toBe('Hi Jane');
  });

  it('builds the footer after the standard signature delimiter', () => {
    expect(buildEmailFooter({ optOutText: 'Reply stop.', senderCompanyName: 'Acme BV', senderAddress: 'Keizersgracht 1' })).toBe(
      '\n\n-- \nReply stop.\nAcme BV\nKeizersgracht 1',
    );
    expect(buildEmailFooter({ optOutText: null, senderCompanyName: 'Acme BV', senderAddress: null })).toBe(`\n\n-- \n${DEFAULT_OPT_OUT_TEXT}\nAcme BV`);
    expect(buildEmailFooter(null)).toBe(`\n\n-- \n${DEFAULT_OPT_OUT_TEXT}`);
  });

  it('never mentions WeldSuite', () => {
    expect(DEFAULT_OPT_OUT_TEXT.toLowerCase()).not.toContain('weld');
    expect(buildEmailFooter(null).toLowerCase()).not.toContain('weld');
  });

  it('cuts a snippet to one line', () => {
    expect(snippetOf('Hi\n\n  there   friend')).toBe('Hi there friend');
    expect(snippetOf('x'.repeat(600))).toHaveLength(500);
  });
});
