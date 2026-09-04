/**
 * Layout hints — hand-corrected room coordinates that seed the layout.
 *
 * `computeLayout` places rooms by algorithm alone, and for some areas no algorithm gets
 * it right: the graph simply isn't planar, or the "true" shape is knowledge a player has
 * and the exits don't carry. A hint file names rooms and where they really belong; the
 * layout runs as usual and the hints are applied ON TOP of the result, correcting those
 * rooms and leaving the rest of the algorithm's work alone.
 *
 * Hints are ADVICE, never law. The build computes the area twice — with and without —
 * and drops the hinted run as soon as it has MORE warps, so a stale hint file can only
 * cost build time, never map quality. See `pickLayout`.
 *
 * Coordinates may be fractional. A half places a room between two rows, which is how the
 * game's own maps separate stairs and diagonals; the grid has no integer requirement.
 *
 * File per area, named after the area file: `hints/<area>.json`
 *
 *   {
 *     "area": "haon",
 *     "source": "where these came from",
 *     "updated": "2026-09-04",
 *     "rooms": { "6013": { "x": 0, "y": -9, "z": 0 } }
 *   }
 *
 * Everything but `rooms` is documentation. Unknown vnums and duplicate cells are dropped
 * with a warning rather than failing the build: hints go stale as areas are rebuilt, and
 * a stale hint must never stop the nightly regen.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AreaLayout, Direction, PlacedRoom, Room } from '../types.js';
import { DIR_DELTAS } from '../types.js';

export interface HintSpot {
  x: number;
  y: number;
  z: number;
}

export type Hints = Map<number, HintSpot>;

export interface HintLoad {
  hints: Hints;
  /** Human-readable complaints: unknown vnums, duplicate cells, malformed entries. */
  warnings: string[];
}

const cellKey = (s: HintSpot) => `${s.x},${s.y},${s.z}`;

/**
 * Validate a parsed hint file against the area's actual rooms. Fractional x/y are fine;
 * z is a floor number and stays whole.
 *
 * `rooms` is the area's room list; a hint for a vnum outside it is dropped (the room was
 * moved to another area or deleted). Two hints on one cell are both dropped: which of the
 * two the author meant is unknowable, and one of them would silently win.
 */
export function buildHints(raw: unknown, rooms: Room[]): HintLoad {
  const warnings: string[] = [];
  const hints: Hints = new Map();
  const source = (raw as { rooms?: Record<string, unknown> } | null)?.rooms;
  if (!source || typeof source !== 'object') {
    return { hints, warnings: ['no "rooms" object in hint file'] };
  }
  const known = new Set(rooms.map((r) => r.vnum));
  const byCell = new Map<string, number>();

  for (const [key, value] of Object.entries(source)) {
    const vnum = Number(key);
    const spot = value as Partial<HintSpot> | null;
    if (!Number.isFinite(vnum) || !spot || typeof spot !== 'object') {
      warnings.push(`bad entry ${key}`);
      continue;
    }
    const x = Number(spot.x);
    const y = Number(spot.y);
    const z = Number(spot.z ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isInteger(z)) {
      warnings.push(`${vnum}: x and y must be numbers, z a whole layer`);
      continue;
    }
    if (!known.has(vnum)) {
      warnings.push(`${vnum}: no such room in this area`);
      continue;
    }
    const at = cellKey({ x, y, z });
    const rival = byCell.get(at);
    if (rival !== undefined) {
      warnings.push(`${vnum} and ${rival}: same cell ${at}`);
      hints.delete(rival);
      continue;
    }
    byCell.set(at, vnum);
    hints.set(vnum, { x, y, z });
  }
  return { hints, warnings };
}

/** Read `<dir>/<area>.json`, if it exists. Missing file → null (the normal case). */
export function readHints(dir: string, area: string, rooms: Room[]): HintLoad | null {
  const file = path.join(dir, `${area}.json`);
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return { hints: new Map(), warnings: [`unreadable: ${(e as Error).message}`] };
  }
  return buildHints(raw, rooms);
}

/** Warps are the edges the renderer draws as arcs and sticks rather than as connectors. */
export function countWarps(layout: AreaLayout): number {
  return layout.exits.filter((e) => e.style === 'warp').length;
}

/**
 * BENT EDGES — the honest count of connections a player sees as crooked.
 *
 * `style === 'warp'` is NOT that count. Grid cities are classified in relaxed mode
 * (`isCorrectSide` in layout.ts), where an edge counts as a clean connector as long as the
 * target lies on the right SIDE, even when it is a row off the axis or its straight line
 * runs through another room. Those render as bends and detours, and in Midgaard alone two
 * of them are plainly visible: 3078→3083 (Бюро Находок, straight east but through the
 * armour shop) and 3006→3007 (the Snorting Boar, east and one row north). Counting warps
 * would call both of them clean, so hints that straighten them would look worthless.
 *
 * An edge is straight when it is aligned on its own axis, points the declared way, and has
 * an empty corridor between the two rooms. Anything else is bent — including an edge whose
 * target was never placed.
 *
 * NOT COUNTED, because they are never drawn as a line on the plane:
 *   - up/down exits and any link whose two rooms sit on different z. The client shows one
 *     layer at a time, so a staircase that does not land on the exact same cell costs the
 *     reader nothing; judging hints by it only punished corrections that were right about
 *     the floor a player walks on.
 *   - cross-area stubs and self-loops: not a connection between two rooms of this map.
 */
