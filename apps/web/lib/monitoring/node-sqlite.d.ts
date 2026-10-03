/**
 * Minimal ambient type declaration for Node's built-in `node:sqlite` module.
 *
 * The repo pins `@types/node@^20`, which predates `node:sqlite` (Node 22.5+),
 * so the import would otherwise fail typecheck. The box runs Node v26, where
 * the module is stable and built-in — no native compilation needed.
 */

declare module "node:sqlite" {
  export class StatementSync {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  export class DatabaseSync {
    constructor(path: string, options?: Record<string, unknown>);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
