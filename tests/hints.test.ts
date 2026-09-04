/**
 * Layout hints: hand-corrected coordinates applied on top of a finished layout, and the
 * rule that keeps the build honest — an area with hints is laid out twice, and hints that
 * make the map worse are dropped in favour of the plain algorithm.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeLayout } from '../src/layout/layout.js';
import {
  buildHints, countBentEdges, countWarps, hintSummary, pickLayout, readHints,
} from '../src/layout/hints.js';
import type { AreaLayout, AreaMeta, Room } from '../src/types.js';

const meta = (file = 'test'): AreaMeta => ({
  file, name: file, vnumLow: 0, vnumHigh: 100,
  levelLow: 1, levelHigh: 10, authors: '', flags: [],
});

const room = (vnum: number, exits: Room['exits'] = []): Room => ({
  vnum, area: 'test', name: `Room ${vnum}`, description: '',
  sector: 'inside', flags: [], exits,
});

/** A straight east-west corridor of `n` rooms, vnums 1..n. */
function corridor(n: number): Room[] {
  const rooms: Room[] = [];
  for (let i = 1; i <= n; i++) {
    const exits: Room['exits'] = [];
    if (i > 1) exits.push({ dir: 'west', target: i - 1, flags: [] });
    if (i < n) exits.push({ dir: 'east', target: i + 1, flags: [] });
    rooms.push(room(i, exits));
  }
  return rooms;
}

/**
 * A layout carrying exactly `n` crooked edges — for testing the choice rule alone.
 * Every edge points north at a room placed south of it, so it is bent by any measure.
 */
function withWarps(n: number): AreaLayout {
  const placed: Record<number, unknown> = { 1: { vnum: 1, x: 0, y: 0, z: 0, cluster: 0 } };
  const exits = Array.from({ length: n }, (_, i) => {
    placed[2 + i] = { vnum: 2 + i, x: 0, y: -3 - i, z: 0, cluster: 0 };
    return { from: 1, to: 2 + i, dir: 'north' as const, style: 'warp' as const, flags: [] };
  });
  return {
    meta: meta(), rooms: {}, placed, exits,
    zLayers: [0], bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, clusters: 1,
  } as unknown as AreaLayout;
}

