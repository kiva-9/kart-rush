/**
 * Tiny typed event bus.
 * All cross-system communication goes through this so modules stay decoupled.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._map = new Map();
  }

  /** @returns {() => void} unsubscribe */
  on(type, fn) {
    let set = this._map.get(type);
    if (!set) this._map.set(type, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  emit(type, payload) {
    const set = this._map.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] listener for "${type}" threw`, err);
      }
    }
  }

  clear() {
    this._map.clear();
  }
}
