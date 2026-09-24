#!/usr/bin/env node
/**
 * Syntax + shape sanity check for every module in src/.
 * Run: npm run check
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const src = join(root, 'src');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(src).sort();
let failed = 0;
const empty = [];
const forbidden = [];

for (const f of files) {
  const rel = relative(root, f);
  const text = readFileSync(f, 'utf8');
  if (text.trim().length < 40) empty.push(rel);
  if (/<\w+[:]\w+/.test(text) && /:\s*(string|number|boolean|void|Array<)\b/.test(text)) {
    forbidden.push(rel + ' (possible TypeScript syntax)');
  }
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error('PARSE ERROR ' + rel + '\n' + String(err.stderr || err.message).split('\n').slice(0, 6).join('\n'));
  }
  if (/TODO|FIXME|not implemented|placeholder stub/i.test(text)) {
    console.warn('WARN ' + rel + ' contains TODO/FIXME/placeholder text');
  }
}

console.log('');
if (empty.length) console.warn('SUSPICIOUSLY SMALL FILES:\n  ' + empty.join('\n  '));
if (forbidden.length) console.warn('TYPE-SYNTAX SMELL:\n  ' + forbidden.join('\n  '));
console.log('checked ' + files.length + ' files, ' + failed + ' parse error(s)');
process.exit(failed ? 1 : 0);
