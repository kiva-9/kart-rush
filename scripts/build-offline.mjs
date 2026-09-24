#!/usr/bin/env node
/**
 * Offline build: emits ONE self-contained HTML file that runs from the
 * filesystem with no server and no network (file://, or any USB stick).
 *
 * The normal build is ES modules, which browsers refuse to load over file://
 * (CORS). So this builds an IIFE bundle and inlines the JS and CSS straight
 * into the HTML. Everything the game needs — geometry, textures, audio, fonts —
 * is generated at runtime, so one file is genuinely all of it.
 *
 *   node scripts/build-offline.mjs
 *   -> dist-offline/kart-rush-offline.html
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// decodeURIComponent: this project's path contains non-ASCII characters, which
// URL.pathname leaves percent-encoded and therefore unusable as a cwd.
const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const outDir = join(root, 'dist-offline');
const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');

function die(msg) {
  console.error('\n[offline] ' + msg);
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const kb = (n) => (n / 1024).toFixed(0) + ' kB';

/* ------------------------------------------------------------------ build --- */
console.log('[offline] building the IIFE bundle...');
try {
  execFileSync(process.execPath, [viteBin, 'build'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, OFFLINE_BUILD: '1' },
  });
} catch {
  die('vite build failed');
}

/* ------------------------------------------------------------------ inline --- */
if (!existsSync(outDir)) die('expected output directory ' + outDir);

const indexHtml = join(outDir, 'index.html');
if (!existsSync(indexHtml)) die('no index.html in the build output');

const html = readFileSync(indexHtml, 'utf8');
const byName = new Map(walk(outDir).map((f) => [f.split('/').pop(), f]));

/**
 * Pulls every external <script src> / <link href> out of the HTML and returns
 * the shell plus the inlined bodies it should carry.
 */
function externalise(htmlIn) {
  const found = [];
  let shell = htmlIn;

  const tags = [
    { re: /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script\s*>/gi, tag: 'script' },
    { re: /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi, tag: 'link' },
  ];

  for (const { re, tag } of tags) {
    shell = shell.replace(re, (whole, src) => {
      const name = src.split('/').pop().split('?')[0];
      const file = byName.get(name);
      if (!file) {
        die('the HTML references "' + name + '" but the build did not emit it');
      }
      found.push({ tag, name, body: readFileSync(file, 'utf8') });
      return '\n';
    });
  }
  return { shell, found };
}

const { shell, found } = externalise(html);
const scripts = found.filter((f) => f.tag === 'script');
const links = found.filter((f) => f.tag === 'link');
if (scripts.length !== 1) die('expected exactly one script, got ' + scripts.length);

let code = scripts[0].body;
let style = links.map((l) => l.body).join('\n');

// Vite does not emit a stylesheet file for an iife bundle; it inlines the CSS
// into the JS instead, as a document.createElement('style') injection. Only read
// the source stylesheet when the bundle does not already carry it, or the rules
// would be shipped (and applied) twice.
if (!style) {
  const cssFile = join(root, 'src', 'styles', 'main.css');
  const alreadyInlined = code.includes('--ink:') || code.includes('#ui-root');
  if (alreadyInlined) {
    console.log('  note: Vite inlined the stylesheet into the JS, so no <style> is added');
  } else {
    if (!existsSync(cssFile)) die('no stylesheet in the build and none at ' + cssFile);
    style = readFileSync(cssFile, 'utf8');
    console.log('  note: using ' + cssFile.split('/').slice(-2).join('/') + ' from source');
  }
}

// A literal </script> inside the bundle would close the inline tag early. In a
// string or regex literal `<\/script>` is the identical token, so the escape is
// safe and only applied when the sequence actually occurs.
if (code.includes('</script')) code = code.replace(/<\/script/gi, '<\\/script');
if (style.includes('</style')) style = style.replace(/<\/style/gi, '<\\/style');

// Sanity, on the shell only: nothing may still be loaded from outside. It runs
// before the bodies are spliced in, because the game's own JS legitimately
// contains src= and href= inside template strings.
if (/<script\b[^>]*\bsrc=/i.test(shell)) die('a <script src=...> survived');
if (/<link\b[^>]*\bhref=/i.test(shell)) die('a <link href=...> survived');

// Spliced with a function replacement on purpose: with a string replacement,
// `$` sequences inside the minified bundle ($`, $&, $', $1) would be
// interpreted as substitution patterns and silently corrupt the code.
let out = shell;
if (style) {
  out = out.replace('</head>', () => '  <style>\n' + style + '\n  </style>\n  </head>');
}
out = out.replace('</body>', () => '  <script>\n' + code + '\n  </script>\n  </body>');

// No stray file references anywhere in the final document.
const refs = out.match(/(?:src|href)\s*=\s*["'](?!data:|#|mailto:|javascript:)[^"']*\.(?:js|css|json|png|woff2?)["']/gi) || [];
if (refs.length) die('the bundle still references ' + refs.join(', '));

const target = join(outDir, 'kart-rush-offline.html');
writeFileSync(target, out, 'utf8');

console.log('');
if (style) console.log('  inlined CSS  ' + kb(style.length));
console.log('  inlined JS   ' + kb(code.length));
console.log('');
console.log('  offline build: ' + target);
console.log('  size: ' + kb(Buffer.byteLength(out, 'utf8')) + '  — open it directly, no server needed');
console.log('');
