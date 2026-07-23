import { Fragment, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

interface TransProps {
  /**
   * Translation template containing `{name}` placeholders.
   * Typically a value from a translations object (e.g. `t.checkout.terms`).
   */
  template: string;
  /**
   * Map of placeholder name → replacement. String / number values render
   * inline; ReactNode values (e.g. `<Link>Terms</Link>`) are inlined as
   * children so layout/styling stays intact.
   */
  values: Record<string, ReactNode>;
}

/**
 * Render a translation template with React children spliced into placeholders.
 *
 *   <Trans
 *     template={t.checkout.terms}
 *     values={{ terms: <Link to="/tos">terms of service</Link> }}
 *   />
 *
 * Missing placeholders are left visible (e.g. `{foo}`) rather than silently
 * dropped, so translation bugs are loud during development.
 */
export function Trans({ template, values }: TransProps): ReactElement {
  const parts: ReactNode[] = [];
  const regex = /\{(\w+)\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = regex.exec(template)) !== null) {
    if (match.index > lastIndex) {
      parts.push(template.slice(lastIndex, match.index));
    }
    const name = match[1];
    if (name === undefined) {
      lastIndex = regex.lastIndex;
      continue;
    }
    const value = values[name];
    const key = `${name}-${idx++}`;

    if (value === undefined) {
      parts.push(match[0]);
    } else if (isValidElement(value)) {
      parts.push(cloneElement(value, { key }));
    } else {
      parts.push(<Fragment key={key}>{value}</Fragment>);
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < template.length) {
    parts.push(template.slice(lastIndex));
  }
  return <>{parts}</>;
}
