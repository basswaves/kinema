/**
 * Turns what the navigation checker recorded into navmap.json and a map in
 * plain words (NAV-MAP.generated.md). Plain text in, plain text out: nothing
 * here touches a browser.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Dir, LeafInfo, Move, ScreenResult, SystemResult } from './navmapTypes';

const ENGINES = ['edge', 'webkit'];
const SYSTEM_TITLE: Record<string, string> = { windows: 'Windows', linux: 'Linux', android: 'Android' };
const DIR_WORD: Record<Dir, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};

export function writeReports(
  dir: string,
  engine: string,
  _systems: SystemResult[],
  read: (engine: string, system: string) => SystemResult | null
): void {
  const byEngine: Record<string, SystemResult[]> = {};
  for (const e of ENGINES) {
    const list = ['windows', 'linux', 'android']
      .map((s) => read(e, s))
      .filter((s): s is SystemResult => s !== null);
    if (list.length > 0) byEngine[e] = list;
  }
  writeFileSync(
    join(dir, 'navmap.json'),
    JSON.stringify({ generatedBy: 'e2e/navmap.nav.ts', viewport: '1920x1080, TV mode on', engines: byEngine }, null, 1)
  );
  const primary = byEngine.edge ? 'edge' : byEngine.webkit ? 'webkit' : engine;
  writeFileSync(join(dir, 'NAV-MAP.generated.md'), markdown(primary, byEngine));
}

// ---- helpers ---------------------------------------------------------------

const centre = (l: LeafInfo) => ({
  x: (l.rect.left + l.rect.right) / 2,
  y: (l.rect.top + l.rect.bottom) / 2,
  h: l.rect.bottom - l.rect.top,
});

/** Names a person would use; duplicates told apart by their order on the screen. */
function names(leaves: LeafInfo[]): Map<string, string> {
  const out = new Map<string, string>();
  const byLabel = new Map<string, LeafInfo[]>();
  for (const l of leaves) {
    const label = l.label === l.key ? '(unlabelled control)' : l.label;
    byLabel.set(label, [...(byLabel.get(label) ?? []), l]);
  }
  for (const [label, list] of byLabel) {
    const ordered = [...list].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    ordered.forEach((l, i) => {
      out.set(l.key, ordered.length > 1 ? `${label} (${i + 1} of ${ordered.length})` : label);
    });
  }
  return out;
}

/** Where a press in `dir` from `from` should land among `members`, if anywhere. */
function expected(from: LeafInfo, dir: Dir, members: LeafInfo[]): LeafInfo[] {
  const f = centre(from);
  const others = members.filter((m) => m.key !== from.key);
  if (dir === 'ArrowLeft' || dir === 'ArrowRight') {
    const row = others.filter((m) => {
      const c = centre(m);
      return Math.abs(c.y - f.y) < Math.max(f.h, centre(m).h) / 2 + 6;
    });
    const ahead = row.filter((m) => (dir === 'ArrowRight' ? centre(m).x > f.x + 2 : centre(m).x < f.x - 2));
    if (ahead.length === 0) return [];
    const best = Math.min(...ahead.map((m) => Math.abs(centre(m).x - f.x)));
    return ahead.filter((m) => Math.abs(centre(m).x - f.x) < best + 12);
  }
  const ahead = others.filter((m) => (dir === 'ArrowDown' ? centre(m).y > f.y + 6 : centre(m).y < f.y - 6));
  if (ahead.length === 0) return [];
  const nearestRow = Math.min(...ahead.map((m) => Math.abs(centre(m).y - f.y)));
  const row = ahead.filter((m) => Math.abs(centre(m).y - f.y) < nearestRow + 14);
  const best = Math.min(...row.map((m) => Math.abs(centre(m).x - f.x)));
  return row.filter((m) => Math.abs(centre(m).x - f.x) < best + 12);
}

function list(items: string[], max = 4): string {
  const quoted = items.map((i) => `“${i}”`);
  if (quoted.length <= max) return quoted.join(', ');
  return `${quoted.slice(0, max).join(', ')} and ${quoted.length - max} more`;
}

