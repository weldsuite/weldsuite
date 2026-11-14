/**
 * The browser SDK bundle (`pnpm --filter @weldsuite/panel-sdk build`), imported
 * as a string: wrangler.toml has a `[[rules]] type = "Text"` rule for
 * `**\/*.global.js`, and vitest aliases it to a stub.
 */
declare module '@weldsuite/panel-sdk/dist/panel.global.js' {
  const source: string;
  export default source;
}

/** The recording plugin bundle `GET /rec.js` serves, built the same way. */
declare module '@weldsuite/panel-sdk/dist/panel-recorder.global.js' {
  const source: string;
  export default source;
}

/** Node's built-in SQLite, which the tests run the PanelProject object on (the installed @types/node predates it). */

declare module 'node:sqlite' {

  export class DatabaseSync {

    constructor(path: string);

    exec(sql: string): void;

    prepare(sql: string): { all(...bindings: (string | number | null)[]): unknown[] };

  }

}
