/**
 * The expected answer for the navigation checker: e2e/navmap.expected.json.
 *
 * Per system, per screen, per control (by its visible label): where each arrow
 * goes. Names, not focus keys, because keys like `sn:focusable-item-15` change
 * from run to run. Hand-editable; `NAV_APPROVE=1 npm run test:nav` rewrites it
 * from a run, and `node e2e/navmapExpected.ts` builds it from navmap-results/.
 *
 * Only erasable TypeScript here (no enums), so Node can run this file itself.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LeafInfo, ScreenResult, SystemResult } from './navmapTypes';

/** Focus stays where it is. */
export const STAY = '·';
/** Nothing has focus afterwards. */
export const NONE = '∅';

export const EXPECTED_FILE = join(process.cwd(), 'e2e', 'navmap.expected.json');
const KEYS = ['U', 'D', 'L', 'R'] as const;
type ArrowKey = (typeof KEYS)[number];
const ARROW_OF: Record<string, ArrowKey> = { ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R' };
const GLYPH: Record<ArrowKey, string> = { U: '↑', D: '↓', L: '←', R: '→' };

export type ControlMoves = Partial<Record<ArrowKey, string>>;
export type ScreenMoves = Record<string, ControlMoves>;
/** system → screen id → control name → moves. */
export type Expected = Record<string, Record<string, ScreenMoves>>;

/** What a run is allowed to cover (NAV_ONLY / NAV_SYSTEMS). */
export interface Filter {
  only: RegExp | null;
  systems: string[] | null;
}

/** Visible names, with duplicates told apart by order on screen ("Mark watched #2"). */
export function leafNames(leaves: LeafInfo[]): Map<string, string> {
  const out = new Map<string, string>();
  const byLabel = new Map<string, LeafInfo[]>();
  for (const l of leaves) {
    const label = l.label === l.key ? '(unlabelled control)' : l.label;
    byLabel.set(label, [...(byLabel.get(label) ?? []), l]);
  }
  for (const [label, list] of byLabel) {
    const ordered = [...list].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    ordered.forEach((l, i) => out.set(l.key, ordered.length > 1 ? `${label} #${i + 1}` : label));
  }
  return out;
}

/** One screen's moves, as the expected file holds them. */
export function screenMoves(s: ScreenResult): ScreenMoves {
  const names = leafNames(s.leaves);
  const out: ScreenMoves = {};
  const ordered = [...s.leaves].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  for (const l of ordered) {
    if (!s.moves.some((m) => m.from === l.key)) continue;
    const entry: ControlMoves = {};
    for (const m of s.moves.filter((x) => x.from === l.key)) {
      const k = ARROW_OF[m.dir];
      entry[k] = m.flags.includes('focus-lost')
        ? NONE
        : m.to === m.from
          ? STAY
          : (names.get(m.to) ?? m.toLabel);
    }
    out[names.get(l.key) ?? l.label] = entry;
  }
  return out;
}

export function fromSystem(r: SystemResult): Record<string, ScreenMoves> {
  const out: Record<string, ScreenMoves> = {};
  for (const s of r.screens) if (s.how !== 'skipped' && s.moves.length > 0) out[s.id] = screenMoves(s);
  return out;
}

export function readExpected(): Expected {
  return existsSync(EXPECTED_FILE) ? (JSON.parse(readFileSync(EXPECTED_FILE, 'utf8')) as Expected) : {};
}

/** One line per control, so a move is a one-line edit and a diff is readable. */
export function writeExpected(e: Expected): void {
  const q = JSON.stringify;
  const lines: string[] = ['{'];
  const systems = Object.keys(e);
  systems.forEach((sys, si) => {
    lines.push(`  ${q(sys)}: {`);
    const screens = Object.keys(e[sys]);
    screens.forEach((id, ci) => {
      lines.push(`    ${q(id)}: {`);
      const controls = Object.keys(e[sys][id]);
      controls.forEach((c, i) => {
        const m = e[sys][id][c];
        const body = KEYS.filter((k) => m[k] !== undefined)
          .map((k) => `${q(k)}: ${q(m[k])}`)
          .join(', ');
        lines.push(`      ${q(c)}: { ${body} }${i < controls.length - 1 ? ',' : ''}`);
      });
      lines.push(`    }${ci < screens.length - 1 ? ',' : ''}`);
    });
    lines.push(`  }${si < systems.length - 1 ? ',' : ''}`);
  });
  lines.push('}', '');
  writeFileSync(EXPECTED_FILE, lines.join('\n'));
}

/** Put what ran into the expected file, keeping the rest. Returns how many screens were written. */
export function approve(results: SystemResult[], filter: Filter): number {
  const e = readExpected();
  let n = 0;
  for (const r of results) {
    if (filter.systems && !filter.systems.includes(r.system)) continue;
    const mine = fromSystem(r);
    e[r.system] ??= {};
    for (const id of Object.keys(mine)) {
      if (filter.only && !filter.only.test(id)) continue;
      e[r.system][id] = mine[id];
      n++;
    }
  }
  writeExpected(e);
  return n;
}

/** The differences between the expected file and one engine's results, as plain lines. */
export function compare(expected: Expected, results: SystemResult[], filter: Filter, engine: string): string[] {
  const diffs: string[] = [];
  for (const r of results) {
    if (filter.systems && !filter.systems.includes(r.system)) continue;
    const want = expected[r.system] ?? {};
    const got = fromSystem(r);
    const ids = new Set([...Object.keys(want), ...Object.keys(got)]);
    for (const id of ids) {
      if (filter.only && !filter.only.test(id)) continue;
      const where = `${r.system} · ${id}`;
      if (!got[id]) {
        if (want[id]) diffs.push(`${where}: expected screen was not walked (${engine})`);
        continue;
      }
      if (!want[id]) {
        diffs.push(`${where}: new screen, not in the expected file (${engine})`);
        continue;
      }
      const controls = new Set([...Object.keys(want[id]), ...Object.keys(got[id])]);
      for (const c of controls) {
        const w = want[id][c];
        const g = got[id][c];
        if (!g) {
          diffs.push(`${where} · ${c}: control expected but not found (${engine})`);
          continue;
        }
        if (!w) {
          diffs.push(`${where} · ${c}: new control, not in the expected file (${engine})`);
          continue;
        }
        for (const k of KEYS) {
          if (w[k] !== g[k]) diffs.push(`${where} · ${c} · ${GLYPH[k]}: expected ${w[k] ?? 'nothing'}, got ${g[k] ?? 'nothing'} (${engine})`);
        }
      }
    }
  }
  return diffs;
}

// Run directly (`node e2e/navmapExpected.ts`): build the file from navmap-results/, Edge first, WebKit where Edge has none.
const entry = (process as unknown as { argv: string[] }).argv[1] ?? '';
if (entry.replace(/\\/g, '/').endsWith('e2e/navmapExpected.ts')) {
  const dir = join(process.cwd(), 'navmap-results');
  const e: Expected = {};
  for (const sys of ['windows', 'linux', 'android']) {
    const read = (eng: string) => {
      const f = join(dir, `${eng}.${sys}.json`);
      return existsSync(f) ? fromSystem(JSON.parse(readFileSync(f, 'utf8')) as SystemResult) : null;
    };
    const edge = read('edge');
    const webkit = read('webkit');
    const base = edge ?? webkit;
    if (!base) continue;
    e[sys] = base;
    if (edge && webkit) {
      for (const d of compare({ [sys]: edge }, [JSON.parse(readFileSync(join(dir, `webkit.${sys}.json`), 'utf8')) as SystemResult], { only: null, systems: null }, 'webkit')) {
        console.log(`WebKit differs from Edge: ${d}`);
      }
    }
  }
  writeExpected(e);
  console.log(`wrote ${EXPECTED_FILE}`);
}
