# Third-Party Notices

WeldSuite bundles or links to the following third-party software at runtime.
This file is the central attribution point, module-level NOTICE files (e.g.
`packages/core/df3-noise-suppression/NOTICE.md`) may carry additional detail.

## RNNoise

- Project: https://github.com/xiph/rnnoise
- Authors: Jean-Marc Valin / Xiph.Org Foundation / Mozilla
- License: BSD-3-Clause
- Used in: `packages/core/df3-noise-suppression`, the recurrent-neural-network
  noise-suppression engine. Compiled to WebAssembly and bundled into the
  `rnnoise-worker.js` Web Worker shipped by consuming apps (e.g.
  `apps/web/meeting-portal/public/rnnoise-worker.js`).

## @jitsi/rnnoise-wasm

- Project: https://github.com/jitsi/rnnoise-wasm
- Copyright: 8x8, Inc. / Jitsi
- License: Apache-2.0
- Used in: `packages/core/df3-noise-suppression`, the WebAssembly build of
  RNNoise (above). The wasm is inlined (base64) into the worker; there is no
  separate `.wasm` served.

> Note: the `df3-noise-suppression` package name is legacy. The DeepFilterNet
> (DF3) engine and its `onnxruntime-web` runtime were removed on 2026-05-28;
> RNNoise is now the sole engine. The package and the `df3-worklet-processor.js`
> AudioWorklet (which is first-party, engine-agnostic code) keep the historical
> name deliberately.

## Cloudflare RealtimeKit

- Project: https://www.cloudflare.com/ (RealtimeKit, formerly Dyte)
- License: Proprietary / commercial (closed-source SDK, distributed via npm)
- Used in: WeldMeet real-time audio/video, `apps/web/platform`,
  `apps/web/meeting-portal`, `packages/design/weldmeet-ui`,
  `apps/mobile/weldmeet-app`, `apps/mobile/weldchat-app`.
- Note: this is a proprietary SDK. WeldMeet requires your own Cloudflare
  RealtimeKit account and credentials to function; the SDK is not covered by
  WeldSuite's AGPL license.

## 3D models (WeldStash warehouse visualization)

Used by the Warehouse 3D Map (`apps/web/platform/public/models/`, loaded via
`@react-three/drei`'s `useGLTF`). Both are Sketchfab models under **CC-BY-4.0**;
per-model `license.txt` / `README.md` files are kept alongside each model.

- **"Closed Cardboard Box (Free Download)"** by *sharpened*
  (https://sketchfab.com/sharpened), CC-BY-4.0.
  https://sketchfab.com/3d-models/closed-cardboard-box-free-download-c023cd16986445d880871174d7fe8623
- **"Industrial Storage Rack"** by *siddharthkalbage*
  (https://sketchfab.com/siddharthkalbage), CC-BY-4.0.
  https://sketchfab.com/3d-models/industrial-storage-rack-c21c9a687c3d48ad9e74f894c6d2791c

## Third-party brand logos

Integration and programming-language logos (e.g. Microsoft Teams/Outlook, Zoom,
Google Meet, Hunter.io; Go/Node/PHP/Python/Ruby in the API docs) are the
trademarks of their respective owners and are used nominatively to identify
those products/languages. They are not WeldSuite marks and are not covered by
WeldSuite's AGPL license.

---

If you add a third-party runtime dependency, append it here with the same fields.
