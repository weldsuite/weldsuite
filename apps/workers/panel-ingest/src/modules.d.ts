/**
 * The browser SDK bundle (`pnpm --filter @weldsuite/panel-sdk build`), imported
 * as a string: wrangler.toml has a `[[rules]] type = "Text"` rule for
 * `**\/*.global.js`, and vitest aliases it to a stub.
 */
declare module '@weldsuite/panel-sdk/dist/panel.global.js' {
  const source: string;
  export default source;
}