describe('hint files', () => {
  it('validates entries against the area and drops what cannot be used', () => {
    const rooms = corridor(4);
    const { hints, warnings } = buildHints({
      rooms: {
        '1': { x: 0, y: 0, z: 0 },
        '2': { x: 5, y: 0, z: 0 },
        '3': { x: 0, y: 2.5, z: 0 },     // halves are legal: a room between two rows
        '99': { x: 1, y: 1, z: 0 },      // no such room in this area
        '4': { x: 'left', y: 0, z: 0 },  // not a number at all
      },
    }, rooms);

    expect([...hints.keys()].sort()).toEqual([1, 2, 3]);
    expect(hints.get(3)).toEqual({ x: 0, y: 2.5, z: 0 });
    expect(warnings.join(' ')).toMatch(/99/);
    expect(warnings.join(' ')).toMatch(/must be numbers/);
  });

  it('drops BOTH rooms when two hints claim one cell', () => {
    // Which of the two the author meant is unknowable, and letting one win silently
    // would move a room to a place nobody asked for.
    const { hints, warnings } = buildHints({
      rooms: { '1': { x: 2, y: 2, z: 0 }, '2': { x: 2, y: 2, z: 0 } },
    }, corridor(2));

    expect(hints.size).toBe(0);
    expect(warnings.join(' ')).toMatch(/same cell/);
  });

  it('reads a file per area and shrugs at a missing one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hints-'));
    fs.writeFileSync(path.join(dir, 'test.json'),
      JSON.stringify({ area: 'test', rooms: { '2': { x: 7, y: 0, z: 0 } } }));

    const load = readHints(dir, 'test', corridor(3));
    expect(load?.hints.get(2)).toEqual({ x: 7, y: 0, z: 0 });
    expect(readHints(dir, 'nosuch', corridor(3))).toBeNull();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('computeLayout with hints', () => {
  it('pins hinted rooms exactly where the hint says', () => {
    const rooms = corridor(3);
    const plain = computeLayout(meta(), rooms, {});
    const hints = new Map([[1, { x: 4, y: 9, z: 0 }], [2, { x: 8, y: 9, z: 0 }]]);
    const hinted = computeLayout(meta(), rooms, {}, hints);

    expect(hinted.placed[1]).toMatchObject({ x: 4, y: 9, z: 0 });
    expect(hinted.placed[2]).toMatchObject({ x: 8, y: 9, z: 0 });
    // The hints really changed the outcome — otherwise this test would pass by accident.
    expect(plain.placed[1]).not.toMatchObject({ x: 4, y: 9, z: 0 });
  });

  it('corrects only the named rooms and leaves the algorithm the rest', () => {
    const rooms = corridor(5);
    const plain = computeLayout(meta(), rooms, {});
    const hinted = computeLayout(meta(), rooms, {}, new Map([[1, { x: -9, y: 0, z: 0 }]]));

    // The hinted room moved; every other room stayed exactly where it was placed.
    expect(hinted.placed[1]).toMatchObject({ x: -9, y: 0, z: 0 });
    for (const r of rooms.slice(1)) {
      expect(hinted.placed[r.vnum]).toEqual(plain.placed[r.vnum]);
    }
  });

  it('accepts half cells — a room can sit between two rows', () => {
    // Halves are how the game's own maps separate stairs and diagonals, and the whole
    // reason the hint files exist. Whole-cell stepping used to hang on them.
    const rooms = corridor(3);
    const hinted = computeLayout(meta(), rooms, {}, new Map([[2, { x: 6, y: 0.5, z: 0 }]]));

    expect(hinted.placed[2]).toMatchObject({ x: 6, y: 0.5, z: 0 });
    expect(hinted.bounds.minY).toBeLessThanOrEqual(0);
    expect(hinted.exits.length).toBeGreaterThan(0);
  });

  it('places every room even when a hint drags one far away', () => {
    const rooms = corridor(4);
    const hinted = computeLayout(meta(), rooms, {}, new Map([[3, { x: -20, y: -20, z: 2 }]]));
    for (const r of rooms) expect(hinted.placed[r.vnum]).toBeTruthy();
    expect(hinted.placed[3]).toMatchObject({ x: -20, y: -20, z: 2 });
  });

  it('ignores a hint for a room this area does not have', () => {
    const rooms = corridor(3);
    const plain = computeLayout(meta(), rooms, {});
    const hinted = computeLayout(meta(), rooms, {}, new Map([[404, { x: 1, y: 1, z: 0 }]]));
    expect(hinted.placed).toEqual(plain.placed);
  });

  it('changes nothing for an area without hints', () => {
    const rooms = corridor(4);
    const plain = computeLayout(meta(), rooms, {});
    for (const hints of [undefined, null, new Map()]) {
      const again = computeLayout(meta(), rooms, {}, hints);
      expect(again.placed).toEqual(plain.placed);
      expect(again.exits).toEqual(plain.exits);
    }
  });
});

describe('counting bent edges', () => {
  // Grid cities (midgaard, smidgaard) are classified in relaxed mode: an edge counts as a
  // clean connector when the target is merely on the correct SIDE. Those edges render as
  // bends and detours, so `style === 'warp'` cannot be the measure of a crooked map.
  const city = (): AreaMeta => meta('midgaard');

  it('counts an edge whose straight line runs through another room', () => {
    // Midgaard 3078→3083 (Бюро Находок): dead east, but the armour shop sits in the way.
    const rooms = [
      room(1, [{ dir: 'east', target: 3, flags: [] }]),
      room(2),                                    // the shop in the way: no exits of its own
      room(3, [{ dir: 'west', target: 1, flags: [] }]),
    ];
    const out = computeLayout(city(), rooms, {}, new Map([
      [1, { x: 0, y: 0, z: 0 }], [2, { x: 2, y: 0, z: 0 }], [3, { x: 4, y: 0, z: 0 }],
    ]));

    const edge = out.exits.find((e) => e.from === 1 && e.to === 3);
    expect(edge?.style).toBe('open');      // the renderer draws a detour, not an arc
    expect(countWarps(out)).toBe(0);       // …so warps see nothing wrong
    expect(countBentEdges(out)).toBe(1);   // …but the connection is crooked all the same
  });

  it('counts an edge whose target sits off its axis', () => {
    // Midgaard 3006→3007 (Хрюкающий Кабан): east, and a row north as well.
    const rooms = [
      room(1, [{ dir: 'east', target: 2, flags: [] }]),
      room(2, [{ dir: 'west', target: 1, flags: [] }]),
    ];
    const out = computeLayout(city(), rooms, {}, new Map([
      [1, { x: 0, y: 0, z: 0 }], [2, { x: 3, y: 1, z: 0 }],
    ]));

    expect(out.exits[0].style).toBe('open');
    expect(countWarps(out)).toBe(0);
    expect(countBentEdges(out)).toBe(1);
  });

  it('calls a clean corridor clean, halves included', () => {
    const rooms = corridor(3);
    expect(countBentEdges(computeLayout(meta(), rooms, {}))).toBe(0);
    // Same corridor with every room shifted half a cell: still straight, still clean.
    const out = computeLayout(meta(), rooms, {}, new Map([
      [1, { x: 0.5, y: 0, z: 0 }], [2, { x: 3.5, y: 0, z: 0 }], [3, { x: 6.5, y: 0, z: 0 }],
    ]));
    expect(countBentEdges(out)).toBe(0);
  });

  it('does not count a staircase that misses its cell', () => {
    // The client shows one layer at a time, so a vertical link that does not land on the
    // exact same cell costs the reader nothing — and judging hints by it punished
    // corrections that were right about the floor a player walks on.
    const rooms = [
      room(1, [{ dir: 'up', target: 2, flags: [] }]),
      room(2, [{ dir: 'down', target: 1, flags: [] }]),
    ];
    const out = computeLayout(meta(), rooms, {}, new Map([
      [1, { x: 0, y: 0, z: 0 }], [2, { x: 5, y: 7, z: 1 }],
    ]));
    expect(out.placed[2]).toMatchObject({ x: 5, y: 7, z: 1 });
    expect(countBentEdges(out)).toBe(0);
  });

  it('does not count a link whose rooms ended up on different layers', () => {
    const rooms = corridor(2);
    const out = computeLayout(meta(), rooms, {}, new Map([[2, { x: 4, y: 3, z: -1 }]]));
    expect(out.placed[2].z).toBe(-1);
    expect(countBentEdges(out)).toBe(0);
  });

  it('does not count cross-area stubs or an unplaced target', () => {
    const rooms = [room(1, [{ dir: 'east', target: 900, flags: [] }])];
    const out = computeLayout(meta(), rooms, { 900: 'elsewhere' });
    expect(out.exits[0].style).toBe('cross_area');
    expect(countBentEdges(out)).toBe(0);
  });
});

describe('picking between the two layouts', () => {
  it('keeps the hinted layout when it has fewer warps', () => {
    const choice = pickLayout(withWarps(5), withWarps(2));
    expect(choice.used).toBe(true);
    expect(choice.bentNative).toBe(5);
    expect(choice.bentHinted).toBe(2);
    expect(countBentEdges(choice.layout)).toBe(2);
  });

  it('drops the hinted layout on a single extra warp', () => {
    const choice = pickLayout(withWarps(2), withWarps(3));
    expect(choice.used).toBe(false);
    expect(countBentEdges(choice.layout)).toBe(2);
  });

  it('falls back to the plain layout when hints make it worse', () => {
    // Stale hints: rooms 2 and 3 pinned on the wrong side of room 1, so exits that the
    // plain algorithm draws straight can no longer be embedded at all.
    const rooms = corridor(4);
    const native = computeLayout(meta(), rooms, {});
    const hinted = computeLayout(meta(), rooms, {}, new Map([
      [1, { x: 0, y: 0, z: 0 }],
      [2, { x: -6, y: 0, z: 0 }],   // "east of 1", pinned to the west
      [3, { x: -3, y: 5, z: 0 }],
      [4, { x: -9, y: -5, z: 0 }],
    ]));

    expect(countBentEdges(hinted)).toBeGreaterThan(countBentEdges(native));
    const choice = pickLayout(native, hinted);
    expect(choice.used).toBe(false);
    expect(choice.layout).toBe(native);
    expect(choice.layout.placed[2].x).toBeGreaterThan(choice.layout.placed[1].x);
  });

  it('keeps hints on a tie — an equal count is not a reason to undo a human', () => {
    // Two rooms with no exits at all: nothing can bend, so the counts must tie.
    const rooms = [room(1), room(2)];
    const native = computeLayout(meta(), rooms, {});
    const hinted = computeLayout(meta(), rooms, {}, new Map([[1, { x: 0, y: 3.5, z: 0 }]]));

    expect(countBentEdges(hinted)).toBe(countBentEdges(native));
    const choice = pickLayout(native, hinted);
    expect(choice.used).toBe(true);
    expect(choice.layout.placed[1].y).toBe(3.5);
  });

  it('reports no hints at all as "nothing to choose"', () => {
    const native = computeLayout(meta(), corridor(2), {});
    const choice = pickLayout(native, null);
    expect(choice.used).toBe(false);
    expect(choice.layout).toBe(native);
  });
});

describe('the run report', () => {
  it('names stale areas in ONE message and stays quiet when all is well', () => {
    expect(hintSummary([
      { area: 'haon', bentNative: 4, bentHinted: 2, warpsNative: 4, warpsHinted: 2, used: true, warnings: [] },
      { area: 'troy', bentNative: 4, bentHinted: 20, warpsNative: 4, warpsHinted: 20, used: false, warnings: [] },
    ])).toMatch(/stale \(1 of 2\)[\s\S]*troy: 20 bent edges with hints vs 4 without/);

    expect(hintSummary([
      { area: 'haon', bentNative: 4, bentHinted: 2, warpsNative: 4, warpsHinted: 2, used: true, warnings: [] },
    ])).toBeNull();
    expect(hintSummary([])).toBeNull();
  });

  it('mentions bad entries even when the hints still won', () => {
    const text = hintSummary([
      { area: 'haon', bentNative: 4, bentHinted: 2, warpsNative: 4, warpsHinted: 2, used: true,
        warnings: ['6013: no such room in this area'] },
    ]);
    expect(text).toMatch(/haon: 1 bad hint/);
    expect(text).toMatch(/6013/);
  });
});
