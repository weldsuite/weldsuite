/**
 * TASK-699: when the host mutes someone, the viewer's own "muted for me" marker
 * on that participant must not disappear. Both icons show side by side.
 */

import { test, expect } from '@playwright/experimental-ct-react';
import { ParticipantNameTag } from '../src/components/participant-name-tag';

test.describe('ParticipantNameTag · muted states', () => {
  test('mic muted by the host: the mic-off icon shows', async ({ mount }) => {
    const comp = await mount(<ParticipantNameTag name="Alice" audioEnabled={false} />);
    await expect(comp.locator('svg.lucide-mic-off')).toHaveCount(1);
    await expect(comp.locator('svg.lucide-volume-x')).toHaveCount(0);
  });

  test('muted for me while the mic is on: the volume-off icon shows', async ({ mount }) => {
    const comp = await mount(<ParticipantNameTag name="Alice" audioEnabled localMuted />);
    await expect(comp.locator('svg.lucide-volume-x')).toHaveCount(1);
  });

  test('muted for me stays visible after the host mutes the mic', async ({ mount }) => {
    const comp = await mount(<ParticipantNameTag name="Alice" audioEnabled={false} localMuted />);
    await expect(comp.locator('svg.lucide-mic-off')).toHaveCount(1);
    await expect(comp.locator('svg.lucide-volume-x')).toHaveCount(1);
  });
});
