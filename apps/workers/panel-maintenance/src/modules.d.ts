/** Node's built-in SQLite, which the tests run the ledger on (the installed @types/node predates it). */
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      all(...bindings: (string | number | null)[]): unknown[];
      run(...bindings: (string | number | null)[]): { changes: number | bigint };
    };
  }
}
