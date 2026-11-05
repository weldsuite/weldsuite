import { boardSvgSize, nextZoom } from '../lib/board-view';

describe('board viewer', () => {
  it('steps the zoom up and down, and stops at the ends', () => {
    expect(nextZoom(1, 1)).toBe(1.5);
    expect(nextZoom(1.5, 1)).toBe(2);
    expect(nextZoom(4, 1)).toBe(4);
    expect(nextZoom(2, -1)).toBe(1.5);
    expect(nextZoom(1, -1)).toBe(1);
  });

  it('reads the size the rendered board has', () => {
    expect(boardSvgSize('<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="1152" viewBox="0 0 10 5"><rect width="1" height="1"/></svg>')).toEqual({ width: 2048, height: 1152 });
    expect(boardSvgSize('<div/>')).toBeNull();
  });
});
