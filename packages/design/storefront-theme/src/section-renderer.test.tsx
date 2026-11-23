import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SECTION_CATALOG } from './catalog';
import { newSection } from './defaults';
import { SectionRenderer, visibleSections } from './section-renderer';
import { SECTION_COMPONENTS } from './sections';
import { TestShop } from './test-utils';
import type { Section } from './types';

const text = (id: string, heading: string): Section => newSection(id, 'rich-text', { heading, text: 'Body' });

describe('SectionRenderer', () => {
  it('has a component for every section type of the catalog, and no others', () => {
    expect(Object.keys(SECTION_COMPONENTS).sort()).toEqual(Object.keys(SECTION_CATALOG).sort());
  });

  it('draws visible sections in order and skips hidden ones', () => {
    const sections = [text('one', 'First'), { ...text('two', 'Hidden'), hidden: true }, text('three', 'Third')];
    const { container } = render(
      <TestShop>
        <SectionRenderer sections={sections} list="home" />
      </TestShop>,
    );
    expect(Array.from(container.querySelectorAll('h2')).map((h) => h.textContent)).toEqual(['First', 'Third']);
    expect(container.textContent).not.toContain('Hidden');
  });

  it('skips unknown types and sections not allowed in the list', () => {
    const sections: Section[] = [
      { id: 'future', type: 'carousel-3d', settings: {} },
      newSection('main', 'main-product'),
      text('ok', 'Shown'),
    ];
    expect(visibleSections(sections, 'home').map((section) => section.id)).toEqual(['ok']);
    const { container } = render(
      <TestShop>
        <SectionRenderer sections={sections} list="home" />
      </TestShop>,
    );
    expect(container.querySelectorAll('section')).toHaveLength(1);
  });

  it('marks sections with their id and list in preview mode only', () => {
    const sections = [text('intro', 'Intro')];
    const live = render(
      <TestShop>
        <SectionRenderer sections={sections} list="content" />
      </TestShop>,
    );
    expect(live.container.querySelector('[data-section-id]')).toBeNull();
    live.unmount();

    const preview = render(
      <TestShop shop={{ preview: true }}>
        <SectionRenderer sections={sections} list="content" />
      </TestShop>,
    );
    const marked = preview.container.querySelector('[data-section-id="intro"]');
    expect(marked?.getAttribute('data-section-list')).toBe('content');
    expect(marked?.tagName).toBe('SECTION');
  });

  it('marks the header and footer groups too, on their landmark elements', () => {
    const { container } = render(
      <TestShop shop={{ preview: true }}>
        <SectionRenderer sections={[newSection('header', 'header')]} list="header" />
        <SectionRenderer sections={[newSection('footer', 'footer')]} list="footer" />
      </TestShop>,
    );
    expect(container.querySelector('header')?.getAttribute('data-section-list')).toBe('header');
    expect(container.querySelector('footer')?.getAttribute('data-section-id')).toBe('footer');
  });

  it('gives the first section the h1 when asked, and the rest h2', () => {
    const { container } = render(
      <TestShop>
        <SectionRenderer sections={[text('a', 'A'), text('b', 'B')]} list="home" firstHeadingLevel={1} />
      </TestShop>,
    );
    expect(container.querySelector('h1')?.textContent).toBe('A');
    expect(container.querySelector('h2')?.textContent).toBe('B');
  });

  it('loads only the first large image eagerly, with high priority', () => {
    const hero = (id: string) => newSection(id, 'hero', { image: 'https://cdn.example/hero.jpg', imageAlt: 'A hero' });
    const { container } = render(
      <TestShop>
        <SectionRenderer sections={[hero('first'), hero('second')]} list="home" priorityFirst />
      </TestShop>,
    );
    const [first, second] = Array.from(container.querySelectorAll('img'));
    expect(first?.getAttribute('fetchpriority')).toBe('high');
    expect(first?.hasAttribute('loading')).toBe(false);
    expect(second?.getAttribute('loading')).toBe('lazy');
    expect(second?.getAttribute('decoding')).toBe('async');
    expect(first?.getAttribute('alt')).toBe('A hero');
  });

  it('draws a content page’s own sections inside main-page', () => {
    const page = { id: 'p1', title: 'About us', slug: 'about', sections: [text('story', 'Our story')] };
    const { container } = render(
      <TestShop shop={{ preview: true }} data={{ page }}>
        <SectionRenderer sections={[newSection('main', 'main-page')]} list="page" />
      </TestShop>,
    );
    expect(container.querySelector('h1')?.textContent).toBe('About us');
    expect(container.querySelector('[data-section-list="content"]')?.getAttribute('data-section-id')).toBe('story');
  });

  it('loads nothing from the video site before play is pressed', () => {
    const video = newSection('clip', 'video', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', heading: 'Watch' });
    const { container, getByRole } = render(
      <TestShop>
        <SectionRenderer sections={[video]} list="home" />
      </TestShop>,
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    getByRole('button').click();
    return Promise.resolve().then(() => {
      expect(container.querySelector('iframe')?.getAttribute('src')).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    });
  });
});
