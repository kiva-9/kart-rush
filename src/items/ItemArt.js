/**
 * ItemArt — the item icons, drawn twice from one recipe.
 *
 * Every icon is described as a list of ops in a 100x100 design space. The same
 * recipe is serialised to inline SVG for the HUD (`itemIconSVG`) and painted with
 * the Canvas2D API for the cards and tooltips (`drawItemIcon`), so the two can
 * never drift apart. Zero external assets: gradients are generated, geometry is
 * paths, and every silhouette is deliberately readable at 118 px.
 */
import { getItem, ITEMS } from '../data/items.js';

/** Chunky cartoon outline shared by every icon. */
const INK = '#0a0e1a';
/** Design space the recipes are authored in. */
const DESIGN = 100;
let uidCounter = 0;

/* ------------------------------------------------------------------ colour */

function hexToRgb(hex) {
  const raw = String(hex || '#ffffff').replace('#', '');
  const full = raw.length === 3 ? raw[0] + raw[0] + raw[1] + raw[1] + raw[2] + raw[2] : raw.padEnd(6, '0');
  const n = parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [255, 255, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mixes toward white (t > 0) or black (t < 0); returns '#rrggbb'. */
function mix(hex, target, t) {
  const a = hexToRgb(hex);
  const b = hexToRgb(target);
  const k = Math.max(-1, Math.min(1, t));
  const out = a.map((v, i) => Math.round(v + (b[i] - v) * Math.abs(k)));
  return '#' + out.map((v) => v.toString(16).padStart(2, '0')).join('');
}

const WHITE = '#ffffff';
const BLACK = '#000000';

function rgba(hex, a) {
  const c = hexToRgb(hex);
  return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
}

const lighten = (hex, t) => mix(hex, WHITE, t);
const darken = (hex, t) => mix(hex, BLACK, t);

/* --------------------------------------------------------------- op makers */

const grad = (id, x1, y1, x2, y2, stops) => ({ t: 'g', id, x1, y1, x2, y2, stops });

const path = (d, fill, o = {}) => ({
  t: 'p', d, f: fill || null, s: o.s === undefined ? INK : o.s,
  w: o.w == null ? 4.6 : o.w, op: o.op == null ? 1 : o.op,
});

const ellipse = (cx, cy, rx, ry, fill, o = {}) => ({
  t: 'e', cx, cy, rx, ry, rot: o.rot || 0, f: fill || null,
  s: o.s === undefined ? INK : o.s, w: o.w == null ? 3.6 : o.w, op: o.op == null ? 1 : o.op,
});

const circle = (cx, cy, r, fill, o = {}) => ellipse(cx, cy, r, r, fill, o);

const poly = (pts, fill, o = {}) => ({
  t: 'y', pts, close: o.close !== false, f: fill || null,
  s: o.s === undefined ? INK : o.s, w: o.w == null ? 4.6 : o.w, op: o.op == null ? 1 : o.op,
});

const group = (ops, o = {}) => ({
  t: 'grp', ops, tx: o.tx || 0, ty: o.ty || 0, rot: o.rot || 0, sc: o.sc == null ? 1 : o.sc,
});

/** Soft coloured bloom so every icon reads on the dark HUD disc. */
const backdrop = (color, strength) => ({
  t: 'bg',
  stops: [
    [0, rgba(color, 0.34 * strength)],
    [0.55, rgba(color, 0.13 * strength)],
    [1, rgba(color, 0)],
  ],
});

/** Even n-pointed star in design space. */
function starPoints(cx, cy, outer, inner, points, rot) {
  const pts = [];
  const turn = (Math.PI * 2) / (points * 2);
  for (let i = 0; i < points * 2; i++) {
    const a = (rot == null ? -Math.PI / 2 : rot) + i * turn;
    const r = i % 2 === 0 ? outer : inner;
    pts.push([
      Math.round((cx + Math.cos(a) * r) * 100) / 100,
      Math.round((cy + Math.sin(a) * r) * 100) / 100,
    ]);
  }
  return pts;
}

/** Warm highlight sliver used by most glyphs. */
function shine(d, x1, y1, w, alpha) {
  return path(d, null, { s: rgba(WHITE, alpha || 0.55), w: w || 3.4 });
}

/* ------------------------------------------------------------- item glyphs */

function bananaGlyph(color, id) {
  const body = 'M 20 30 C 22 58, 34 78, 54 78 C 74 78, 82 58, 80 30 C 72 46, 62 58, 52 58 C 40 58, 28 46, 20 30 Z';
  return [
    ellipse(50, 86, 31, 6, rgba(BLACK, 0.22), { s: null, w: 0 }),
    path(body, id + '-body', {}),
    path('M 27 35 C 31 50, 39 60, 49 63', null, { s: rgba(WHITE, 0.5), w: 3.2 }),
    ellipse(20.6, 30.4, 3.6, 3.1, '#7a4a1c', { w: 2.6, rot: 0.5 }),
    ellipse(79.4, 30.4, 3.6, 3.1, '#7a4a1c', { w: 2.6, rot: -0.5 }),
  ];
}

function shellGlyph(color, id) {
  return [
    ellipse(50, 87, 31, 6, rgba(BLACK, 0.24), { s: null, w: 0 }),
    path('M 14 57 C 14 76, 30 87, 50 87 C 70 87, 86 76, 86 57 Z', id + '-under', {}),
    path('M 14 57 C 14 29, 30 15, 50 15 C 70 15, 86 29, 86 57 Z', id + '-dome', {}),
    circle(36, 33, 7.6, rgba(WHITE, 0.95), { s: null, w: 0 }),
    circle(63, 32, 6.4, rgba(WHITE, 0.95), { s: null, w: 0 }),
    circle(50, 49, 5.2, rgba(WHITE, 0.95), { s: null, w: 0 }),
    path('M 16 55 C 25 64, 75 64, 84 55', null, { s: rgba(WHITE, 0.45), w: 3 }),
    ellipse(37, 26, 8.5, 4.6, rgba(WHITE, 0.5), { s: null, w: 0, rot: -0.5 }),
  ];
}

function mushroomGlyph(color, id) {
  return [
    ellipse(50, 92, 26, 5, rgba(BLACK, 0.22), { s: null, w: 0 }),
    path('M 34 50 L 34 74 C 34 84, 40 89, 50 89 C 60 89, 66 84, 66 74 L 66 50 Z', id + '-stem', {}),
    path('M 55 51 L 55 76 C 58 83, 63 83, 66 78 L 66 51 Z', rgba(BLACK, 0.07), { s: null, w: 0 }),
    path('M 12 52 C 12 24, 29 12, 50 12 C 71 12, 88 24, 88 52 Z', id + '-cap', {}),
    ellipse(29, 33, 10.5, 8.5, WHITE, { s: null, w: 0 }),
    ellipse(67, 31, 8.5, 7, WHITE, { s: null, w: 0 }),
    ellipse(48, 43, 7.5, 6, WHITE, { s: null, w: 0 }),
    ellipse(57, 45, 4.6, 3.8, WHITE, { s: null, w: 0 }),
    ellipse(43, 68, 3.1, 4.1, INK, { s: null, w: 0 }),
    ellipse(57, 68, 3.1, 4.1, INK, { s: null, w: 0 }),
    path('M 44 78 Q 50 84 56 78', null, { s: INK, w: 3.2 }),
  ];
}

function starGlyph(color, id) {
  return [
    poly(starPoints(50, 52, 41, 17.5, 5), id + '-core', {}),
    ellipse(43, 47, 3.2, 4.2, INK, { s: null, w: 0 }),
    ellipse(57, 47, 3.2, 4.2, INK, { s: null, w: 0 }),
    ellipse(41.4, 45.4, 1.1, 1.4, WHITE, { s: null, w: 0 }),
    ellipse(55.4, 45.4, 1.1, 1.4, WHITE, { s: null, w: 0 }),
    path('M 44 57 Q 50 63.5 56 57', null, { s: INK, w: 3.2 }),
    ellipse(38, 31, 8, 4, rgba(WHITE, 0.55), { s: null, w: 0, rot: -0.55 }),
    poly(starPoints(14, 22, 5.5, 2.2, 4), lighten(color, 0.4), { s: null, w: 0, op: 0.95 }),
    poly(starPoints(88, 32, 4.4, 1.8, 4), lighten(color, 0.4), { s: null, w: 0, op: 0.85 }),
    poly(starPoints(84, 12, 3.4, 1.4, 4), lighten(color, 0.55), { s: null, w: 0, op: 0.7 }),
  ];
}

function boltGlyph(color, id) {
  return [
    poly([[58, 8], [28, 52], [44, 52], [36, 92], [70, 46], [54, 46]], id + '-core', {}),
    poly([[54, 24], [40, 50], [45, 50], [42, 78], [62, 48], [53, 48]], rgba(WHITE, 0.8), { s: null, w: 0 }),
    path('M 84 30 Q 92 40 86 52', null, { s: rgba(color, 0.9), w: 3.6 }),
    path('M 14 60 Q 7 70 13 82', null, { s: rgba(color, 0.9), w: 3.6 }),
    poly(starPoints(84, 76, 6, 2.4, 4), rgba(WHITE, 0.9), { s: null, w: 0 }),
    poly(starPoints(13, 24, 4.6, 1.9, 4), rgba(WHITE, 0.75), { s: null, w: 0 }),
  ];
}

function inkGlyph(color, id) {
  return [
    path('M 34 58 C 32 72, 36 80, 30 88', null, { s: darken(color, 0.2), w: 6.4 }),
    path('M 44 62 C 42 74, 46 83, 41 89', null, { s: darken(color, 0.2), w: 6.4 }),
    path('M 58 62 C 56 74, 60 83, 55 89', null, { s: darken(color, 0.2), w: 6.4 }),
    path('M 66 58 C 67 72, 71 80, 66 87', null, { s: darken(color, 0.2), w: 6.4 }),
    circle(50, 40, 25, id + '-head', {}),
    path('M 27 45 C 35 60, 65 60, 73 45', null, { s: INK, w: 4.2 }),
    ellipse(41, 38, 8, 9.4, WHITE, { w: 3.4 }),
    ellipse(59, 38, 8, 9.4, WHITE, { w: 3.4 }),
    ellipse(41.8, 39.6, 3.6, 4.3, INK, { s: null, w: 0 }),
    ellipse(57.8, 39.6, 3.6, 4.3, INK, { s: null, w: 0 }),
    ellipse(39.4, 35.4, 1.4, 1.7, WHITE, { s: null, w: 0 }),
    ellipse(55.4, 35.4, 1.4, 1.7, WHITE, { s: null, w: 0 }),
    path('M 44 55 Q 50 61 56 55', null, { s: INK, w: 3.2 }),
    ellipse(50, 27, 9, 5, rgba(WHITE, 0.4), { s: null, w: 0, rot: -0.3 }),
  ];
}

function bulletGlyph(color, id) {
  return [
    poly([[80, 40], [97, 50], [80, 60]], id + '-flame', { s: null, w: 0, op: 0.95 }),
    poly([[80, 45], [92, 50], [80, 55]], rgba('#fff6c0', 0.9), { s: null, w: 0 }),
    path('M 6 50 L 26 32 L 54 32 C 70 32, 80 40, 80 50 C 80 60, 70 68, 54 68 L 26 68 L 6 50 Z', id + '-body', {}),
    ellipse(34, 41, 10, 6.6, '#cfe4ff', { w: 3, rot: -0.1 }),
    ellipse(31, 40.5, 3.1, 3.9, INK, { s: null, w: 0 }),
    ellipse(38, 40.5, 3.1, 3.9, INK, { s: null, w: 0 }),
    ellipse(29.4, 38.6, 1.1, 1.4, WHITE, { s: null, w: 0 }),
    shine('M 21 36 C 33 33, 45 32, 56 33', 0.45, 0.45, 3),
    path('M 20 62 C 32 66, 44 67, 55 66', null, { s: rgba(WHITE, 0.18), w: 3 }),
  ];
}

function hornGlyph(color, id) {
  return [
    path('M 26 42 Q 15 50 26 58', null, { s: rgba(color, 0.8), w: 3.8 }),
    path('M 17 34 Q 2 50 17 66', null, { s: rgba(color, 0.45), w: 3.2 }),
    path('M 30 76 C 44 62, 58 48, 76 34 L 96 50 C 78 62, 62 76, 50 90 Z', id + '-cone', {}),
    ellipse(78, 60, 23, 27, id + '-bell', { rot: -0.55 }),
    ellipse(73, 61, 10, 13, rgba(BLACK, 0.32), { s: INK, w: 3.2, rot: -0.55 }),
    path('M 55 62 L 78 44', null, { s: '#ff3b30', w: 7.4 }),
    path('M 55 62 L 78 44', null, { s: rgba(BLACK, 0.22), w: 1.6 }),
    shine('M 40 66 C 50 56, 60 46, 70 40', 0, 0, 4),
    poly(starPoints(20, 86, 5.4, 2.2, 4), lighten(color, 0.45), { s: null, w: 0, op: 0.9 }),
  ];
}

/* ------------------------------------------------------------- recipe glue */

/**
 * Gradient definitions for one glyph, derived from the item colour.
 * The ids are namespaced by `id` so several icons can share a document.
 */
function glyphGradients(kind, color, id) {
  const stops = {
    banana: [
      grad(id + '-body', 24, 28, 62, 80, [
        [0, lighten(color, 0.62)],
        [0.45, color],
        [1, darken(color, 0.3)],
      ]),
    ],
    shell: [
      grad(id + '-under', 20, 60, 80, 90, [
        [0, darken(color, 0.42)],
        [1, darken(color, 0.62)],
      ]),
      grad(id + '-dome', 26, 12, 78, 62, [
        [0, lighten(color, 0.5)],
        [0.55, color],
        [1, darken(color, 0.14)],
      ]),
    ],
    mushroom: [
      grad(id + '-stem', 40, 50, 66, 90, [
        [0, '#fffaf0'],
        [1, '#e8d3ae'],
      ]),
      grad(id + '-cap', 20, 14, 82, 56, [
        [0, lighten(color, 0.38)],
        [0.6, color],
        [1, darken(color, 0.22)],
      ]),
    ],
    star: [
      grad(id + '-core', 50, 12, 52, 90, [
        [0, lighten(color, 0.58)],
        [0.5, color],
        [1, darken(color, 0.2)],
      ]),
    ],
    bolt: [
      grad(id + '-core', 30, 8, 70, 92, [
        [0, '#f4feff'],
        [0.42, lighten(color, 0.2)],
        [1, darken(color, 0.28)],
      ]),
    ],
    ink: [
      grad(id + '-head', 26, 16, 76, 66, [
        [0, lighten(color, 0.38)],
        [0.6, color],
        [1, darken(color, 0.24)],
      ]),
    ],
    bullet: [
      grad(id + '-flame', 78, 40, 98, 50, [
        [0, lighten('#ff9500', 0.3)],
        [1, rgba('#ff3b30', 0.05)],
      ]),
      grad(id + '-body', 8, 30, 80, 70, [
        [0, '#8e98a8'],
        [0.4, color],
        [1, '#20242e'],
      ]),
    ],
    horn: [
      grad(id + '-cone', 32, 34, 92, 88, [
        [0, lighten(color, 0.5)],
        [0.55, color],
        [1, darken(color, 0.26)],
      ]),
      grad(id + '-bell', 60, 34, 96, 84, [
        [0, lighten(color, 0.3)],
        [1, darken(color, 0.1)],
      ]),
    ],
  };
  return stops[kind] || [];
}

/**
 * Full op list for one item.
 * @param {object|null} def ItemDef
 * @param {string} uid namespaces the gradient ids so several icons can share a document
 */
function recipe(def, uid) {
  const d = def || getItem('banana');
  const id = uid || 'g' + uidCounter++;
  const color = d.color || '#ffd60a';
  const ops = [backdrop(color, 1), ...glyphGradients(d.art, color, id)];

  const glyphOf = {
    banana: bananaGlyph,
    shell: shellGlyph,
    mushroom: mushroomGlyph,
    star: starGlyph,
    bolt: boltGlyph,
    ink: inkGlyph,
    bullet: bulletGlyph,
    horn: hornGlyph,
  };
  const make = glyphOf[d.art] || bananaGlyph;
  const glyph = make(color, id);

  switch (d.id) {
    case 'tripleBanana':
      ops.push(group(bananaGlyph(color, id), { tx: -21, ty: 17, sc: 0.58, rot: -0.5 }));
      ops.push(group(bananaGlyph(color, id), { tx: 21, ty: 17, sc: 0.58, rot: 0.5 }));
      ops.push(...glyph);
      break;
    case 'tripleGreenShell':
    case 'tripleMushroom':
      ops.push(group(glyph, { tx: -16, ty: 14, sc: 0.62, rot: -0.26 }));
      ops.push(group(glyph, { tx: 16, ty: 14, sc: 0.62, rot: 0.26 }));
      ops.push(...glyph);
      break;
    case 'goldenMushroom':
      ops.push(group([
        circle(50, 62, 34, rgba(color, 0.16), { s: null, w: 0 }),
        poly(starPoints(50, 60, 30, 12, 8), rgba(lighten(color, 0.3), 0.28), { s: null, w: 0 }),
      ]));
      ops.push(group(glyph, { sc: 0.96, ty: -2 }));
      break;
    case 'redShell':
      ops.push(group(glyph, { sc: 1.02 }));
      break;
    case 'bulletBill':
      ops.push(group(glyph, { rot: -0.32, tx: 1, ty: -1, sc: 1.04 }));
      break;
    default:
      ops.push(...glyph);
      break;
  }
  return ops;
}

/* -------------------------------------------------------------- SVG output */

/** `<path>`/`<ellipse>`/`<polygon>` paint refs. */
function svgPaint(v) {
  if (!v) return ' fill="none"';
  return /^(#|rgb)/.test(v) ? ' fill="' + v + '"' : ' fill="url(#' + v + ')"';
}

function svgOps(ops, uid, out) {
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    switch (op.t) {
      case 'bg': {
        const gid = 'ibg' + uid + '_' + i;
        out.defs += '<radialGradient id="' + gid + '" cx="50%" cy="46%" r="58%">';
        for (const [off, col] of op.stops) {
          out.defs += '<stop offset="' + off + '" stop-color="' + col + '"/>';
        }
        out.defs += '</radialGradient>';
        out.body += '<rect x="2" y="2" width="96" height="96" rx="26" fill="url(#' + gid + ')"/>';
        break;
      }
      case 'g': {
        out.defs += '<linearGradient id="' + op.id + '" x1="' + op.x1 + '" y1="' + op.y1 +
          '" x2="' + op.x2 + '" y2="' + op.y2 + '">';
        for (const [off, col] of op.stops) {
          out.defs += '<stop offset="' + off + '" stop-color="' + col + '"/>';
        }
        out.defs += '</linearGradient>';
        break;
      }
      case 'grp': {
        // translate(50 50) [tx ty] rotate(r) scale(s) translate(-50 -50): every
        // glyph is authored about (50,50), so sub-glyphs rotate and scale in place.
        out.body += '<g transform="translate(50 50) translate(' + op.tx + ' ' + op.ty + ') rotate(' +
          ((op.rot * 180) / Math.PI).toFixed(2) + ') scale(' + op.sc + ') translate(-50 -50)">';
        svgOps(op.ops, uid + '_' + i, out);
        out.body += '</g>';
        break;
      }
      case 'p': {
        const stroke = op.s ? ' stroke="' + op.s + '" stroke-width="' + op.w + '"' : '';
        out.body += '<path d="' + op.d + '"' + svgPaint(op.f) + stroke +
          ' stroke-linecap="round" stroke-linejoin="round"' +
          (op.op !== 1 ? ' opacity="' + op.op + '"' : '') + '/>';
        break;
      }
      case 'e': {
        const stroke = op.s ? ' stroke="' + op.s + '" stroke-width="' + op.w + '"' : '';
        out.body += '<ellipse cx="' + op.cx + '" cy="' + op.cy + '" rx="' + op.rx + '" ry="' + op.ry +
          '"' + (op.rot ? ' transform="rotate(' + ((op.rot * 180) / Math.PI).toFixed(2) + ' ' +
            op.cx + ' ' + op.cy + ')"' : '') +
          svgPaint(op.f) + stroke + (op.op !== 1 ? ' opacity="' + op.op + '"' : '') + '/>';
        break;
      }
      case 'y': {
        const pts = op.pts.map((p) => p[0] + ',' + p[1]).join(' ');
        const stroke = op.s ? ' stroke="' + op.s + '" stroke-width="' + op.w + '"' : '';
        out.body += '<polygon points="' + pts + '"' + svgPaint(op.f) + stroke +
          ' stroke-linejoin="round"' + (op.op !== 1 ? ' opacity="' + op.op + '"' : '') + '/>';
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * Inline SVG string for the HUD item slot, crisp at any size (118 px by design).
 * @param {string} itemId
 * @param {{size?:number, uid?:number, className?:string, title?:boolean}} [opts]
 * @returns {string}
 */
export function itemIconSVG(itemId, opts) {
  const o = opts || {};
  const def = getItem(itemId);
  const id = o.uid == null ? 'i' + uidCounter++ : String(o.uid);
  const ops = recipe(def, id);
  const parts = svgOps(ops, id, { defs: '', body: '' });
  const label = def ? def.name : 'No item';
  const dim = o.size ? ' width="' + o.size + '" height="' + o.size + '"' : '';
  const cls = o.className ? ' class="' + o.className + '"' : '';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"' + dim + cls +
    ' role="img" aria-label="' + label + '"' +
    ' style="overflow:visible;filter:drop-shadow(0 4px 6px rgba(0,0,0,.5))">' +
    (o.title === false ? '' : '<title>' + label + '</title>') +
    '<defs>' + parts.defs + '</defs>' + parts.body + '</svg>';
}

/* ----------------------------------------------------------- Canvas output */

function paintOps(ctx, ops, grads) {
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    switch (op.t) {
      case 'bg': {
        const g = ctx.createRadialGradient(50, 46, 2, 50, 46, 56);
        for (const [off, col] of op.stops) g.addColorStop(off, col);
        ctx.fillStyle = g;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') ctx.roundRect(2, 2, 96, 96, 26);
        else ctx.rect(2, 2, 96, 96);
        ctx.fill();
        break;
      }
      case 'g': {
        const g = ctx.createLinearGradient(op.x1, op.y1, op.x2, op.y2);
        for (const [off, col] of op.stops) g.addColorStop(off, col);
        grads.set(op.id, g);
        break;
      }
      case 'grp': {
        ctx.save();
        ctx.translate(50, 50);
        ctx.translate(op.tx, op.ty);
        if (op.rot) ctx.rotate(op.rot);
        if (op.sc) ctx.scale(op.sc, op.sc);
        ctx.translate(-50, -50);
        paintOps(ctx, op.ops, grads);
        ctx.restore();
        break;
      }
      case 'p': {
        const p = new Path2D(op.d);
        ctx.globalAlpha = op.op;
        if (op.f) {
          ctx.fillStyle = grads.get(op.f) || op.f;
          ctx.fill(p);
        }
        if (op.s) {
          ctx.strokeStyle = op.s;
          ctx.lineWidth = op.w;
          ctx.stroke(p);
        }
        ctx.globalAlpha = 1;
        break;
      }
      case 'e': {
        ctx.globalAlpha = op.op;
        ctx.beginPath();
        ctx.ellipse(op.cx, op.cy, op.rx, op.ry, op.rot, 0, Math.PI * 2);
        if (op.f) {
          ctx.fillStyle = grads.get(op.f) || op.f;
          ctx.fill();
        }
        if (op.s) {
          ctx.strokeStyle = op.s;
          ctx.lineWidth = op.w;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        break;
      }
      case 'y': {
        ctx.globalAlpha = op.op;
        ctx.beginPath();
        ctx.moveTo(op.pts[0][0], op.pts[0][1]);
        for (let k = 1; k < op.pts.length; k++) ctx.lineTo(op.pts[k][0], op.pts[k][1]);
        if (op.close) ctx.closePath();
        if (op.f) {
          ctx.fillStyle = grads.get(op.f) || op.f;
          ctx.fill();
        }
        if (op.s) {
          ctx.strokeStyle = op.s;
          ctx.lineWidth = op.w;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        break;
      }
      default:
        break;
    }
  }
}

/**
 * Paints the item icon straight into a 2D context (cards, thumbnails, canvas HUDs).
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} itemId
 * @param {number} size target square size in pixels
 */
export function drawItemIcon(ctx, itemId, size) {
  if (!ctx) return;
  const def = getItem(itemId);
  const s = Math.max(8, +size || 100);
  const ops = recipe(def, 'c' + uidCounter++);
  const prevAlpha = ctx.globalAlpha;
  ctx.save();
  if (typeof ctx.clearRect === 'function') ctx.clearRect(0, 0, s, s);
  ctx.scale(s / DESIGN, s / DESIGN);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  paintOps(ctx, ops, new Map());
  ctx.restore();
  ctx.globalAlpha = prevAlpha;
}

/** Every known icon in catalogue order — used by the item gallery and tests. */
export function itemIconSVGs(uid) {
  return ITEMS.map((def) => itemIconSVG(def.id, { uid }));
}

export default itemIconSVG;
