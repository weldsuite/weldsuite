/** Stands in for the built web vitals bundle (`@weldsuite/panel-sdk/dist/panel-vitals.global.js`) under vitest. */
const stubBundle = '/* panel-vitals test bundle */\n(function () { window.__panelVitalsStub = true; })();\n';

export default stubBundle;
