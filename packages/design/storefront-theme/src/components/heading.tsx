import type { ReactNode } from 'react';

export interface HeadingProps {
  level: 1 | 2 | 3;
  id?: string;
  className?: string;
  children: ReactNode;
}

/** A heading at the level the page outline needs (sections get it from the renderer). */
export function Heading({ level, id, className, children }: Readonly<HeadingProps>) {
  if (level === 1) return <h1 id={id} className={className}>{children}</h1>;
  if (level === 3) return <h3 id={id} className={className}>{children}</h3>;
  return <h2 id={id} className={className}>{children}</h2>;
}
