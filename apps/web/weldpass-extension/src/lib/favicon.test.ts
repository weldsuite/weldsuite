// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { faviconUrl, iconShape, imageShape, type Pixel } from './favicon';

describe('faviconUrl', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://weldpass${path}` } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("points into the browser's favicon cache, never at the site or a third party", () => {
    const url = new URL(faviconUrl('https://github.com/login')!);
    // An extension URL's origin is opaque to URL; compare its parts.
    expect(url.protocol).toBe('chrome-extension:');
    expect(url.host).toBe('weldpass');
    expect(url.pathname).toBe('/_favicon/');
    expect(url.searchParams.get('pageUrl')).toBe('https://github.com/login');
    expect(url.searchParams.get('size')).toBe('32');
  });

  it('takes another size', () => {
    expect(new URL(faviconUrl('https://github.com/', 16)!).searchParams.get('size')).toBe('16');
  });

  it('has nothing for a login without a web address', () => {
    expect(faviconUrl(null)).toBeNull();
    expect(faviconUrl('')).toBeNull();
    expect(faviconUrl('not a url')).toBeNull();
    expect(faviconUrl('chrome://settings/')).toBeNull();
    expect(faviconUrl('javascript:alert(1)')).toBeNull();
  });

  it('has nothing outside an extension page', () => {
    vi.unstubAllGlobals();
    expect(faviconUrl('https://github.com/')).toBeNull();
  });
});

describe('iconShape', () => {
  const BLACK: Pixel = [0, 0, 0, 255];
  const WHITE: Pixel = [255, 255, 255, 255];
  const BLUE: Pixel = [10, 102, 194, 255];
  const CLEAR: Pixel = [0, 0, 0, 0];
  const inCircle = (x: number, y: number, radius: number) => Math.hypot(x - 15.5, y - 15.5) < radius;

  const square = (): Pixel => BLUE;
  const roundedSquare = (x: number, y: number): Pixel => {
    // A 32px square with 8px rounded corners.
    const near = (v: number) => Math.min(v, 31 - v);
    const [dx, dy] = [near(x), near(y)];
    return dx < 8 && dy < 8 && Math.hypot(8 - dx, 8 - dy) > 8 ? CLEAR : BLUE;
  };
  const blackDisc = (x: number, y: number): Pixel => (inCircle(x, y, 16) ? BLACK : CLEAR);
  const whiteDiscWithMark = (x: number, y: number): Pixel =>
    inCircle(x, y, 6) ? BLUE : inCircle(x, y, 16) ? WHITE : CLEAR;
  const glyph = (x: number, y: number): Pixel => (inCircle(x, y, 11) ? BLACK : CLEAR);

  it('fills the tile with a square icon, rounded corners or not', () => {
    expect(iconShape(square)).toBe('square');
    expect(iconShape(roundedSquare)).toBe('square');
  });

  it('fills the tile with a full circle in its own colour', () => {
    expect(iconShape(blackDisc)).toBe('round');
  });

  it('keeps a mark on a transparent or white background in its tile', () => {
    expect(iconShape(glyph)).toBe('glyph');
    expect(iconShape(whiteDiscWithMark)).toBe('glyph');
    expect(iconShape(() => CLEAR)).toBe('glyph');
  });
});

describe('imageShape', () => {
  afterEach(() => vi.restoreAllMocks());

  /** A 2D context whose pixels are all `pixel`, as an icon the canvas could read. */
  function contextOf(pixel: Pixel, drawImage: () => void = () => undefined) {
    const data = new Uint8ClampedArray(32 * 32 * 4);
    for (let i = 0; i < data.length; i += 4) data.set(pixel, i);
    return { drawImage, getImageData: () => ({ data }) } as unknown as CanvasRenderingContext2D;
  }

  it('reads the loaded icon through a canvas', () => {
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(contextOf([10, 102, 194, 255]));
    expect(imageShape(new Image())).toBe('square');
    expect(getContext).toHaveBeenCalledWith('2d', { willReadFrequently: true });
  });

  it('keeps an icon it cannot read in its tile', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(imageShape(new Image())).toBe('glyph');

    // Another origin without CORS taints the canvas, and reading it throws.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      contextOf([0, 0, 0, 255], () => {
        throw new DOMException('tainted', 'SecurityError');
      }),
    );
    expect(imageShape(new Image())).toBe('glyph');
  });
});
