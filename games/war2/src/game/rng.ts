// xorshift32 — deterministic, seeded, no Math.random() in sim logic.
let _s = 1;

export function seedRng(seed: number): void {
    _s = (seed >>> 0) || 1;
}

export function getRngState(): number { return _s; }
export function setRngState(s: number): void { _s = (s >>> 0) || 1; }

export function nextU32(): number {
    _s ^= _s << 13;
    _s ^= _s >> 17;
    _s ^= _s << 5;
    return _s >>> 0;
}

/** Integer in [lo, hi) */
export function rngRange(lo: number, hi: number): number {
    return lo + (nextU32() % (hi - lo));
}