/** The moves of a screen, as lines of plain words, grouped by what is on screen. */
function describeMoves(s: ScreenResult): string[] {
  const nm = names(s.leaves);
  const table = new Map(s.leaves.map((l) => [l.key, l]));
  const order: string[] = [];
  const groups = new Map<string, LeafInfo[]>();
  for (const l of [...s.leaves].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)) {
    if (!groups.has(l.group)) {
      groups.set(l.group, []);
      order.push(l.group);
    }
    groups.get(l.group)?.push(l);
  }
  const lines: string[] = [];
  for (const g of order) {
    const members = groups.get(g) ?? [];
    const walked = members.filter((m) => m.walked);
    if (walked.length === 0) {
      // Not pressed from here: it shows up as a [group] where other moves lead.
      continue;
    }
    lines.push(`**${g}** (${members.length} control${members.length === 1 ? '' : 's'}: ${list(members.map((m) => nm.get(m.key) ?? m.label), 6)})`);
    const exceptions = new Map<string, string[]>();
    const standardDirs = new Map<Dir, number>();
    const edgeStays = new Map<Dir, number>();
    const dirTotals = new Map<Dir, number>();
    const mismatchDirs = new Set<Dir>();
    const pending: { m: Move; from: LeafInfo; ok: boolean; edge: boolean }[] = [];
    for (const m of s.moves) {
      const from = table.get(m.from);
      if (!from || from.group !== g || !from.walked || m.flags.includes('not-focusable')) continue;
      const exp = expected(from, m.dir, members);
      const stay = m.to === m.from;
      const ok = exp.length > 0 && exp.some((e) => e.key === m.to);
      const edge = exp.length === 0 && stay;
      pending.push({ m, from, ok, edge });
      dirTotals.set(m.dir, (dirTotals.get(m.dir) ?? 0) + 1);
      if (ok) standardDirs.set(m.dir, (standardDirs.get(m.dir) ?? 0) + 1);
      else if (edge) edgeStays.set(m.dir, (edgeStays.get(m.dir) ?? 0) + 1);
      else mismatchDirs.add(m.dir);
    }
    const plain = (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] as Dir[]).filter(
      (d) => (dirTotals.get(d) ?? 0) > 0 && (standardDirs.get(d) ?? 0) > 0
    );
    const showPlain = plain.length > 0 && walked.length > 1;
    if (showPlain) {
      const allPlain = plain.every((d) => !mismatchDirs.has(d));
      lines.push(`- Moves like a grid or list: ${plain.map((d) => DIR_WORD[d]).join(', ')} go to the neighbour inside the group${plain.some((d) => edgeStays.has(d)) ? ', and stay put where there is none' : ''}${allPlain ? '; no exceptions inside the group.' : '; exceptions:'}`);
    }
    const edgeOnly = [...edgeStays.keys()].filter((d) => !showPlain || !plain.includes(d));
    if (edgeOnly.length > 0) {
      lines.push(`- ${edgeOnly.map((d) => DIR_WORD[d]).join(', ')}: nothing further that way inside the group, so focus stays put.`);
    }
    for (const p of pending) {
      if (p.edge) continue;
      if (p.ok) continue;
      const toLeaf = table.get(p.m.to);
      const where = p.m.to === p.m.from ? 'stays put' : `→ “${nm.get(p.m.to) ?? p.m.toLabel}”${toLeaf && toLeaf.group !== g ? ` [${toLeaf.group}]` : !toLeaf && p.m.toHeading ? ` [${p.m.toHeading}]` : ''}`;
      const k = `${DIR_WORD[p.m.dir]} ${where}`;
      exceptions.set(k, [...(exceptions.get(k) ?? []), nm.get(p.from.key) ?? p.from.label]);
    }
    for (const [k, froms] of exceptions) {
      const sp = k.indexOf(' ');
      const dirWord = k.slice(0, sp);
      lines.push(`- ${dirWord} from ${froms.length > 3 && froms.length === walked.length ? 'any of them' : list(froms)} ${k.slice(sp + 1)}`);
    }
  }
  return lines;
}

