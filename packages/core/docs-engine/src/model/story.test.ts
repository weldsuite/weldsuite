import { describe, expect, it } from 'vitest';
import { rng } from '../test-support';
import { OBJECT, PARA } from './chars';
import { Story, type Attr } from './story';

/** A plain reference implementation: one string, one array of style ids, one map of attrs. */
class Reference {
  text = '';
  styles: number[] = [];
  attrs = new Map<number, Attr>();

  insert(pos: number, text: string, style: number, attrs: Map<number, Attr>) {
    this.text = this.text.slice(0, pos) + text + this.text.slice(pos);
    this.styles.splice(pos, 0, ...new Array<number>(text.length).fill(style));
    const next = new Map<number, Attr>();
    for (const [o, a] of this.attrs) next.set(o >= pos ? o + text.length : o, a);
    for (const [o, a] of attrs) next.set(pos + o, a);
    this.attrs = next;
  }

  remove(from: number, to: number) {
    this.text = this.text.slice(0, from) + this.text.slice(to);
    this.styles.splice(from, to - from);
    const next = new Map<number, Attr>();
    for (const [o, a] of this.attrs) {
      if (o < from) next.set(o, a);
      else if (o >= to) next.set(o - (to - from), a);
    }
    this.attrs = next;
  }
}

describe('Story', () => {
  it('matches a plain string through thousands of random edits across many chunks', () => {
    const random = rng(7);
    const story = new Story('body');
    const ref = new Reference();
    for (let step = 0; step < 3000; step++) {
      const len = ref.text.length;
      if (len > 0 && random() < 0.35) {
        const from = Math.floor(random() * len);
        const to = Math.min(len, from + 1 + Math.floor(random() * (random() < 0.1 ? 3000 : 40)));
        const removed = story.remove(from, to);
        expect(removed.text).toBe(ref.text.slice(from, to));
        ref.remove(from, to);
      } else {
        const pos = Math.floor(random() * (len + 1));
        const size = 1 + Math.floor(random() * (random() < 0.1 ? 2500 : 30));
        let text = '';
        const attrs = new Map<number, Attr>();
        for (let i = 0; i < size; i++) {
          const r = random();
          if (r < 0.05) {
            attrs.set(i, { align: 'center' });
            text += PARA;
          } else if (r < 0.07) {
            attrs.set(i, { kind: 'hr' });
            text += OBJECT;
          } else text += String.fromCharCode(97 + Math.floor(random() * 26));
        }
        const style = Math.floor(random() * 5);
        story.insert(pos, { text, styles: new Array<number>(text.length).fill(style), attrs });
        ref.insert(pos, text, style, attrs);
      }
      if (step % 50 === 0) {
        expect(story).toHaveLength(ref.text.length);
        expect(story.text()).toBe(ref.text);
      }
    }
    expect(story.text()).toBe(ref.text);
    for (let i = 0; i < ref.text.length; i += 7) {
      expect(story.charAt(i)).toBe(ref.text[i]);
      expect(story.styleAt(i)).toBe(ref.styles[i]);
      expect(story.attrAt(i)).toBe(ref.attrs.get(i));
    }
    const seen: number[] = [];
    story.forEachAttr(0, story.length, (p) => seen.push(p));
    expect(seen).toEqual([...ref.attrs.keys()].sort((a, b) => a - b));
  });

  it('finds characters forwards and backwards across chunks', () => {
    const story = new Story('body');
    const text = 'x'.repeat(5000) + PARA + 'y'.repeat(3000) + PARA;
    story.insert(0, { text, styles: new Array<number>(text.length).fill(0), attrs: new Map() });
    expect(story.indexOf(PARA)).toBe(5000);
    expect(story.indexOf(PARA, 5001)).toBe(8001);
    expect(story.lastIndexOf(PARA, 8000)).toBe(5000);
    expect(story.lastIndexOf(PARA)).toBe(8001);
    expect(story.lastIndexOf(PARA, 4999)).toBe(-1);
  });

  it('reports runs of equal style', () => {
    const story = new Story('body');
    story.insert(0, { text: 'aabbbc', styles: [1, 1, 2, 2, 2, 1], attrs: new Map() });
    const runs: [number, number, number][] = [];
    story.forEachRun(0, 6, (s, e, id) => runs.push([s, e, id]));
    expect(runs).toEqual([
      [0, 2, 1],
      [2, 5, 2],
      [5, 6, 1],
    ]);
  });

  it('never splits a surrogate pair across chunks', () => {
    const story = new Story('body');
    const text = '😀'.repeat(2000);
    story.insert(0, { text, styles: new Array<number>(text.length).fill(0), attrs: new Map() });
    expect(story.text()).toBe(text);
    expect(story.text(1023, 1025)).toBe(text.slice(1023, 1025));
  });
});
