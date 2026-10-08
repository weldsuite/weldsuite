import { describe, expect, it } from 'vitest';
import { parseHttpsUrl, resolveEmbed } from './embed-url';

describe('parseHttpsUrl', () => {
  it('accepts https links and adds the scheme to a bare domain', () => {
    expect(parseHttpsUrl('https://example.com/a?b=1')?.toString()).toBe('https://example.com/a?b=1');
    expect(parseHttpsUrl('  example.org/page ')?.toString()).toBe('https://example.org/page');
  });

  it.each(['', 'not a link', 'http://example.com', 'javascript:alert(1)', 'data:text/html,hi', 'https://localhost'])(
    'rejects %j',
    (input) => {
      expect(parseHttpsUrl(input)).toBeNull();
    },
  );
});

describe('resolveEmbed', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=42', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90'],
    ['youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    ['https://vimeo.com/76979871', 'https://player.vimeo.com/video/76979871'],
    ['https://vimeo.com/channels/staffpicks/76979871', 'https://player.vimeo.com/video/76979871'],
    ['https://www.loom.com/share/0281766fa2d0', 'https://www.loom.com/embed/0281766fa2d0'],
    [
      'https://www.figma.com/design/abc123/Test',
      'https://www.figma.com/embed?embed_host=weldsuite&url=https%3A%2F%2Fwww.figma.com%2Fdesign%2Fabc123%2FTest',
    ],
    ['https://docs.google.com/document/d/1AbC/edit#heading=h.1', 'https://docs.google.com/document/d/1AbC/preview'],
    ['https://docs.google.com/spreadsheets/d/1AbC/edit?gid=0', 'https://docs.google.com/spreadsheets/d/1AbC/preview'],
    ['https://drive.google.com/file/d/1AbC/view?usp=sharing', 'https://drive.google.com/file/d/1AbC/preview'],
    ['https://www.google.com/maps/place/Amsterdam/@52.37,4.89,12z', 'https://www.google.com/maps?q=Amsterdam&output=embed'],
    ['https://www.google.com/maps/@52.37,4.89,12z', 'https://www.google.com/maps?q=52.37%2C4.89&output=embed'],
    ['https://codepen.io/team/codepen/pen/PNaGbb', 'https://codepen.io/team/embed/PNaGbb?default-tab=result'],
    ['https://miro.com/app/board/uXjVK123=/', 'https://miro.com/app/live-embed/uXjVK123=/'],
    ['https://miro.com/app/live-embed/uXjVK123=/', 'https://miro.com/app/live-embed/uXjVK123=/'],
  ])('rewrites %s', (input, src) => {
    expect(resolveEmbed(input)?.src).toBe(src);
  });

  it('labels the provider and keeps video players 16:9', () => {
    expect(resolveEmbed('https://youtu.be/dQw4w9WgXcQ')).toMatchObject({ provider: 'youtube', layout: 'video' });
    expect(resolveEmbed('https://vimeo.com/76979871')).toMatchObject({ provider: 'vimeo', layout: 'video' });
    expect(resolveEmbed('https://miro.com/app/board/x1/')).toMatchObject({ provider: 'miro', layout: 'document' });
  });

  it('embeds any other https link as-is', () => {
    expect(resolveEmbed('https://example.com/widget')).toEqual({
      src: 'https://example.com/widget',
      provider: 'generic',
      layout: 'document',
    });
  });

  it.each([
    'javascript:alert(1)',
    'http://example.com',
    'https://www.youtube.com/feed/subscriptions',
    'https://vimeo.com/about',
    'https://drive.google.com/drive/my-drive',
    'https://www.google.com/maps',
  ])('has no embed for %s', (input) => {
    expect(resolveEmbed(input)).toBeNull();
  });
});
