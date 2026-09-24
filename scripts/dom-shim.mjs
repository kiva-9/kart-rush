/**
 * Minimal browser shim so the canvas-driven modules (TrackBuilder, ItemSystem,
 * KartModel, UI art) can be exercised under plain node.
 * Everything here is a no-op or a plain object; the modules only need the API to
 * exist, not to render.
 */
function make2d() {
  const grad = { addColorStop() {} };
  const ctx = {
    canvas: { width: 8, height: 8 },
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
    shadowBlur: 0, shadowColor: '#000', shadowOffsetX: 0, shadowOffsetY: 0,
    filter: 'none', imageSmoothingEnabled: true, miterLimit: 10, lineDashOffset: 0,
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    bezierCurveTo() {}, quadraticCurveTo() {}, arc() {}, arcTo() {}, ellipse() {},
    rect() {}, roundRect() {}, fill() {}, stroke() {}, clip() {},
    fillRect() {}, strokeRect() {}, clearRect() {}, fillText() {}, strokeText() {},
    measureText: () => ({ width: 8 }),
    setLineDash() {}, getLineDash: () => [], translate() {}, rotate() {}, scale() {},
    transform() {}, setTransform() {}, resetTransform() {}, drawImage() {},
    createImageData: (w, h) => ({ data: new Uint8ClampedArray((w || 1) * (h || 1) * 4), width: w || 1, height: h || 1 }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray((w || 1) * (h || 1) * 4), width: w || 1, height: h || 1 }),
    putImageData() {}, createPattern: () => null, createLinearGradient: () => grad,
    createRadialGradient: () => grad, createConicGradient: () => grad,
    isPointInPath: () => false, getContextAttributes: () => ({}),
  };
  return ctx;
}

function makeCanvas(w = 8, h = 8) {
  const canvas = {
    width: w, height: h, style: {},
    getContext: (kind) => (kind === '2d' ? make2d() : null),
    toDataURL: () => 'data:,',
    toBlob(cb) { cb && cb(null); },
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute: () => null,
  };
  return canvas;
}

const elementStub = () => ({
  style: {}, dataset: {}, children: [], childNodes: [],
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  setAttribute() {}, getAttribute: () => null, removeAttribute() {},
  appendChild(c) { (this.children || []).push(c); return c; },
  append() {}, removeChild() {}, remove() {}, insertBefore(c) { return c; },
  addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  querySelector: () => null, querySelectorAll: () => [],
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
  focus() {}, blur() {}, cloneNode() { return elementStub(); },
  innerHTML: '', textContent: '', value: '', checked: false,
});

export function installDomShim() {
  const g = globalThis;
  if (g.__domShimInstalled) return;
  g.__domShimInstalled = true;

  g.document = {
    createElement: (tag) => (tag === 'canvas' ? makeCanvas() : elementStub()),
    createElementNS: (_ns, tag) => (tag === 'canvas' ? makeCanvas() : elementStub()),
    createTextNode: (t) => ({ textContent: String(t) }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    body: elementStub(),
    documentElement: elementStub(),
    head: elementStub(),
    font: { addEventListener() {}, removeEventListener() {}, ready: Promise.resolve([]) },
  };

  g.window = g.window || g;
  if (!g.window.devicePixelRatio) g.window.devicePixelRatio = 1;
  if (!g.window.innerWidth) g.window.innerWidth = 1280;
  if (!g.window.innerHeight) g.window.innerHeight = 720;
  if (!g.window.addEventListener) g.window.addEventListener = () => {};
  if (!g.window.removeEventListener) g.window.removeEventListener = () => {};
  if (!g.window.requestAnimationFrame) g.window.requestAnimationFrame = () => 0;
  if (!g.window.cancelAnimationFrame) g.window.cancelAnimationFrame = () => {};
  if (g.localStorage === undefined) {
    const store = new Map();
    g.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
      key: (i) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    };
  }
  if (g.navigator === undefined) g.navigator = { getGamepads: () => [], userAgent: 'node' };
  else if (g.navigator.getGamepads === undefined) g.navigator.getGamepads = () => [];
  if (g.performance === undefined) {
    g.performance = { now: () => Date.now() };
  }
  if (g.URL.createObjectURL === undefined) g.URL.createObjectURL = () => '';
  if (g.URL.revokeObjectURL === undefined) g.URL.revokeObjectURL = () => {};
}

export { makeCanvas, make2d };
