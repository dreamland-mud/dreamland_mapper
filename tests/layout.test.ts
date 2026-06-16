import { describe, it, expect } from 'vitest';
import { computeLayout } from '../src/layout/layout.js';
import type { AreaMeta, Room } from '../src/types.js';

const meta = (file = 'test'): AreaMeta => ({
  file, name: file, vnumLow: 0, vnumHigh: 100,
  levelLow: 1, levelHigh: 10, authors: '', flags: [],
});

const room = (vnum: number, exits: Room['exits'] = []): Room => ({
  vnum, area: 'test', name: `Room ${vnum}`, description: '',
  sector: 'inside', flags: [], exits,
});

describe('computeLayout', () => {
  it('places a single room at origin', () => {
    const r = room(1);
    const out = computeLayout(meta(), [r], {});
    expect(out.placed[1]).toMatchObject({ x: 0, y: 0, z: 0 });
  });

  it('places a 2-room corridor on E-W axis', () => {
    const r1 = room(1, [{ dir: 'east', target: 2, flags: [] }]);
    const r2 = room(2, [{ dir: 'west', target: 1, flags: [] }]);
    const out = computeLayout(meta(), [r1, r2], {});
    const a = out.placed[1], b = out.placed[2];
    expect(b.x).toBeGreaterThan(a.x);
    expect(a.y).toBe(b.y);
    // Reciprocal edge dedup → 1 emission.
    expect(out.exits.length).toBe(1);
  });

  it('places up/down as separate z layers', () => {
    const r1 = room(1, [{ dir: 'up', target: 2, flags: [] }]);
    const r2 = room(2, [{ dir: 'down', target: 1, flags: [] }]);
    const out = computeLayout(meta(), [r1, r2], {});
    expect(out.placed[1].z).toBe(0);
    expect(out.placed[2].z).toBe(1);
    expect(out.zLayers).toEqual([0, 1]);
  });

  it('marks twisted exit as warp', () => {
    // Triangle: 1-N-2, 2-N-3, 3-S-1 (impossible 2D)
    const r1 = room(1, [{ dir: 'north', target: 2, flags: [] }, { dir: 'south', target: 3, flags: [] }]);
    const r2 = room(2, [{ dir: 'north', target: 3, flags: [] }, { dir: 'south', target: 1, flags: [] }]);
    const r3 = room(3, [{ dir: 'south', target: 2, flags: [] }, { dir: 'north', target: 1, flags: [] }]);
    const out = computeLayout(meta(), [r1, r2, r3], {});
    const warps = out.exits.filter((e) => e.style === 'warp');
    expect(warps.length).toBeGreaterThan(0);
  });

  it('separates disconnected components into clusters', () => {
    const r1 = room(1, [{ dir: 'east', target: 2, flags: [] }]);
    const r2 = room(2, [{ dir: 'west', target: 1, flags: [] }]);
    const r10 = room(10, [{ dir: 'east', target: 11, flags: [] }]);
    const r11 = room(11, [{ dir: 'west', target: 10, flags: [] }]);
    const out = computeLayout(meta(), [r1, r2, r10, r11], {});
    expect(out.clusters).toBe(2);
    expect(out.placed[1].cluster).toBe(0);
    expect(out.placed[10].cluster).toBe(1);
    // Clusters must be horizontally separated.
    expect(out.placed[10].x).toBeGreaterThan(out.placed[2].x);
  });

  it('identifies maze rooms (all exits → same target)', () => {
    const r1 = room(1, [
      { dir: 'north', target: 2, flags: [] },
      { dir: 'south', target: 2, flags: [] },
      { dir: 'east', target: 2, flags: [] },
      { dir: 'west', target: 2, flags: [] },
    ]);
    const r2 = room(2);
    const out = computeLayout(meta(), [r1, r2], {});
    expect(out.placed[1].isVoid).toBe(true);
    expect(out.placed[1].voidReason).toBe('maze');
  });

  it('tags cross-area exits without trying to place target', () => {
    const r1 = room(1, [{ dir: 'east', target: 99, flags: [] }]);
    const out = computeLayout(meta('here'), [r1], { 99: 'elsewhere' });
    expect(out.placed[99]).toBeUndefined();
    const ca = out.exits.find((e) => e.style === 'cross_area');
    expect(ca?.targetArea).toBe('elsewhere');
  });

  it('clears a blocker sitting on a cardinal connector path', () => {
    // Force a layout where 3 rooms end up colinear: A--B--C, A↔C is a long west exit,
    // B sits between them on the same row. We want the resolver to either cascade B
    // off the row, or demote A↔C to warp. Either way, the straight cardinal path
    // must not cross B's tile.
    //
    // Construction: south column from anchor 1 → 2; east from 2 → 3 → 4. Then add a
    // long west exit 4 → 2 that, before the resolver, would skim over 3.
    const r1 = room(1, [
      { dir: 'south', target: 2, flags: [] },
    ]);
    const r2 = room(2, [
      { dir: 'north', target: 1, flags: [] },
      { dir: 'east', target: 3, flags: [] },
    ]);
    const r3 = room(3, [
      { dir: 'west', target: 2, flags: [] },
      { dir: 'east', target: 4, flags: [] },
    ]);
    const r4 = room(4, [
      { dir: 'west', target: 3, flags: [] },
    ]);
    const out = computeLayout(meta(), [r1, r2, r3, r4], {});
    // For each cardinal axis-aligned edge, no other placed room should sit on the
    // path between its endpoints.
    for (const e of out.exits) {
      if (e.style === 'warp' || e.style === 'cross_area') continue;
      if (e.dir === 'up' || e.dir === 'down') continue;
      const a = out.placed[e.from], b = out.placed[e.to];
      if (!a || !b) continue;
      if (a.z !== b.z) continue;
      if (a.x !== b.x && a.y !== b.y) continue;
      const dx = Math.sign(b.x - a.x);
      const dy = Math.sign(b.y - a.y);
      let x = a.x + dx, y = a.y + dy;
      while (x !== b.x || y !== b.y) {
        for (const p of Object.values(out.placed)) {
          if (p.vnum === e.from || p.vnum === e.to) continue;
          if (p.z !== a.z) continue;
          expect([p.x, p.y]).not.toEqual([x, y]);
        }
        x += dx; y += dy;
      }
    }
  });

  it('classifies door exit styles correctly', () => {
    const r1 = room(1, [
      { dir: 'east', target: 2, flags: ['isdoor', 'closed'] },
      { dir: 'west', target: 3, flags: ['isdoor', 'closed', 'locked'] },
      { dir: 'north', target: 4, flags: ['isdoor', 'closed', 'pickproof'] },
    ]);
    const r2 = room(2); const r3 = room(3); const r4 = room(4);
    const out = computeLayout(meta(), [r1, r2, r3, r4], {});
    const styles = out.exits.map((e) => e.style).sort();
    expect(styles).toContain('door_closed');
    expect(styles).toContain('door_locked');
    expect(styles).toContain('door_pickproof');
  });
});
