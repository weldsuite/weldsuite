// The X desktop the computer-use tool drives: Xvfb with a window manager,
// started on first use, xdotool for the mouse and keyboard, ImageMagick for
// screenshots. The browser tools' Chromium runs on it too, so the model can
// look at and take over the same browser.

import { spawn } from 'node:child_process';
import fs from 'node:fs';

import { run } from './exec.mjs';
import { BadRequest, bounded } from './util.mjs';

export const DISPLAY = ':99';
export const WIDTH = 1280;
export const HEIGHT = 800;
const SETTLE_MS = 400;
const MAX_TYPE_CHARS = 5000;

/** The `wait` action's pause in ms, from seconds: 1 s unless asked, at most 10 s. */
export function pauseMs(seconds) {
  return bounded(Number(seconds) * 1000, 1000, 0, 10_000);
}

let started = null;
const children = [];

function background(file, args) {
  const child = spawn(file, args, {
    env: { ...process.env, DISPLAY, HOME: process.env.HOME || '/home/sandbox' },
    stdio: 'ignore',
  });
  child.on('error', () => undefined);
  children.push(child);
  return child;
}

async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${what} did not start`);
}

/** Starts the desktop once. */
export function ensureDesktop() {
  started ??= (async () => {
    background('Xvfb', [DISPLAY, '-screen', '0', `${WIDTH}x${HEIGHT}x24`, '-nolisten', 'tcp', '-ac']);
    await waitFor(() => fs.existsSync(`/tmp/.X11-unix/X${DISPLAY.slice(1)}`), 10_000, 'The desktop');
    background('openbox', []);
  })().catch((error) => {
    started = null;
    throw error;
  });
  return started;
}

/** Stops the desktop (the agent is going away). */
export function stopDesktop() {
  for (const child of children.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // gone
    }
  }
  started = null;
}

function xdotool(args) {
  return run('xdotool', args, { cwd: '/tmp', timeoutMs: 15_000, env: { DISPLAY } });
}

/** A PNG of the whole screen, base64. */
export async function screenshot() {
  await ensureDesktop();
  const shot = await new Promise((resolve, reject) => {
    const child = spawn('import', ['-silent', '-window', 'root', '-display', DISPLAY, 'png:-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('The screenshot failed'))));
  });
  return { mime: 'image/png', base64: shot.toString('base64') };
}

function point(value, name) {
  if (!Array.isArray(value) || value.length !== 2) throw new BadRequest(`${name} must be [x, y]`);
  const [x, y] = value.map(Number);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) {
    throw new BadRequest(`${name} must be inside the ${WIDTH}x${HEIGHT} screen`);
  }
  return [String(x), String(y)];
}

async function cursor() {
  const result = await xdotool(['getmouselocation', '--shell']);
  const x = Number(result.stdout.match(/X=(\d+)/)?.[1] ?? 0);
  const y = Number(result.stdout.match(/Y=(\d+)/)?.[1] ?? 0);
  return [x, y];
}

const BUTTONS = { left_click: '1', middle_click: '2', right_click: '3', double_click: '1', triple_click: '1' };
const SCROLL = { up: '4', down: '5', left: '6', right: '7' };

/** The xdotool arguments for one action, or null for what needs none. */
export function plan(body) {
  const action = String(body.action ?? '');
  const move = body.coordinate == null ? [] : [['mousemove', '--sync', ...point(body.coordinate, 'coordinate')]];
  switch (action) {
    case 'screenshot':
    case 'cursor_position':
      return [];
    case 'wait':
      return null;
    case 'mouse_move':
      if (body.coordinate == null) throw new BadRequest('coordinate is required for mouse_move');
      return move;
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click': {
      const repeat = action === 'double_click' ? '2' : action === 'triple_click' ? '3' : '1';
      return [...move, ['click', '--repeat', repeat, '--delay', '80', BUTTONS[action]]];
    }
    case 'left_click_drag': {
      if (body.coordinate == null) throw new BadRequest('coordinate is required for left_click_drag');
      const start = body.startCoordinate == null ? [] : [['mousemove', '--sync', ...point(body.startCoordinate, 'startCoordinate')]];
      return [...start, ['mousedown', '1'], ...move, ['mouseup', '1']];
    }
    case 'type': {
      const text = String(body.text ?? '');
      if (!text || text.length > MAX_TYPE_CHARS) throw new BadRequest(`text is required for type (at most ${MAX_TYPE_CHARS} characters)`);
      return [['type', '--delay', '12', '--', text]];
    }
    case 'key': {
      const keys = String(body.text ?? '').trim().split(/\s+/).filter(Boolean);
      if (keys.length === 0 || keys.length > 20 || keys.some((k) => !/^[A-Za-z0-9_+]{1,40}$/.test(k))) {
        throw new BadRequest('text must name keys in xdotool form, such as Return, ctrl+l or alt+Tab');
      }
      return [['key', '--delay', '50', '--', ...keys]];
    }
    case 'scroll': {
      const direction = SCROLL[String(body.scrollDirection ?? 'down')];
      if (!direction) throw new BadRequest('scrollDirection must be up, down, left or right');
      const amount = String(Math.min(Math.max(Number(body.scrollAmount) || 3, 1), 20));
      return [...move, ['click', '--repeat', amount, '--delay', '30', direction]];
    }
    default:
      throw new BadRequest(`Unknown action: ${action}`);
  }
}

/** `POST /v1/desktop`: one action, then the screen as it is after it. */
export async function desktop(body) {
  const steps = plan(body);
  await ensureDesktop();
  if (steps === null) {
    await new Promise((resolve) => setTimeout(resolve, pauseMs(body.durationSeconds)));
  } else {
    for (const args of steps) {
      const result = await xdotool(args);
      if (result.exitCode !== 0) throw new Error(`xdotool ${args[0]} failed: ${result.stderr.slice(0, 200)}`);
    }
    if (steps.length > 0) await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  }
  const out = { ok: true, action: body.action, cursor: await cursor() };
  if (body.action !== 'cursor_position') out.screenshot = await screenshot();
  return out;
}