export function countBentEdges(layout: AreaLayout): number {
  const cells = new Set<string>();
  for (const p of Object.values(layout.placed) as PlacedRoom[]) {
    cells.add(`${p.x},${p.y},${p.z}`);
  }
  // Half steps: a hint may put a room between two rows, and whole-cell walking would step
  // straight over it (and never land on the far end).
  const clearBetween = (src: PlacedRoom, tgt: PlacedRoom): boolean => {
    const dx = Math.sign(tgt.x - src.x);
    const dy = Math.sign(tgt.y - src.y);
    const half = [src.x, src.y, tgt.x, tgt.y].some((v) => v !== Math.trunc(v));
    const step = half ? 0.5 : 1;
    const span = Math.max(Math.abs(tgt.x - src.x), Math.abs(tgt.y - src.y));
    for (let gone = step; gone < span; gone += step) {
      if (cells.has(`${src.x + dx * gone},${src.y + dy * gone},${src.z}`)) return false;
    }
    return true;
  };

  let bent = 0;
  for (const exit of layout.exits) {
    if (exit.style === 'cross_area' || exit.from === exit.to) continue;
    const [dx, dy, dz] = DIR_DELTAS[exit.dir as Direction];
    if (dz !== 0) continue;                                   // a staircase, not a line
    const src = layout.placed[exit.from] as PlacedRoom | undefined;
    const tgt = layout.placed[exit.to] as PlacedRoom | undefined;
    if (!src || !tgt) { bent++; continue; }
    if (src.z !== tgt.z) continue;                            // the layers are drawn apart
    const ddx = tgt.x - src.x, ddy = tgt.y - src.y;
    const straight = dx !== 0
      ? ddy === 0 && ddx !== 0 && Math.sign(ddx) === dx && clearBetween(src, tgt)
      : ddx === 0 && ddy !== 0 && Math.sign(ddy) === dy && clearBetween(src, tgt);
    if (!straight) bent++;
  }
  return bent;
}

export interface HintChoice {
  layout: AreaLayout;
  /** True when the hinted layout won and was kept. */
  used: boolean;
  /** The deciding measure: connections that render crooked. */
  bentNative: number;
  bentHinted: number;
  /** Kept alongside for the report — warps are a subset a reader may recognise. */
  warpsNative: number;
  warpsHinted: number;
}

/**
 * Drop the hinted layout only when it is strictly worse.
 *
 * Measured in BENT edges, not warps: warps miss exactly the defects a hand correction is
 * usually aimed at (see countBentEdges). An equal count keeps the hints — the human drew
 * that shape on purpose, and a tie means nothing was lost. More bends, though, is a
 * measurable regression, and then the plain algorithm wins and the file is reported stale.
 */
export function pickLayout(native: AreaLayout, hinted: AreaLayout | null): HintChoice {
  const bentNative = countBentEdges(native);
  const warpsNative = countWarps(native);
  if (!hinted) {
    return {
      layout: native, used: false,
      bentNative, bentHinted: bentNative, warpsNative, warpsHinted: warpsNative,
    };
  }
  const bentHinted = countBentEdges(hinted);
  const warpsHinted = countWarps(hinted);
  const keep = bentHinted <= bentNative;
  return {
    layout: keep ? hinted : native,
    used: keep,
    bentNative, bentHinted, warpsNative, warpsHinted,
  };
}

export interface HintReportRow {
  area: string;
  bentNative: number;
  bentHinted: number;
  warpsNative: number;
  warpsHinted: number;
  used: boolean;
  warnings: string[];
}

/**
 * One message for the whole run, not one per area: a nightly build that shouts about
 * every zone gets muted, and then nobody sees the one line that mattered.
 *
 * Returns null when everything is in order — nothing to say is the normal outcome.
 */
export function hintSummary(rows: HintReportRow[]): string | null {
  if (rows.length === 0) return null;
  const stale = rows.filter((r) => !r.used);
  const noisy = rows.filter((r) => r.warnings.length > 0);
  if (stale.length === 0 && noisy.length === 0) return null;

  const lines: string[] = [];
  if (stale.length) {
    lines.push(
      `Layout hints are stale (${stale.length} of ${rows.length}) — the plain layout is now better:`,
    );
    for (const row of stale) {
      lines.push(`  ${row.area}: ${row.bentHinted} bent edges with hints vs ${row.bentNative} without`);
    }
  }
  for (const row of noisy) {
    lines.push(`  ${row.area}: ${row.warnings.length} bad hint(s) — ${row.warnings.slice(0, 3).join('; ')}`);
  }
  return lines.join('\n');
}
