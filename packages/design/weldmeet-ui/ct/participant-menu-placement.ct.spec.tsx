/**
 * Where the participant 3-dots / right-click menu opens.
 *
 * The menu's height depends on who it is for, so its position is worked out
 * from its measured size. It used to assume a fixed 220×340 box, which sent
 * the menu ~330px above the button on tiles low on the screen.
 */

import { test, expect } from '@playwright/experimental-ct-react';
import { placeParticipantMenu } from '../src/components/participant-context-menu';

const VIEWPORT = [1440, 900] as const;
const MENU = [218, 183] as const;

test.describe('placeParticipantMenu', () => {
  test('hangs under a button, right edges aligned', () => {
    const button = { right: 708, top: 75, bottom: 103 };
    const at = placeParticipantMenu(
      { x: button.right, y: button.bottom + 4, alignRight: true, flipY: button.top - 4 },
      ...MENU,
      ...VIEWPORT,
    );
    expect(at).toEqual({ left: button.right - MENU[0], top: button.bottom + 4 });
  });

  test('opens above the button when there is no room below, still touching it', () => {
    const button = { right: 885, top: 800, bottom: 828 };
    const at = placeParticipantMenu(
      { x: button.right, y: button.bottom + 4, alignRight: true, flipY: button.top - 4 },
      ...MENU,
      ...VIEWPORT,
    );
    // Bottom edge sits on the button's top: never hundreds of pixels away.
    expect(at.top + MENU[1]).toBe(button.top - 4);
    expect(at.left).toBe(button.right - MENU[0]);
  });

  test('a short menu near the bottom is not pushed up by a height it does not have', () => {
    // 150px of room under the pointer: a 120px menu fits, so it opens downwards.
    const at = placeParticipantMenu({ x: 300, y: 742 }, 200, 120, ...VIEWPORT);
    expect(at).toEqual({ left: 300, top: 742 });
  });

  test('right-click opens at the pointer', () => {
    expect(placeParticipantMenu({ x: 405, y: 87 }, ...MENU, ...VIEWPORT)).toEqual({ left: 405, top: 87 });
  });

  test('stays inside the viewport at every corner', () => {
    for (const [x, y] of [[0, 0], [1440, 0], [0, 900], [1440, 900]] as const) {
      const at = placeParticipantMenu({ x, y }, ...MENU, ...VIEWPORT);
      expect(at.left).toBeGreaterThanOrEqual(8);
      expect(at.top).toBeGreaterThanOrEqual(8);
      expect(at.left + MENU[0]).toBeLessThanOrEqual(VIEWPORT[0] - 8);
      expect(at.top + MENU[1]).toBeLessThanOrEqual(VIEWPORT[1] - 8);
    }
  });

  test('a button at the left edge of a phone keeps the menu on screen', () => {
    const at = placeParticipantMenu({ x: 150, y: 120, alignRight: true, flipY: 88 }, 218, 183, 375, 812);
    expect(at.left).toBe(8);
    expect(at.top).toBe(120);
  });
});
