"use client";

import React from 'react';
import {
  WELDFORMS_PORTAL_URL,
  embedAttributes,
  embedScriptUrl,
  isEmbedMode,
  usesElementAsTrigger,
  type WeldFormsHiddenField,
} from '../lib/weldforms-embed';

export interface WeldFormsFormBlockProps {
  /** The form's public id (the part after `/f/` in its link). */
  publicId?: string;
  /**
   * inline | popup | slider | popover | fullpage. Named `embedMode` because the
   * renderer passes its own `mode` (edit or live) to every block.
   */
  embedMode?: string;
  /** `auto`, or a height in pixels. */
  height?: string | number;
  /** Trigger text of a popup or slider, label of a popover's button. */
  buttonText?: string;
  buttonColor?: string;
  hiddenFields?: WeldFormsHiddenField[];
  portalUrl?: string;
  /** The renderer's edit or live mode. */
  mode?: string;
  /** The block's settings, when the renderer passes them as one object. */
  settings?: Record<string, unknown>;
}

const SCRIPT_MARK = 'data-weldforms-embed';

/** Loads `<portal>/embed.js` once per page; it starts every `[data-wf]` element, also ones added later. */
function useEmbedScript(portalUrl: string | undefined, enabled: boolean) {
  React.useEffect(() => {
    if (!enabled) return;
    const src = embedScriptUrl(portalUrl);
    const existing = document.querySelector<HTMLScriptElement>(`script[${SCRIPT_MARK}]`);
    if (existing) return;
    const script = document.createElement('script');
    script.async = true;
    script.src = src;
    script.setAttribute(SCRIPT_MARK, '');
    document.body.appendChild(script);
  }, [portalUrl, enabled]);
}

export function WeldFormsFormBlock(props: Readonly<WeldFormsFormBlockProps>) {
  const settings = props.settings ?? {};
  const pick = <K extends keyof WeldFormsFormBlockProps>(key: K) =>
    (props[key] ?? settings[key]) as WeldFormsFormBlockProps[K];

  const publicId = pick('publicId');
  const embedMode = pick('embedMode');
  const buttonText = pick('buttonText');
  const buttonColor = pick('buttonColor');
  const portalUrl = pick('portalUrl') ?? WELDFORMS_PORTAL_URL;
  const editing = props.mode === 'edit';

  const attrs = embedAttributes({
    publicId,
    embedMode,
    height: pick('height'),
    buttonText,
    buttonColor,
    hiddenFields: pick('hiddenFields'),
    portalUrl,
  });

  // The editor shows a placeholder: no iframe and no script while a page is being edited.
  useEmbedScript(portalUrl, !editing && attrs !== null);

  if (!attrs) {
    return (
      <div className="w-full rounded-md border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-gray-500">
        {editing ? 'WeldForms form: choose a form in the settings.' : null}
      </div>
    );
  }

  if (editing) {
    return (
      <div className="w-full rounded-md border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center text-sm text-gray-600">
        WeldForms form {publicId} ({isEmbedMode(embedMode) ? embedMode : 'inline'})
      </div>
    );
  }

  if (usesElementAsTrigger(attrs['data-wf-mode'])) {
    return (
      <button
        type="button"
        {...attrs}
        className="inline-flex items-center justify-center rounded-md px-5 py-2.5 text-sm font-medium text-white"
        style={{ backgroundColor: buttonColor?.trim() || '#111827' }}
        suppressHydrationWarning
      >
        {buttonText?.trim() || 'Open form'}
      </button>
    );
  }

  // The embed script fills this element (inline, full page) or adds its own button (popover).
  return <div {...attrs} className="w-full" suppressHydrationWarning />;
}
