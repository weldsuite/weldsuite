import { boardToPdf } from '@weldsuite/board-engine';
import type { ExportContext } from './export';

/** The board (or one page per frame) as a vector PDF, images fetched with the member's session. Loaded on demand. */
export async function boardPdf(ctx: ExportContext, perFrame: boolean): Promise<Uint8Array | null> {
  const c = ctx.controller;
  return boardToPdf(c.board, {
    title: ctx.name,
    perFrame,
    display: { name: (id) => c.names.get(id) ?? null, showAuthors: c.showAuthors },
    images: async (src) => {
      const url = await ctx.loadImage(src).catch(() => null);
      if (!url) return null;
      try {
        const res = await fetch(url);
        return res.ok ? { bytes: new Uint8Array(await res.arrayBuffer()) } : null;
      } catch {
        return null;
      }
    },
  });
}
