#!/usr/bin/env node
/**
 * UI regression checks: the DOM shim has no real element tree, so the things
 * that were broken in the menu shell are pinned as invariants over the exports
 * and the stylesheet, plus direct unit tests of every helper that can be
 * isolated.
 *
 *   node scripts/test-ui.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (detail ? '  -- ' + detail : ''));
};
const section = (t) => console.log('\n=== ' + t + ' ===');

async function main() {
  /* -------------------------------------------------------------- colours --- */
  section('Menu colour helpers');
  const { hexToRgb, rgba, KART_VALUES } = await import('../src/ui/Menus.js');
  const { TRACKS } = await import('../src/data/tracks.js');

  ok('hexToRgb accepts the numeric hex tracks.js uses', JSON.stringify(hexToRgb(0x3b3b42)) === '[59,59,66]',
    '0x3b3b42 -> ' + JSON.stringify(hexToRgb(0x3b3b42)));
  ok('hexToRgb accepts a 6-digit string', JSON.stringify(hexToRgb('#336699')) === '[51,102,153]',
    '"#336699" -> ' + JSON.stringify(hexToRgb('#336699')));
  ok('hexToRgb expands a 3-digit string', JSON.stringify(hexToRgb('abc')) === '[170,187,204]',
    '"abc" -> ' + JSON.stringify(hexToRgb('abc')));
  ok('hexToRgb falls back to white', JSON.stringify(hexToRgb()) === '[255,255,255]');

  // Every theme colour the track-select art reads must round-trip exactly.
  let worst = 0;
  for (const t of TRACKS) {
    const th = t.theme || {};
    for (const key of ['road', 'curbA', 'curbB', 'terrain', 'terrainAlt', 'water']) {
      const v = th[key];
      if (typeof v !== 'number') continue;
      const [r, g, b] = hexToRgb(v);
      const want = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
      worst = Math.max(worst, Math.abs(r - want[0]) + Math.abs(g - want[1]) + Math.abs(b - want[2]));
    }
  }
  ok('every numeric theme colour round-trips', worst === 0, 'max channel error ' + worst);
  ok('rgba() emits a valid css colour', /^rgba\(\d+,\d+,\d+,[\d.]+\)$/.test(rgba(0x3b3b42, 0.5)), rgba(0x3b3b42, 0.5));

  ok('the field-size control can represent a solo Time Trial', KART_VALUES.includes(1),
    KART_VALUES.join(','));

  /* -------------------------------------------------------------- keyboard --- */
  section('Menu shell keyboard reachability');
  const ui = read('src/ui/UI.js');
  const main = read('src/main.js');
  ok('the results screen is an interactive menu',
    /if \(active\.key === 'hud'\) return false;/.test(ui) && !/active\.key === 'results'\) return false/.test(ui),
    'isInteractiveMenu() must not exclude results');
  ok('Escape on a pause sub-screen pops the stack instead of resuming',
    /if \(store\.state\.mode === MODES\.PAUSED\) \{/.test(ui) &&
    /if \(active\.key === 'pause'\) return; \/\/ handed straight to main\.js, which resumes/.test(ui) &&
    /function goBack\(\) \{[\s\S]*?backSeq\+\+;/.test(ui));
  ok('main.js defers to the shell when it handled the Back press',
    /uiHandledBack/.test(main));
  ok('arrow keys do not fight the volume sliders',
    /isRange/.test(ui) && /e\.target\.type === 'range'/.test(ui));
  ok('an explicit toast kind is honoured',
    /const cls = kind \? `t-\$\{kind\}` : 't-good';/.test(ui));
  ok('change-track goes straight to the track select',
    /changeTrack: \(\) => \{\s*\/\/ Straight to the track select/.test(ui));

  const menus = read('src/ui/Menus.js');
  ok('the segmented controls are focusable',
    /'data-focusable': '1',\s*\n\s*text: fmt\(v\)/.test(menus) ||
    /"data-focusable": "1",\s*\n\s*text: fmt\(v\)/.test(menus));
  ok('the volume sliders are focusable', /type: 'range'[\s\S]{0,200}'data-focusable': '1'/.test(menus));

  const hud = read('src/ui/HUD.js');
  ok('the boost glow is toggled on the speed block, not the HUD root',
    /speedBlock\.classList\.toggle\('boosting', boosting\)/.test(hud) &&
    /const speedBlock = h\(/.test(hud) &&
    !/el\.classList\.toggle\('boosting'/.test(hud));

  /* --------------------------------------------------------------- styles --- */
  section('Stylesheet invariants');
  const css = read('src/styles/main.css');
  const rule = (sel) => {
    const i = css.indexOf(sel);
    return i < 0 ? null : css.slice(i, css.indexOf('}', i) + 1);
  };
  ok('the speed glow rule exists', !!rule('.hud-speed.boosting .val'));
  ok('the countdown digit can re-pop', !!rule('.count-num.pop'));
  ok('the results panel cannot be squeezed to nothing',
    /flex:\s*0 0 auto/.test(rule('.results-panel') || ''));
  ok('the results screen can scroll to the last row',
    /overflow-y:\s*auto/.test(rule('.results-screen.results-screen') || rule('.results-screen') || ''));

  /* ----------------------------------------------------------- race config --- */
  section('Race config plumbing');
  const boot = read('src/race/Bootstrap.js');
  ok('the config handed to startRace is honoured', /const cfg = this\.config \|\| \{\};/.test(boot));
  ok('a Time Trial asks for a field of one',
    /const count = timeTrial \? 1 : clamp\(state2\.playerCount \| 0, 2, 8\);/.test(boot));
  ok('dispose() releases the item system', /this\.items\?\.dispose\?\.\(\);/.test(boot));
  ok('dispose() releases the track builder', /this\.builder\?\.dispose\?\.\(\);/.test(boot));
  ok('dispose() silences the engine', /this\.audio\?\.setEngine\?\.null/.test(boot) === false && /setEngine\?\.\(null\)/.test(boot));
  ok('the item system gets a seeded rng', /rng: this\.itemRng/.test(boot));

  const game = read('src/core/Game.js');
  ok('simOnly systems are skipped in the fixed loop, not the view loop',
    /if \(sys\.simOnly === true\) continue;\s*\n\s*sys\.update\?\.\(FIXED/.test(game) &&
    !/sys\.enabled === false \|\| sys\.simOnly === true\) continue;/.test(game));

  const input = read('src/core/Input.js');
  ok('a focused form field keeps its arrow keys',
    /const formField = t && t\.tagName && \/\^\(INPUT\|SELECT\|TEXTAREA\)\$\/\.test\(t\.tagName\);/.test(input) &&
    /if \(!formField && PREVENT\.has\(e\.code\)\) e\.preventDefault\(\);/.test(input));

  /* -------------------------------------------------------------- reporting --- */
  const failed = results.filter((r) => !r.pass);
  console.log('\n---------------------------------------------');
  console.log(results.length + ' checks, ' + failed.length + ' failed');
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log('  - ' + f.name + ' :: ' + f.detail);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('ui test harness crashed', err);
  process.exit(2);
});
