/**
 * Post-race results screen for Kart Rush.
 *
 * Full standings table (position, racer, colour chip, total time, best lap and
 * per-lap splits), the player row highlighted, championship points, a
 * new-record badge and Rematch / Change Track / Main Menu actions.
 */

import { CONFIG } from '../data/config.js';
import { formatTime, ordinal } from '../core/MathUtils.js';
import { GameStore, saveRecord } from '../core/Store.js';

function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k.length > 2 && k[0] === 'o' && k[1] === 'n' && typeof v === 'function') {
        n.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, String(v));
    }
  }
  for (const kid of kids) {
    if (kid == null || kid === false) continue;
    if (Array.isArray(kid)) {
      for (const inner of kid) if (inner != null && inner !== false) n.append(inner);
    } else if (typeof kid === 'string' || typeof kid === 'number') {
      n.append(document.createTextNode(String(kid)));
    } else n.append(kid);
  }
  return n;
}

const DIFF_LABEL = { easy: 'EASY', normal: 'NORMAL', hard: 'HARD', insane: 'INSANE' };

export function createResults(ctx, api) {
  const store = (ctx && ctx.store) || GameStore;
  const headOrd = h('span', { class: 'res-place', text: '1st' });
  const headSub = h('span', { class: 'res-sub', text: '' });
  const recordBadge = h('div', { class: 'res-record hidden' });
  const table = h('table', { class: 'results-table' });
  const summary = h('div', { class: 'res-summary' });

  const btnRematch = h('button', { class: 'btn primary', 'data-focusable': '1', type: 'button', text: 'Rematch' });
  const btnTrack = h('button', { class: 'btn blue', 'data-focusable': '1', type: 'button', text: 'Change Track' });
  const btnMenu = h('button', { class: 'btn ghost', 'data-focusable': '1', type: 'button', text: 'Main Menu' });

  btnRematch.addEventListener('click', () => api.rematch());
  btnTrack.addEventListener('click', () => api.changeTrack());
  btnMenu.addEventListener('click', () => api.mainMenu());

  const el = h(
    'div',
    { class: 'screen results-screen', 'data-screen': 'results' },
    h(
      'div',
      { class: 'results-hero' },
      h('div', { class: 'eyebrow', text: 'Race complete' }),
      h('h2', { class: 'display results-title', text: 'Results' }),
      summary
    ),
    recordBadge,
    h('div', { class: 'panel results-panel' }, h('div', { class: 'panel-body results-body' }, table)),
    h('div', { class: 'results-actions' }, btnRematch, btnTrack, btnMenu)
  );

  let built = false;

  function buildShell() {
    if (built) return;
    built = true;
    table.append(
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { text: 'Pos' }),
          h('th', { text: 'Racer' }),
          h('th', { text: 'Total' }),
          h('th', { text: 'Best lap' }),
          h('th', { text: 'Splits' }),
          h('th', { text: 'Pts' })
        )
      )
    );
    table.append(h('tbody', { class: 'res-tbody' }));
  }

  /**
   * @param {object} results Results shape from the race director.
   * @param {object} prev records snapshot taken when the race started.
   */
  function show(results, prev) {
    buildShell();
    const body = table.querySelector('.res-tbody');
    if (!body) return;
    body.textContent = '';

    const state = store.state;
    const entries = (results && Array.isArray(results.entries) ? results.entries : []).slice();
    entries.sort((a, b) => (a.position || 99) - (b.position || 99));

    const player = entries.find((e) => e.isPlayer) || null;
    const total = entries.length || state.playerCount || 8;

    // --- hero ---------------------------------------------------------------
    const pPos = player ? player.position || 1 : results?.playerPosition || 1;
    headOrd.textContent = ordinal(pPos);
    headOrd.className = `res-place ${pPos <= 3 ? 'podium p' + pPos : ''}`;
    const diff = DIFF_LABEL[state.difficulty] || String(state.difficulty || '').toUpperCase();
    headSub.textContent = `${results.cc || state.cc}cc · ${results.laps || state.laps} LAPS · ${diff}`;
    summary.textContent = '';
    summary.append(headOrd, headSub);

    // --- records ------------------------------------------------------------
    const trackId = results.trackId || state.trackId;
    const before = prev && prev[trackId] ? prev[trackId] : null;
    const bestLap = player && player.bestLapMs != null ? player.bestLapMs : null;
    const totalMs = player && player.totalMs != null ? player.totalMs : null;
    let newLap = false;
    let newTotal = false;
    if (bestLap != null && Number.isFinite(bestLap)) {
      newLap = !before || before.bestLapMs == null || bestLap < before.bestLapMs;
    }
    if (totalMs != null && Number.isFinite(totalMs)) {
      newTotal = !before || before.totalMs == null || totalMs < before.totalMs;
    }
    if (bestLap != null && Number.isFinite(bestLap)) {
      try {
        saveRecord(trackId, bestLap, Number.isFinite(totalMs) ? totalMs : bestLap);
      } catch {
        /* storage may be unavailable */
      }
    }
    recordBadge.className = newTotal || newLap ? 'res-record' : 'res-record hidden';
    recordBadge.textContent = '';
    if (newTotal) recordBadge.append(h('span', { class: 'res-badge gold', text: 'NEW TRACK RECORD' }));
    if (newLap) recordBadge.append(h('span', { class: 'res-badge mint', text: 'NEW BEST LAP' }));
    if (results.newRecord === true && !newTotal && !newLap) {
      recordBadge.className = 'res-record';
      recordBadge.append(h('span', { class: 'res-badge mint', text: 'NEW RECORD' }));
    }

    // --- table --------------------------------------------------------------
    const pts = CONFIG.race.points;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const pos = e.position || i + 1;
      const laps = Array.isArray(e.lapTimesMs) ? e.lapTimesMs : [];
      let bestIdx = -1;
      let best = Infinity;
      for (let j = 0; j < laps.length; j++) {
        if (Number.isFinite(laps[j]) && laps[j] < best) {
          best = laps[j];
          bestIdx = j;
        }
      }
      if (e.bestLapMs != null && Number.isFinite(e.bestLapMs) && e.bestLapMs < best) best = e.bestLapMs;

      const splitChips = h('div', { class: 'res-splits' });
      for (let j = 0; j < laps.length; j++) {
        splitChips.append(
          h('span', { class: j === bestIdx ? 'split best' : 'split', text: formatTime(laps[j]) })
        );
      }
      if (!laps.length) splitChips.append(h('span', { class: 'split none', text: '—' }));

      body.append(
        h(
          'tr',
          { class: e.isPlayer ? 'you' : '' },
          h('td', { class: 'res-pos', text: String(pos) }),
          h(
            'td',
            { class: 'res-name' },
            h('span', { class: 'res-chip', style: { background: e.color || '#ffffff' } }),
            h('span', { class: 'res-pname', text: e.name || `Racer ${pos}` }),
            e.isPlayer ? h('span', { class: 'res-youtag', text: 'YOU' }) : null
          ),
          h('td', { class: 'res-time', text: formatTime(e.totalMs) }),
          h('td', { class: 'res-best', text: formatTime(best === Infinity ? null : best) }),
          h('td', { class: 'res-laps' }, splitChips),
          h('td', { class: 'res-pts', text: String(pts[pos - 1] != null ? pts[pos - 1] : 0) })
        )
      );
    }
    if (!entries.length) {
      body.append(
        h(
          'tr',
          {},
          h('td', { colspan: '6', class: 'res-empty', text: 'No results available.' })
        )
      );
    }

    el.classList.remove('result-in');
    void el.offsetWidth;
    el.classList.add('result-in');
  }

  function dispose() {
    el.remove();
  }

  return { el, show, dispose };
}

export default createResults;