function flagLines(s: ScreenResult): string[] {
  const nm = names(s.leaves);
  const table = new Map(s.leaves.map((l) => [l.key, l]));
  const lines: string[] = [];
  const kinds = ['left-menu', 'under-top-bar', 'off-screen', 'focus-lost', 'not-focusable'];
  for (const kind of kinds) {
    const hits = s.moves.filter((m) => m.flags.includes(kind));
    if (hits.length === 0) continue;
    const shown = hits.slice(0, 10).map(
      (m) =>
        `${DIR_WORD[m.dir]} from “${nm.get(m.from) ?? m.from}” → “${table.has(m.to) ? nm.get(m.to) : m.toLabel}”` +
        (m.after
          ? ` (control spans ${m.after.top}–${m.after.bottom} px, bar ends ${m.after.barBottom} px, screen ${m.after.viewportHeight} px)`
          : '')
    );
    lines.push(`- **${kind}** ×${hits.length}: ${shown.join('; ')}${hits.length > 10 ? `; and ${hits.length - 10} more (see navmap.json)` : ''}`);
  }
  if (s.unreachable.length > 0) {
    lines.push(`- **unreachable** (no arrow press lands on them): ${list(s.unreachable.map((k) => nm.get(k) ?? k), 10)}`);
  }
  if (s.trapped.length > 0) {
    lines.push(`- **trapped** (no arrow leaves them): ${list(s.trapped.map((k) => nm.get(k) ?? k), 10)}`);
  }
  if (lines.length === 0) lines.push('- none');
  return lines;
}

/** What a screen did, comparable across systems: where each press went. */
function signature(s: ScreenResult): string {
  return s.moves.map((m) => `${m.from}>${m.dir}>${m.to}`).sort().join('|');
}

function countFlags(s: ScreenResult): string {
  const entries = Object.entries(s.flagCounts).filter(([k]) => k !== 'no-move');
  return entries.length ? entries.map(([k, v]) => `${k} ${v}`).join(', ') : 'none';
}

// ---- the document ---------------------------------------------------------------

