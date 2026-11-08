import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { LinkifiedText } from './linkified-text';

describe('LinkifiedText', () => {
  it('renders URLs as links that open in a new tab, the rest as text', () => {
    const { container } = render(
      <p>
        <LinkifiedText text="See https://help.acme.test/articles/reset. Or www.acme.test" />
      </p>,
    );
    const links = Array.from(container.querySelectorAll('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://help.acme.test/articles/reset',
      'https://www.acme.test',
    ]);
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.textContent).toBe('See https://help.acme.test/articles/reset. Or www.acme.test');
  });

  it('never turns markup into elements', () => {
    const { container } = render(<LinkifiedText text={'<img src=x onerror="alert(1)"> javascript:alert(1)'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });
});
