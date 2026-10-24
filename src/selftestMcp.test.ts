/**
 * The Kinema MCP (scripts/mcp/) is never part of what users run. It reaches
 * the app through WebView2's debugging port, which only its launcher opens,
 * and through hooks the page puts up only under an interactive self-test
 * plan. These checks fail if any of that leaks into a normal start: a
 * debugging port or devtools configured in the app itself, the hooks set
 * anywhere else, or the server shipped in the bundle.
 */
import { describe, expect, it } from 'vitest';

// Vite wants the options written out in each call.
const APP_CODE = import.meta.glob(
  ['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}', '/src-tauri/src/**/*.rs'],
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>;
const CONFIGS = import.meta.glob('/src-tauri/tauri*.conf.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const CARGO = import.meta.glob('/src-tauri/Cargo.toml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('the Kinema MCP stays out of normal starts', () => {
  it('opens no debugging port and no devtools from the app itself', () => {
    expect(Object.keys(CONFIGS).length).toBeGreaterThan(0);
    expect(Object.keys(APP_CODE).length).toBeGreaterThan(100);
    for (const [path, text] of Object.entries({ ...CONFIGS, ...APP_CODE })) {
      expect(text, path).not.toMatch(/remote-debugging|WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS/);
    }
    expect(CARGO['/src-tauri/Cargo.toml']).not.toMatch(/"devtools"/);
  });

  it('puts the hooks up only in an interactive self-test', () => {
    const setters = Object.entries(APP_CODE)
      .filter(([, text]) => text.includes('__kinemaSelfTest'))
      .map(([path]) => path);
    expect(setters).toEqual(['/src/selftest.ts']);
    const code = APP_CODE['/src/selftest.ts'];
    // Set inside startInteractive only, which runSelfTest calls for an interactive plan.
    const start = code.indexOf('async function startInteractive');
    const end = code.indexOf('export async function runSelfTest');
    const at = code.indexOf('__kinemaSelfTest =');
    expect(start).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(start);
    expect(at).toBeLessThan(end);
    expect(code).toMatch(/if \(plan\.interactive\) return startInteractive\(plan\);/);
  });

  it('ships none of the server', () => {
    for (const [path, text] of Object.entries(CONFIGS)) {
      expect(text, path).not.toMatch(/scripts[\\/]mcp|kinema-mcp/);
    }
  });
});