function markdown(primary: string, byEngine: Record<string, SystemResult[]>): string {
  const systems = byEngine[primary] ?? [];
  const out: string[] = [];
  out.push('# Kinema navigation map (generated)');
  out.push('');
  out.push(
    `Written by \`npm run test:nav\` (e2e/navmap.nav.ts). Engine shown: **${primary === 'edge' ? 'Microsoft Edge (the engine Windows and Android use)' : 'WebKit (the engine Linux uses)'}**. ` +
      'Screen size 1920×1080 with the TV layout on. Every control was put in focus in turn and each arrow pressed once, with the keyboard only (no mouse). ' +
      'This is **what the app does today**, not what it should do: nothing here is checked against an expected answer.'
  );
  out.push('');
  out.push(
    'How to read it: each group of controls is named as on screen ("Rail: Movies" is the row of films under that heading). ' +
      '"Steps to the neighbour" means the arrow goes to the next control in that direction inside the same group. Only moves that do something else are listed, ' +
      'with the group they lead to in [brackets]. Flags: **left-menu** (left a dialog or menu), **under-top-bar** (the control, or its heading, ended up behind the bar at the top), ' +
      '**off-screen** (not fully on screen once the page stopped scrolling), **no-move** (focus stayed). **unreachable** controls no arrow lands on; **trapped** controls no arrow leaves.'
  );
  out.push('');
  const win = new Map((systems.find((s) => s.system === 'windows')?.screens ?? []).map((s) => [s.id, s]));
  const detail: string[] = [];
  for (const sys of systems) {
    out.push(`## ${SYSTEM_TITLE[sys.system] ?? sys.system}`);
    out.push('');
    out.push(`Walk time ${Math.round(sys.seconds / 60)} min ${sys.seconds % 60} s.`);
    out.push('');
    for (const s of sys.screens) {
      out.push(`### ${s.name}`);
      out.push('');
      if (s.how === 'skipped') {
        out.push(`Skipped. ${s.note}`);
        out.push('');
        continue;
      }
      const w = win.get(s.id);
      const reach = s.how === 'keyboard' ? 'reached with the keyboard from Home' : 'reached with the test probe (focus set directly)';
      const landing = s.leaves.find((l) => l.key === s.landing);
      out.push(`_${reach}; focus lands on “${landing ? landing.label : (s.landing ?? 'nothing')}”._${s.note ? ` ${s.note}` : ''}`);
      out.push('');
      if (sys.system !== 'windows' && w && w.how !== 'skipped' && signature(w) === signature(s) && s.moves.length > 0) {
        out.push('Same as Windows.');
        out.push('');
        continue;
      }
      if (s.reusedFrom) out.push(`_The controls and their places are identical to the ${SYSTEM_TITLE[s.reusedFrom]} screen, so its moves are copied rather than pressed again._`, '');
      if (s.sampled) out.push(`_${s.sampled}._`, '');
      out.push(...describeMoves(s));
      const flags = flagLines(s);
      if (flags[0] === '- none') out.push('Flags: none.');
      else out.push('Flags:', ...flags);
      out.push('');
      const nm = names(s.leaves);
      detail.push(`#### ${SYSTEM_TITLE[sys.system]} — ${s.name}`, '', ...s.leaves.map((l) => `- ${nm.get(l.key)} = \`${l.key}\``), '');
    }
    out.push('### Held arrow keys');
    out.push('');
    if (sys.lag.length === 0) out.push('Not measured.');
    else {
      out.push('Key held 1.5 s at a key-repeat pace; “behind” is how far the control in focus was outside the visible area at worst, and how long after letting go until it was fully visible.');
      out.push('');
      for (const l of sys.lag) {
        out.push(`- ${l.name}: ${l.presses} presses, at worst ${l.maxOutsidePx} px outside the visible area; visible again ${l.msUntilVisibleAfterKeyUp} ms after key-up.`);
      }
    }
    out.push('');
  }
  out.push('## Flag counts per screen');
  out.push('');
  out.push('| System | Screen | Flags (not counting no-move) | no-move | unreachable | trapped |');
  out.push('|---|---|---|---|---|---|');
  for (const sys of systems) {
    for (const s of sys.screens) {
      if (s.how === 'skipped') continue;
      out.push(`| ${SYSTEM_TITLE[sys.system]} | ${s.name} | ${countFlags(s)} | ${s.flagCounts['no-move'] ?? 0} | ${s.unreachable.length} | ${s.trapped.length} |`);
    }
  }
  out.push('');
  const other = primary === 'edge' ? 'webkit' : 'edge';
  if (byEngine[other]) {
    out.push(`## Where ${other === 'webkit' ? 'WebKit' : 'Edge'} differs`);
    out.push('');
    let any = false;
    for (const sys of systems) {
      const o = byEngine[other].find((x) => x.system === sys.system);
      if (!o) continue;
      for (const s of sys.screens) {
        const t = o.screens.find((x) => x.id === s.id);
        if (!t || s.how === 'skipped' || t.how === 'skipped') continue;
        const a = new Map(s.moves.map((m) => [`${m.from}>${m.dir}`, m.to]));
        const diffs = t.moves.filter((m) => a.has(`${m.from}>${m.dir}`) && a.get(`${m.from}>${m.dir}`) !== m.to);
        if (diffs.length > 0) {
          any = true;
          out.push(`- ${SYSTEM_TITLE[sys.system]} — ${s.name}: ${diffs.length} press${diffs.length === 1 ? '' : 'es'} go somewhere else (first: ${DIR_WORD[diffs[0].dir]} from ${diffs[0].from} → ${diffs[0].to}, against ${a.get(`${diffs[0].from}>${diffs[0].dir}`)}).`);
        }
      }
    }
    if (!any) out.push('No difference in where any press went.');
    out.push('');
  }
  out.push('## Details: focus keys');
  out.push('');
  out.push('The names above are what is on screen; these are the keys the app uses for them.');
  out.push('');
  out.push(...detail);
  return out.join('\n');
}
