/**
 * The few Node functions the navigation checker uses to write its files —
 * declared here rather than adding @types/node for one test (the same choice
 * `playwright.config.ts` makes for `process`).
 */
declare module 'node:fs' {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  /** `flag: 'wx'` throws when the file already exists. */
  export function writeFileSync(path: string, data: string, options?: { flag?: string }): void;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function existsSync(path: string): boolean;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare const process: { env: Record<string, string | undefined>; cwd(): string };
