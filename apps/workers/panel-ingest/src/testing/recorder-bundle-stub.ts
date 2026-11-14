/** Stands in for the built recorder bundle (`@weldsuite/panel-sdk/dist/panel-recorder.global.js`) under vitest. */
const stubBundle = '/* panel-recorder test bundle */\n(function () { window.__panelRecorderStub = true; })();\n';

export default stubBundle;
