/**
 * Component tests for the meeting tools: timer, Q&A, polls, breakout rooms,
 * transcript, caption translation and live streaming.
 *
 * The harness puts a host (Ada) and a guest (Ben) in one fake room, each with
 * their own Meeting tools panel driven by the real controller and store, so
 * these cover what cannot be reached without a live RealtimeKit session: that
 * one person's action shows up for the other, that someone who joins later
 * catches up, and that host-only actions stay with the host.
 */

import { test, expect } from '@playwright/experimental-ct-react';
import { ToolsHarness } from './harness/tools-harness';

test.describe('Meeting tools', () => {
  test('every tool is available; nothing is "Coming soon"', async ({ mount }) => {
    const comp = await mount(<ToolsHarness />);
    const host = comp.getByTestId('peer-ada');
    const guest = comp.getByTestId('peer-ben');

    for (const name of [/^Speech translation/, /^Timer/, /^Transcribe/, /^Breakout rooms/, /^Polls/, /^Q&A/]) {
      await expect(host.getByRole('button', { name })).toBeEnabled();
      await expect(guest.getByRole('button', { name })).toBeEnabled();
    }
    await expect(comp.getByText('Coming soon')).toHaveCount(0);

    // Recording and live streaming are the host's.
    await expect(host.getByRole('button', { name: /^Record/ })).toBeEnabled();
    await expect(guest.getByRole('button', { name: /^Record/ })).toBeDisabled();
    await expect(guest.getByText('Host only')).toBeVisible();
    await expect(host.getByRole('button', { name: /^Live streaming/ })).toBeEnabled();
    await expect(guest.getByRole('button', { name: /^Live streaming/ })).toHaveCount(0);
  });

  test('timer: the host starts a countdown and everyone sees it', async ({ mount }) => {
    const comp = await mount(<ToolsHarness />);
    const host = comp.getByTestId('peer-ada');
    const guest = comp.getByTestId('peer-ben');

    await host.getByRole('button', { name: /^Timer/ }).click();
    await host.getByRole('button', { name: '10 min' }).click();
    await host.getByRole('button', { name: 'Start timer' }).click();

    // The guest gets the countdown on the stage and on the Timer row.
    await expect(guest.getByRole('timer').first()).toContainText(/^(10:00|9:5\d)/);
    await expect(guest.getByRole('button', { name: /^Timer.*remaining/ })).toBeVisible();

    // The guest can look, but not control.
    await guest.getByRole('button', { name: /^Timer/ }).click();
    await expect(guest.getByRole('button', { name: 'Stop' })).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Pause' })).toHaveCount(0);

    await host.getByRole('button', { name: 'Pause' }).click();
    await expect(guest.getByText('Paused').first()).toBeVisible();

    await host.getByRole('button', { name: 'Stop' }).click();
    await expect(guest.getByRole('timer')).toHaveCount(0);
  });

  test('Q&A: a guest asks, the host upvotes and marks it answered', async ({ mount }) => {
    const comp = await mount(<ToolsHarness />);
    const host = comp.getByTestId('peer-ada');
    const guest = comp.getByTestId('peer-ben');

    await guest.getByRole('button', { name: /^Q&A/ }).click();
    await guest.getByRole('textbox', { name: 'Ask a question' }).fill('When do we ship?');
    await guest.getByRole('button', { name: 'Ask', exact: true }).click();

    // The host sees it on the list row before opening the tool.
    await expect(host.getByRole('button', { name: /Open questions: 1/ })).toBeVisible();
    await host.getByRole('button', { name: /^Q&A/ }).click();
    await expect(host.getByText('When do we ship?')).toBeVisible();
    await expect(host.getByText('Asked by Ben')).toBeVisible();

    await host.getByRole('button', { name: 'Upvote' }).click();
    await expect(guest.getByRole('button', { name: 'Upvote' })).toHaveText('1');

    // Only the host moderates; the guest may still remove their own question.
    await expect(guest.getByRole('button', { name: 'Mark as answered' })).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Remove' })).toBeVisible();
    await host.getByRole('button', { name: 'Mark as answered' }).click();
    await expect(guest.getByText('Answered')).toBeVisible();

    await guest.getByRole('button', { name: 'Remove' }).click();
    await expect(host.getByText('When do we ship?')).toHaveCount(0);
  });

  test('polls: the host starts a poll, the guest votes, both see the result', async ({ mount }) => {
    const comp = await mount(<ToolsHarness />);
    const host = comp.getByTestId('peer-ada');
    const guest = comp.getByTestId('peer-ben');

    await guest.getByRole('button', { name: /^Polls/ }).click();
    await expect(guest.getByRole('button', { name: 'New poll' })).toHaveCount(0);

    await host.getByRole('button', { name: /^Polls/ }).click();
    await host.getByRole('button', { name: 'New poll' }).click();
    await host.getByRole('textbox', { name: 'Question' }).fill('Coffee or tea?');
    await host.getByRole('textbox', { name: 'Option 1' }).fill('Coffee');
    await host.getByRole('textbox', { name: 'Option 2' }).fill('Tea');
    await host.getByRole('button', { name: 'Start poll' }).click();

    await expect(guest.getByText('Coffee or tea?')).toBeVisible();
    await guest.getByRole('button', { name: 'Tea' }).click();

    await expect(guest.getByText('1 · 100%')).toBeVisible();
    await expect(host.getByText('Votes: 1')).toBeVisible();
    // One vote per person.
    await expect(guest.getByRole('button', { name: /Coffee/ })).toBeDisabled();
  });

  test('breakout rooms: people only share the stage with their own room', async ({ mount }) => {
    const comp = await mount(<ToolsHarness />);
    const host = comp.getByTestId('peer-ada');
    const guest = comp.getByTestId('peer-ben');

    await expect(guest.getByTestId('stage')).toHaveText('Ben, Ada');

    await host.getByRole('button', { name: /^Breakout rooms/ }).click();
    await host.getByRole('button', { name: 'Assign automatically' }).click();
    await host.getByRole('button', { name: 'Open rooms' }).click();

    // Ben was dealt into a room; the host stays in the main room.
    await expect(guest.getByTestId('stage')).toHaveText('Ben');
    await expect(host.getByTestId('stage')).toHaveText('Ada');
    await expect(guest.getByText('Breakout: Room 1')).toBeVisible();
    await expect(host.getByText('Breakout: Main room')).toBeVisible();

    // The guest cannot manage rooms, only leave theirs.
    await guest.getByRole('button', { name: /^Breakout rooms/ }).click();
    await expect(guest.getByRole('button', { name: 'Close rooms' })).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Return to main room' })).toBeVisible();

    // The host drops in.
    await host.getByRole('button', { name: 'Join' }).first().click();
    await expect(guest.getByTestId('stage')).toHaveText('Ben, Ada');
    await expect(host.getByTestId('stage')).toHaveText('Ada, Ben');

    await host.getByRole('button', { name: 'Close rooms' }).click();
    await expect(guest.getByText(/^Breakout:/)).toHaveCount(0);
    await expect(guest.getByTestId('stage')).toHaveText('Ben, Ada');
  });

  test('someone who joins later catches up on the timer, the questions and the rooms', async ({ mount }) => {
    const comp = await mount(<ToolsHarness />);
    const host = comp.getByTestId('peer-ada');
    const guest = comp.getByTestId('peer-ben');

    await host.getByRole('button', { name: /^Timer/ }).click();
    await host.getByRole('button', { name: 'Start timer' }).click();
    await guest.getByRole('button', { name: /^Q&A/ }).click();
    await guest.getByRole('textbox', { name: 'Ask a question' }).fill('Is this recorded?');
    await guest.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(host.getByRole('timer').first()).toBeVisible();
    await host.getByRole('button', { name: 'Back to meeting tools' }).click();
    await host.getByRole('button', { name: /^Breakout rooms/ }).click();
    await host.getByRole('button', { name: 'Assign automatically' }).click();
    await host.getByRole('button', { name: 'Open rooms' }).click();
    await expect(guest.getByText('Breakout: Room 1')).toBeVisible();

    await comp.getByRole('button', { name: 'Add late joiner' }).click();
    const late = comp.getByTestId('peer-cy');

    await expect(late.getByRole('timer')).toContainText(/^4:\d\d/);
    await expect(late.getByRole('button', { name: /Open questions: 1/ })).toBeVisible();
    // Nobody assigned Cy yet, so they wait in the main room with the host, not with Ben.
    await expect(late.getByText('Breakout: Main room')).toBeVisible();
    await expect(late.getByTestId('stage')).toHaveText('Cy, Ada');
  });

  test('transcript and captions, translated on the device', async ({ mount }) => {
    const comp = await mount(<ToolsHarness fakeTranslator />);
    const guest = comp.getByTestId('peer-ben');

    await comp.getByRole('button', { name: 'Ada speaks' }).click();

    await guest.getByRole('button', { name: /^Transcribe/ }).click();
    await expect(guest.getByText('Hello everyone')).toBeVisible();
    await expect(guest.getByRole('button', { name: 'Download' })).toBeEnabled();

    await guest.getByRole('switch', { name: 'Show captions' }).click();
    await expect(guest.getByTestId('captions')).toHaveText('Hello everyone');

    // Translate into another language (the stand-in translator upper-cases).
    await guest.getByRole('button', { name: 'Back to meeting tools' }).click();
    await guest.getByRole('button', { name: /^Speech translation/ }).click();
    await guest.getByLabel('Translate to').selectOption('nl');
    await guest.getByRole('switch', { name: 'Translate captions' }).click();

    await expect(guest.getByRole('status')).toContainText('Captions are translated to');
    await expect(guest.getByTestId('captions')).toHaveText('HELLO EVERYONE');
    // Private to the viewer: nobody else's captions changed (or even turned on).
    await expect(comp.getByTestId('peer-ada').getByTestId('captions')).toHaveCount(0);
  });

  test('live streaming: the host goes live and everyone can tell', async ({ mount }) => {
    const comp = await mount(<ToolsHarness />);
    const host = comp.getByTestId('peer-ada');
    const guest = comp.getByTestId('peer-ben');

    await host.getByRole('button', { name: /^Live streaming/ }).click();
    await host.getByRole('button', { name: 'Go live' }).click();

    await expect(host.getByText('Viewers: 3')).toBeVisible();
    // Viewers get the hosted player, not the raw HLS manifest.
    await expect(host.getByRole('link')).toHaveAttribute(
      'href',
      'https://customer-abc123.cloudflarestream.com/0f1e2d3c/watch',
    );

    // Everyone in the meeting sees that it is being streamed.
    await expect(guest.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
    await expect(guest.getByRole('button', { name: /^Live streaming.*Live now/ })).toBeVisible();

    await host.getByRole('button', { name: 'Stop streaming' }).click();
    await expect(guest.getByRole('button', { name: /^Live streaming/ })).toHaveCount(0);
  });
});
