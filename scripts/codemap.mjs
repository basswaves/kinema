#!/usr/bin/env node
/**
 * Where things are, one line per source file: its size and the first line of
 * its header comment. Generated on demand, so it is never out of date.
 *
 *   node scripts/codemap.mjs            every area
 *   node scripts/codemap.mjs player     only paths containing "player"
 *
 * For Claude Code sessions: one command instead of a search helper reading
 * files to find where something lives (~200 lines for the whole project).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const filter = process.argv[2]?.toLowerCase();
const DIRS = ['src', 'src-tauri/src', 'e2e', 'scripts', 'src-tauri/gen/android/app/src/main/java'];
const EXT = /\.(tsx?|rs|mjs|kt|sh|ps1)$/;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      if (!/^(node_modules|generated|target|vendor)$/.test(e.name)) yield* walk(path);
    } else if (EXT.test(e.name) && !/\.test\.tsx?$|\.d\.ts$/.test(e.name)) yield path;
  }
}

/** The first sentence-like line of the file's leading comment. */
function summary(text) {
  for (const raw of text.split('\n').slice(0, 40)) {
    const line = raw.trim();
    if (/^(import|use |export|package|fn |pub |const |#!|<#|\[|param|@)/.test(line) && !line.startsWith('#!')) break;
    const t = line.replace(/\s*\*\/$/, '').replace(/^(\/\*\*|\/\*|\*\/|\*|\/\/!|\/\/\/|\/\/|#)\s?/, '').trim();
    if (t && !/^(\.SYNOPSIS|\.DESCRIPTION|usr\/bin|!\/usr)/.test(t) && !t.startsWith('!')) return t;
  }
  return '';
}

let last = '';
for (const top of DIRS) {
  for (const path of walk(join(root, top))) {
    const rel = relative(root, path).replaceAll('\\', '/');
    if (filter && !rel.toLowerCase().includes(filter)) continue;
    const dir = rel.slice(0, rel.lastIndexOf('/'));
    if (dir !== last) {
      console.log(`\n${dir}/`);
      last = dir;
    }
    const kb = Math.max(1, Math.round(statSync(path).size / 1024));
    const name = rel.slice(dir.length + 1);
    console.log(`  ${name} (${kb} KB) ${summary(readFileSync(path, 'utf8')).slice(0, 110)}`);
  }
}
