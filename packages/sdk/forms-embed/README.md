# @weldsuite/forms-embed

Show a WeldForms form on any website. MIT licensed.

```html
<div data-wf="<publicId>" data-wf-mode="inline" data-wf-hidden="source=pricing"></div>
<script async src="https://forms.weldsuite.org/embed.js"></script>
```

Attributes: see `src/auto.ts` (`data-wf-mode` inline|popup|slider|popover|fullpage,
`data-wf-hidden`, `data-wf-size`, `data-wf-open` click|load|exit|scroll:N,
`data-wf-height` auto|px, `data-wf-button-color`, `data-wf-hide-after-submit`, ...).

JavaScript: `createWidget`, `createPopup`, `createSlider`, `createPopover`,
`createFullPage` (`src/index.ts`), with `onReady`, `onSubmit`, `onClose`, `onRedirect`.

`pnpm build` writes `dist/embed.js` (one IIFE, `window.WeldForms`). forms-portal
serves the same bundle at `/embed.js`, built from this source at its own build time.
The message protocol with the portal's embed view is `src/protocol.ts`: change both together.
