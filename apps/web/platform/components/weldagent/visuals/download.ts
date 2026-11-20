/**
 * Downloads for chat visuals: the data as CSV (every type) and a chart as a
 * PNG. Both are made in the browser from what is on screen; nothing is sent
 * anywhere.
 */

import {
  visualFileName,
  visualToCsv,
  type ChatVisual,
  type VisualCsvHeaders,
} from '@weldsuite/app-api-client/schemas/chat-visuals';

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the download a moment to start before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The visual's data as a CSV file (with a BOM so Excel reads the accents). */
export function downloadVisualCsv(visual: ChatVisual, headers: Partial<VisualCsvHeaders>): void {
  const csv = visualToCsv(visual, headers);
  saveBlob(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }), visualFileName(visual, 'csv'));
}

const PAINT_PROPERTIES = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'fill-opacity', 'stroke-opacity'] as const;
const TEXT_PROPERTIES = ['font-family', 'font-size', 'font-weight'] as const;

/**
 * A standalone copy of a chart's SVG: the theme's CSS variables and classes
 * do not travel with a serialised SVG, so each element gets its computed
 * paint written onto it.
 */
export function inlineSvgStyles(source: SVGSVGElement): SVGSVGElement {
  const copy = source.cloneNode(true) as SVGSVGElement;
  const originals = [source, ...Array.from(source.querySelectorAll('*'))];
  const copies = [copy, ...Array.from(copy.querySelectorAll('*'))];
  originals.forEach((original, i) => {
    const target = copies[i] as SVGElement | undefined;
    if (!target) return;
    const computed = getComputedStyle(original);
    const declarations = PAINT_PROPERTIES.map((property) => `${property}:${computed.getPropertyValue(property)}`);
    if (original.tagName.toLowerCase() === 'text' || original.tagName.toLowerCase() === 'tspan') {
      declarations.push(...TEXT_PROPERTIES.map((property) => `${property}:${computed.getPropertyValue(property)}`));
    }
    target.setAttribute('style', declarations.join(';'));
    target.removeAttribute('class');
  });
  const { width, height } = source.getBoundingClientRect();
  copy.setAttribute('width', String(Math.round(width)));
  copy.setAttribute('height', String(Math.round(height)));
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return copy;
}

/** The first solid background colour at or above `element` (the card or the page behind the chart). */
function backgroundBehind(element: HTMLElement): string {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (color && color !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(color)) return color;
  }
  return '#ffffff';
}

/** The chart inside `container` as a PNG at twice its size, on the background it is shown on. */
export async function downloadChartPng(container: HTMLElement, visual: ChatVisual): Promise<void> {
  const svg = container.querySelector<SVGSVGElement>('svg.recharts-surface');
  if (!svg) return;
  const copy = inlineSvgStyles(svg);
  const width = Number(copy.getAttribute('width')) || 600;
  const height = Number(copy.getAttribute('height')) || 300;
  const markup = new XMLSerializer().serializeToString(copy);
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('The chart could not be drawn'));
      image.src = url;
    });
    const scale = 2;
    const padding = 16;
    const canvas = document.createElement('canvas');
    canvas.width = (width + padding * 2) * scale;
    canvas.height = (height + padding * 2) * scale;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(scale, scale);
    context.fillStyle = backgroundBehind(container);
    context.fillRect(0, 0, width + padding * 2, height + padding * 2);
    context.drawImage(image, padding, padding, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (blob) saveBlob(blob, visualFileName(visual, 'png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
