/** Stands in for the built SDK bundle (`@weldsuite/panel-sdk/dist/panel.global.js`) under vitest. */
const stubBundle = '/* panel-sdk test bundle */\n(function () { window.__panelStub = true; })();\n';

export default stubBundle;
