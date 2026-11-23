// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { safeImageSrc, safeLink } from './links';
import { videoEmbed } from './video-url';

describe('videoEmbed', () => {
  it('uses youtube-nocookie for every YouTube address form', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    ]) {
      expect(videoEmbed(url)?.embedUrl, url).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0');
    }
  });

  it('asks Vimeo not to track', () => {
    expect(videoEmbed('https://vimeo.com/123456')?.embedUrl).toBe('https://player.vimeo.com/video/123456?dnt=1&autoplay=1');
    expect(videoEmbed('https://vimeo.com/123456/abcdef1234')?.embedUrl).toContain('h=abcdef1234');
  });

  it('refuses other sites and look-alikes', () => {
    expect(videoEmbed('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(videoEmbed('javascript:alert(1)')).toBeNull();
    expect(videoEmbed('https://example.com/video.mp4')).toBeNull();
  });
});

describe('safe URLs', () => {
  it('allows shop paths, http(s), mailto and tel links only', () => {
    expect(safeLink('/products')).toEqual({ href: '/products', external: false });
    expect(safeLink('https://example.com')?.external).toBe(true);
    expect(safeLink('mailto:a@example.com')?.external).toBe(false);
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink('//evil.example')).toBeNull();
    expect(safeLink(' /a b ')).toBeNull();
  });

  it('allows images over http(s) or from the shop only', () => {
    expect(safeImageSrc('https://cdn.example/a.jpg')).toBe('https://cdn.example/a.jpg');
    expect(safeImageSrc('/a.jpg')).toBe('/a.jpg');
    expect(safeImageSrc('data:image/png;base64,AAAA')).toBeNull();
  });
});
