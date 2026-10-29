#!/usr/bin/env node
/**
 * Nothing personal in the public repository: no owner's name, equipment
 * models, device ids, library paths or film titles (CONTRIBUTING). This scans
 * what a change adds — added lines since the base, new untracked files and
 * the commit messages — for words on a private list, one per line, kept out
 * of this repository (the maintainer's is notes/private-words.txt; or set
 * KINEMA_PRIVATE_WORDS to a file). Matching ignores case. With no list it
 * says so and passes. Run by `npm run verify`; also alone:
 *
 *   node scripts/privacy-check.mjs [--base origin/master]
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const i = process.argv.indexOf('--base');
const base = i > 0 ? process.argv[i + 1] : 'origin/master';
const listFile = process.env.KINEMA_PRIVATE_WORDS ?? join(root, 'notes', 'private-words.txt');

if (!existsSync(listFile)) {
  console.log('no private word list; skipped');
  process.exit(0);
}
const words = readFileSync(listFile, 'utf8')
  .split(/\r?\n/)
  .map((w) => w.trim())
  .filter((w) => w && !w.startsWith('#'));

const git = (args) =>
  execSync(`git ${args}`, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
let mergeBase;
try {
  mergeBase = git(`merge-base HEAD ${base}`).trim();
} catch {
  console.log(`no ${base} to compare with; skipped`);
  process.exit(0);
}

/** [where, text] pairs: every added line, every line of a new file, every commit message line. */
const lines = [];
let file = '';
for (const line of git(`diff -U0 --no-color ${mergeBase} -- . ":(exclude)package-lock.json"`).split('\n')) {
  if (line.startsWith('+++ ')) file = line.slice(6);
  else if (line.startsWith('+')) lines.push([file, line.slice(1)]);
}
for (const f of git('ls-files --others --exclude-standard').split('\n').filter(Boolean)) {
  let text;
  try {
    text = readFileSync(join(root, f), 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\0')) continue; // binary
  for (const l of text.split('\n')) lines.push([f, l]);
}
for (const l of git(`log --format=%B ${mergeBase}..HEAD`).split('\n')) lines.push(['commit message', l]);

const hits = [];
for (const [where, text] of lines) {
  const lower = text.toLowerCase();
  for (const w of words) {
    if (lower.includes(w.toLowerCase())) hits.push(`${where}: "${w}" in: ${text.trim().slice(0, 160)}`);
  }
}
if (hits.length) {
  console.log(`${hits.length} private word(s) in what this change adds:`);
  for (const h of hits.slice(0, 30)) console.log(`  ${h}`);
  process.exit(1);
}
console.log(`${lines.length} added lines clean`);
