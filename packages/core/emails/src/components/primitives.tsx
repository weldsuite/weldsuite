/**
 * Building blocks for the content of an email. Templates compose these instead
 * of writing markup, so every email gets the same email-client-safe output:
 * tables, inline styles, no flex/grid, absolute links.
 */

import type { CSSProperties, ReactNode } from 'react';
import { Button as REButton, Column, Heading as REHeading, Hr, Link, Row, Section, Text } from '@react-email/components';
import { theme } from '../theme';
import { useEmail } from './context';

const { color, size, lineHeight, radius, space, font } = theme;

/** Small muted line above the heading: who did what ("Sanne invited you to an event."). */
export function Kicker({ children }: { children: ReactNode }) {
  return (
    <Text style={{ margin: '0 0 8px', fontSize: size.small, lineHeight: lineHeight.body, color: color.muted }}>
      {children}
    </Text>
  );
}

/** The heading of the email. `struck` for things that no longer happen. */
export function Heading({ children, struck }: { children: ReactNode; struck?: boolean }) {
  return (
    <REHeading
      as="h1"
      style={{
        margin: `0 0 ${space.block}px`,
        fontSize: size.heading,
        lineHeight: lineHeight.tight,
        fontWeight: 600,
        letterSpacing: '-0.02em',
        color: struck ? color.subtle : color.ink,
        textDecoration: struck ? 'line-through' : 'none',
      }}
    >
      {children}
    </REHeading>
  );
}

export function Paragraph({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <Text
      style={{
        margin: `0 0 ${space.text}px`,
        fontSize: muted ? size.small : size.body,
        lineHeight: lineHeight.body,
        color: muted ? color.muted : color.text,
      }}
    >
      {children}
    </Text>
  );
}

/** Emphasis inside a paragraph (names, titles). */
export function Strong({ children }: { children: ReactNode }) {
  return <strong style={{ color: color.ink, fontWeight: 600 }}>{children}</strong>;
}

/** A call to action. `secondary` is a quiet grey button for the lesser action. */
export function Button({
  href,
  children,
  variant = 'primary',
}: {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
}) {
  const { accent } = useEmail();
  const primary = variant === 'primary';
  return (
    <REButton
      href={href}
      style={{
        display: 'inline-block',
        padding: '11px 18px',
        borderRadius: radius.button,
        backgroundColor: primary ? accent : color.surface,
        color: primary ? color.onAccent : color.ink,
        fontSize: size.small,
        fontWeight: 500,
        lineHeight: 1,
        textDecoration: 'none',
      }}
    >
      {children}
    </REButton>
  );
}

/** One or more buttons side by side. */
export function Actions({ children }: { children: ReactNode }) {
  const items = (Array.isArray(children) ? children : [children]).filter(Boolean);
  return (
    <Section style={{ margin: `0 0 ${space.block}px` }}>
      <Row>
        {items.map((item, i) => (
          <Column key={i} style={{ width: '1%', paddingRight: 8, whiteSpace: 'nowrap' }}>
            {item}
          </Column>
        ))}
        <Column />
      </Row>
    </Section>
  );
}

/** The bare URL under a button, for clients that strip buttons. */
export function LinkFallback({ href }: { href: string }) {
  const { t } = useEmail();
  return (
    <Text
      style={{
        margin: `-${space.text - 4}px 0 ${space.block}px`,
        fontSize: size.tiny,
        lineHeight: lineHeight.body,
        color: color.subtle,
        wordBreak: 'break-all',
      }}
    >
      {t.layout.linkFallback}{' '}
      <Link href={href} style={{ color: color.muted, textDecoration: 'underline' }}>
        {href}
      </Link>
    </Text>
  );
}

/** An inline link. `muted` takes the color of the text around it (footer). */
export function TextLink({ href, children, muted }: { href: string; children: ReactNode; muted?: boolean }) {
  return (
    <Link href={href} style={{ color: muted ? 'inherit' : color.ink, textDecoration: 'underline' }}>
      {children}
    </Link>
  );
}

/**
 * Text someone else wrote (a chat message, a note from the host), set off by
 * a thin rule. `label` is the small line above it.
 */
export function Quote({ children, label }: { children: ReactNode; label?: ReactNode }) {
  return (
    <Section style={{ margin: `0 0 ${space.block}px` }}>
      {label ? (
        <Text style={{ margin: '0 0 8px', fontSize: size.small, lineHeight: lineHeight.body, color: color.muted }}>
          {label}
        </Text>
      ) : null}
      <Text
        style={{
          margin: 0,
          padding: '2px 0 2px 16px',
          borderLeft: `2px solid ${color.border}`,
          fontSize: size.body,
          lineHeight: lineHeight.body,
          color: color.text,
        }}
      >
        {children}
      </Text>
    </Section>
  );
}

export interface DetailRow {
  label: string;
  value: ReactNode;
  /** A previous value shown struck through above the current one ("was"). */
  previous?: ReactNode;
}

/** Label/value rows between two hairlines: when, where, who. Empty rows are skipped. */
export function Details({ rows }: { rows: DetailRow[] }) {
  const visible = rows.filter((r) => r.value !== undefined && r.value !== null && r.value !== '');
  if (!visible.length) return null;
  const cell: CSSProperties = { padding: '6px 0', verticalAlign: 'top', fontSize: size.small, lineHeight: lineHeight.body };
  return (
    <Section
      style={{
        margin: `0 0 ${space.block}px`,
        padding: '10px 0',
        borderTop: `1px solid ${color.border}`,
        borderBottom: `1px solid ${color.border}`,
      }}
    >
      {visible.map((row) => (
        <Row key={row.label}>
          <Column data-text="label" style={{ ...cell, width: 96, color: color.muted }}>
            {row.label}
          </Column>
          <Column data-text="value" style={{ ...cell, color: color.ink }}>
            {row.previous ? (
              <span data-text="previous" style={{ display: 'block', color: color.subtle, textDecoration: 'line-through' }}>
                {row.previous}
              </span>
            ) : null}
            {row.value}
          </Column>
        </Row>
      ))}
    </Section>
  );
}

/** A one-time code, large and spaced so it is easy to read and copy. */
export function Code({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{
        margin: `0 0 ${space.block}px`,
        padding: '18px 0',
        backgroundColor: color.surface,
        borderRadius: radius.block,
        textAlign: 'center',
        fontFamily: font.mono,
        fontSize: size.code,
        fontWeight: 600,
        letterSpacing: '0.25em',
        color: color.ink,
      }}
    >
      {children}
    </Text>
  );
}

export function Divider() {
  return <Hr style={{ margin: `${space.block}px 0`, border: 'none', borderTop: `1px solid ${color.border}` }} />;
}

/** Preserves the line breaks of user-written text (descriptions, notes). */
export function MultilineText({ text }: { text: string }) {
  const lines = text.split(/\r\n|\r|\n/);
  return (
    <>
      {lines.map((line, i) => (
        <span key={i}>
          {line}
          {i < lines.length - 1 ? <br /> : null}
        </span>
      ))}
    </>
  );
}
