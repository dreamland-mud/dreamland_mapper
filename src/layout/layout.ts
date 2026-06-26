/**
 * Layout — trunk-first BFS with straight, variable-length, never-wrong-side placement.
 *
 * Design (see backup/NOTES.md for the full history of what was tried and rejected):
 *  - BFS from the most-connected ("trunk") anchor, depth-first along the arrival direction
 *    so avenues run dead straight.
 *  - A room is only ever placed by extending a STRAIGHT connector along its exit's own
 *    direction to the nearest clear cell (variable length) — never displaced laterally to
 *    the opposite side, so a "south" room can never render above its parent.
 *  - Edges the graph can't embed cardinally (cycle closures, blocked rays) stay warps; the
 *    renderer draws genuinely opposite-side ones as red arcs and self-loops as small sticks.
 *
 * This was the best of every approach explored (cartographer-map extraction, streets-first,
 * SCC edge-sacrifice, etc. all regressed). Keep it simple.
 *
 * Midgaard exception: its southern district (Emerald/Park/Crowded) is re-embedded by a
 * row/column CONSTRAINT layout (`embedSouthBlock`) on its own local grid — see that function.
 * The global constraint layout was tried for the whole area and regressed badly (it trades
 * lying-arcs for room-crossing detours + sprawl); it only wins at sub-block scale.
 */
import type { AreaLayout, AreaMeta, Direction, Exit, ExitStyle, PlacedExit, PlacedRoom, Room } from '../types.js';
import { DIR_DELTAS, REVERSE_DIR } from '../types.js';

const MIN_LEN = 3;     // shortest connector (cells) — a clean visual gap
const MAX_LEN = 40;    // furthest a straight connector extends before giving up cardinal
const CLUSTER_GAP = 12;
const WALL_STEP = 6;   // midgaard skeleton: double-length wall/street segments

interface Ctx {
  meta: AreaMeta;
  byVnum: Map<number, Room>;
  vnumToArea: Record<number, string>;
  placed: Map<number, PlacedRoom>;
  cells: Map<string, number>;
  emitted: Set<string>;
  exits: PlacedExit[];
  arrivalDir: Map<number, Direction>;
}

const cellKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

function isMazeRoom(room: Room): boolean {
  if (room.exits.length < 4) return false;
  return new Set(room.exits.map((e) => e.target)).size === 1;
}

function classifyDoor(flags: string[]): ExitStyle | null {
  if (!flags.includes('isdoor')) return null;
  if (flags.includes('pickproof')) return 'door_pickproof';
  if (flags.includes('locked')) return 'door_locked';
  if (flags.includes('closed')) return 'door_closed';
  return 'open';
}

function exitStyle(exit: Exit): ExitStyle {
  if (exit.flags.includes('random')) return 'random';
  return classifyDoor(exit.flags) ?? 'open';
}

function isReciprocated(ctx: Ctx, from: number, target: number): boolean {
  const t = ctx.byVnum.get(target);
  return t ? t.exits.some((e) => e.target === from) : false;
}

function place(ctx: Ctx, vnum: number, x: number, y: number, z: number, cluster: number, isVoid?: boolean) {
  const p: PlacedRoom = { vnum, x, y, z, cluster };
  if (isVoid) { p.isVoid = true; p.voidReason = 'maze'; }
  ctx.placed.set(vnum, p);
  ctx.cells.set(cellKey(x, y, z), vnum);
}

/** Trunk anchor: most-connected non-maze room, lowest vnum tiebreak. */
function pickAnchor(rooms: Room[]): Room {
  const cand = rooms.filter((r) => !isMazeRoom(r));
  const pool = cand.length ? cand : rooms;
  return pool.reduce((best, r) =>
    r.exits.length > best.exits.length ? r
      : (r.exits.length === best.exits.length && r.vnum < best.vnum ? r : best), pool[0]);
}

/** True if every cell strictly between (sx,sy) and (tx,ty) on a cardinal axis is empty. */
function pathClear(ctx: Ctx, sx: number, sy: number, tx: number, ty: number, z: number): boolean {
  const dx = Math.sign(tx - sx), dy = Math.sign(ty - sy);
  let x = sx + dx, y = sy + dy;
  while (x !== tx || y !== ty) {
    if (ctx.cells.has(cellKey(x, y, z))) return false;
    x += dx; y += dy;
  }
  return true;
}

/** Nearest free cell near (x, y, z) within a small ring — last-resort placement. */
function findFreeNear(ctx: Ctx, x: number, y: number, z: number): { x: number; y: number } | null {
  if (!ctx.cells.has(cellKey(x, y, z))) return { x, y };
  for (let r = 1; r <= 4; r++)
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!ctx.cells.has(cellKey(x + dx, y + dy, z))) return { x: x + dx, y: y + dy };
      }
  return null;
}

/**
 * Place exit.target by extending a straight connector along exit.dir from the source to the
 * nearest clear cell at distance >= MIN_LEN. Only ever steps along the exit's own axis, so
 * the target can only land on the correct side — never opposite.
 */
function tryPlace(ctx: Ctx, srcVnum: number, exit: Exit, cluster: number, minLen = MIN_LEN): boolean {
  const src = ctx.placed.get(srcVnum);
  const tgt = ctx.byVnum.get(exit.target);
  if (!src || !tgt) return false;
  const [dx, dy, dz] = DIR_DELTAS[exit.dir];
  const isVoid = isMazeRoom(tgt);

  if (dz !== 0) {
    const nz = src.z + dz;
    if (!ctx.cells.has(cellKey(src.x, src.y, nz))) { place(ctx, exit.target, src.x, src.y, nz, cluster, isVoid); return true; }
    const f = findFreeNear(ctx, src.x, src.y, nz);
    if (f) { place(ctx, exit.target, f.x, f.y, nz, cluster, isVoid); return true; }
    return false;
  }

  for (let k = 1; k <= MAX_LEN; k++) {
    const cx = src.x + dx * k, cy = src.y + dy * k;
    const occ = ctx.cells.has(cellKey(cx, cy, src.z));
    if (k >= minLen && !occ) { place(ctx, exit.target, cx, cy, src.z, cluster, isVoid); return true; }
    if (occ) return false;  // a room on the ray blocks the straight connector beyond it
  }
  return false;
}

/** Depth-first BFS from the trunk anchor — continues the arrival street first, straight only. */
function bfsCluster(ctx: Ctx, anchor: Room, cluster: number, originX: number): void {
  place(ctx, anchor.vnum, originX, 0, 0, cluster, isMazeRoom(anchor));
  bfsExpand(ctx, [anchor.vnum], cluster);
}

/** BFS expansion from already-placed seed rooms — places unplaced same-area neighbours. */
function bfsExpand(ctx: Ctx, seeds: number[], cluster: number): void {
  const queue: number[] = [...seeds];
  while (queue.length) {
    const v = queue.shift()!;
    const room = ctx.byVnum.get(v);
    const sp = ctx.placed.get(v);
    if (!room || !sp || sp.isVoid) continue;   // never expand out of a maze void

    const ad = ctx.arrivalDir.get(v);
    const exits = ad
      ? [...room.exits.filter((e) => e.dir === ad), ...room.exits.filter((e) => e.dir !== ad)]
      : room.exits;

    for (const exit of exits) {
      const ta = ctx.vnumToArea[exit.target];
      if (ta && ta !== ctx.meta.file) continue;  // cross-area, handled at emit time
      const tr = ctx.byVnum.get(exit.target);
      if (!tr || ctx.placed.has(exit.target)) continue;
      // Midgaard: branches (turns off the arrival street) sit close — they only need the
      // right side, not the full grid pitch. Trunk continuations keep the normal spacing.
      const minLen = (ctx.meta.file === 'midgaard' && exit.dir !== ad) ? 1 : MIN_LEN;
      if (tryPlace(ctx, v, exit, cluster, minLen)) {
        ctx.arrivalDir.set(exit.target, exit.dir);
        if (!isMazeRoom(tr)) {
          if (exit.dir === ad) queue.unshift(exit.target);  // continue the trunk depth-first
          else queue.push(exit.target);                     // branch breadth-first
        }
      }
    }
  }
}

/**
 * Place rooms BFS couldn't reach. Phase 1: clean straight ray-extension from a placed
 * neighbour (reverse exit). Phase 2 (last resort): nearest free cell near a neighbour.
 */
function placeStragglers(ctx: Ctx, cands: Room[], cluster: number): void {
  const sameArea = (t: number) => { const a = ctx.vnumToArea[t]; return !a || a === ctx.meta.file; };

  let progress = true;
  while (progress) {
    progress = false;
    for (const room of cands) {
      if (ctx.placed.has(room.vnum)) continue;
      for (const exit of room.exits) {
        if (!sameArea(exit.target) || !ctx.placed.has(exit.target)) continue;
        const synthetic: Exit = { dir: REVERSE_DIR[exit.dir], target: room.vnum, flags: [] };
        if (tryPlace(ctx, exit.target, synthetic, cluster)) { progress = true; break; }
      }
    }
  }

  progress = true;
  while (progress) {
    progress = false;
    for (const room of cands) {
      if (ctx.placed.has(room.vnum)) continue;
      for (const exit of room.exits) {
        const nb = ctx.placed.get(exit.target);
        if (!sameArea(exit.target) || !nb) continue;
        const [dx, dy, dz] = DIR_DELTAS[exit.dir];
        const f = findFreeNear(ctx, nb.x - dx * MIN_LEN, nb.y - dy * MIN_LEN, nb.z - dz);
        if (f) { place(ctx, room.vnum, f.x, f.y, nb.z - dz, cluster, isMazeRoom(room)); progress = true; break; }
      }
    }
  }
}

/** Cardinal iff same z, perpendicular-aligned, correct direction sign, clear straight path
 *  — at any positive distance (variable-length connectors stay clean). */
function isCardinalEdge(ctx: Ctx, src: PlacedRoom, tgt: PlacedRoom, dir: Direction): boolean {
  const [dx, dy, dz] = DIR_DELTAS[dir];
  const ddx = tgt.x - src.x, ddy = tgt.y - src.y, ddz = tgt.z - src.z;
  if (dz !== 0) return ddx === 0 && ddy === 0 && ddz === dz;
  if (ddz !== 0) return false;
  if (dx !== 0) { if (ddy !== 0 || ddx === 0 || Math.sign(ddx) !== dx) return false; }
  else { if (ddx !== 0 || ddy === 0 || Math.sign(ddy) !== dy) return false; }
  return pathClear(ctx, src.x, src.y, tgt.x, tgt.y, src.z);
}

function emitEdge(ctx: Ctx, from: number, exit: Exit, style: ExitStyle, targetArea?: string) {
  const a = Math.min(from, exit.target), b = Math.max(from, exit.target);
  const axis = (exit.dir === 'north' || exit.dir === 'south') ? 'ns'
    : (exit.dir === 'east' || exit.dir === 'west') ? 'ew'
      : (exit.dir === 'up' || exit.dir === 'down') ? 'ud' : 'd';
  const key = `${a}-${b}-${axis}`;
  if (ctx.emitted.has(key)) return;
  ctx.emitted.add(key);
  const pe: PlacedExit = {
    from, to: exit.target, dir: exit.dir, style, flags: exit.flags,
    hasFly: exit.flags.includes('fly') || exit.flags.includes('flying'),
    hasSwim: exit.flags.includes('swim'),
    hasTrap: exit.flags.some((f) => f.startsWith('trap')),
    bidirectional: isReciprocated(ctx, from, exit.target),
  };
  if (targetArea) pe.targetArea = targetArea;
  if (exit.keyword) pe.doorKeyword = exit.keyword;
  ctx.exits.push(pe);
}

/** Relaxed classification (grid cities): an edge is a clean connector as long as the target
 * sits in the correct half-plane for the direction (correct side), even if not grid-aligned —
 * the renderer routes it as a bent connector. Only opposite-side / cross-z become warps. Inner
 * rooms thus don't need to land on the exact grid, only on the right side of their parent. */
function isCorrectSide(src: PlacedRoom, tgt: PlacedRoom, dir: Direction): boolean {
  const [dx, dy, dz] = DIR_DELTAS[dir];
  const ddx = tgt.x - src.x, ddy = tgt.y - src.y, ddz = tgt.z - src.z;
  if (dz !== 0) return ddx === 0 && ddy === 0 && ddz === dz; // vertical still needs alignment
  if (ddz !== 0) return false;
  if (dx !== 0) return Math.sign(ddx) === dx;
  return Math.sign(ddy) === dy;
}

function emitAllEdges(ctx: Ctx, rooms: Room[]): void {
  const relaxed = ctx.meta.file === 'midgaard' || ctx.meta.file === 'smidgaard';
  for (const room of rooms) {
    const src = ctx.placed.get(room.vnum);
    for (const exit of room.exits) {
      const ta = ctx.vnumToArea[exit.target];
      if (ta != null && ta !== ctx.meta.file) { emitEdge(ctx, room.vnum, exit, 'cross_area', ta); continue; }
      const tr = ctx.byVnum.get(exit.target);
      const tgt = ctx.placed.get(exit.target);
      if (!tr || !src || !tgt) { emitEdge(ctx, room.vnum, exit, 'warp'); continue; }
      const clean = isCardinalEdge(ctx, src, tgt, exit.dir)
        || (relaxed && isCorrectSide(src, tgt, exit.dir));
      emitEdge(ctx, room.vnum, exit, clean ? exitStyle(exit) : 'warp');
    }
  }
}

/**
 * Midgaard skeleton: trace the N/E/W wall loop (walls + corners + gates) and place it as a
 * clean, aligned, double-spaced frame — straight horizontal north wall, straight vertical
 * side walls, corners and gates aligned. Inner rooms then BFS off this frame (correct-side,
 * relaxed). Returns the set of placed wall vnums. No-op if the expected structure is absent.
 */
function placeMidgaardWalls(ctx: Ctx, rooms: Room[]): Set<number> {
  const placed = new Set<number>();
  const isPerim = (r: Room) =>
    /тены|Угол|угол|Ворот|ворот/.test(r.name) && !/Южны/.test(r.name); // exclude south gate
  const perimRooms = rooms.filter(isPerim);
  if (perimRooms.length === 0) return placed;
  const pset = new Set(perimRooms.map((r) => r.vnum));

  const nbr = (vn: number, dir: Direction): number | undefined =>
    ctx.byVnum.get(vn)?.exits.find((e) => e.dir === dir && pset.has(e.target))?.target;
  const isWallRoad = (vn: number | undefined) => vn != null && /тены/.test(ctx.byVnum.get(vn)?.name ?? '');
  const nbrWall = (vn: number, dir: Direction) => isWallRoad(nbr(vn, dir));

  // NW corner: its east neighbour (north wall) and south neighbour (west wall) are both
  // wall-road segments — distinguishes the corner from a gate (which exits to the outside).
  const nw = perimRooms.find((r) => nbrWall(r.vnum, 'east') && nbrWall(r.vnum, 'south'));
  if (!nw) return placed;

  const traceRun = (start: number, dir: Direction): number[] => {
    const run = [start];
    const seen = new Set([start]);
    let cur = start;
    for (;;) {
      const n = nbr(cur, dir);
      if (n == null || seen.has(n)) break;
      run.push(n); seen.add(n); cur = n;
    }
    return run;
  };

  const north = traceRun(nw.vnum, 'east');          // NW → … → NE
  const west = traceRun(nw.vnum, 'south');          // NW → … → SW
  const east = traceRun(north[north.length - 1], 'south'); // NE → … → SE
  if (north.length < 2 || west.length < 2 || east.length < 2) return placed;

  const rightX = (north.length - 1) * WALL_STEP;
  const placeWall = (vn: number, x: number, y: number) => {
    if (placed.has(vn)) return;
    place(ctx, vn, x, y, 0, 0);
    placed.add(vn);
  };
  // Side walls: the top two segments off each corner are half-length, the rest full.
  const sideY = (i: number) => -(Math.min(i, 2) * (WALL_STEP / 2) + Math.max(0, i - 2) * WALL_STEP);
  north.forEach((vn, i) => placeWall(vn, i * WALL_STEP, 0));
  west.forEach((vn, k) => placeWall(vn, 0, sideY(k)));
  east.forEach((vn, j) => placeWall(vn, rightX, sideY(j)));
  return placed;
}

/**
 * Midgaard outer ring: the "Path around Midgaard" (3206-3214) plus the three beyond-gate
 * rooms that bridge it to the wall. Generic BFS pins this loop's north stretch over the N
 * gate (too narrow to reach the corners), so its W/E legs render as diagonals straight across
 * the wall. Place it explicitly as an aligned ring one WALL_STEP outside the frame instead:
 * west leg at x=-WALL_STEP, east leg at x=rightX+WALL_STEP, north stretch at y=+WALL_STEP
 * (north of the wall), with 3210 aligned over the N gate. Runs after placeMidgaardWalls so the
 * inner gate coords are known. No-op if the expected rooms/gates are absent.
 */
function placeMidgaardOuterPath(ctx: Ctx): Set<number> {
  const placed = new Set<number>();
  const OUTER = [3206, 3207, 3208, 3209, 3210, 3211, 3212, 3213, 3214];
  const wg = ctx.placed.get(3040), eg = ctx.placed.get(3041), ng = ctx.placed.get(3262);
  if (!wg || !eg || !ng) return placed;                       // gates not framed -> bail
  if (!OUTER.every((v) => ctx.byVnum.has(v))) return placed;  // not the midgaard we expect

  const bottomY = wg.y, rightX = eg.x, nx = ng.x;
  const topY = WALL_STEP, westX = -WALL_STEP, eastX = rightX + WALL_STEP;
  const put = (vn: number, x: number, y: number) => {
    if (ctx.placed.has(vn) || ctx.cells.has(cellKey(x, y, 0))) return;
    place(ctx, vn, x, y, 0, 0);
    placed.add(vn);
  };
  // beyond-gate rooms bridge the wall to the ring (one cardinal hop to each inner gate)
  put(3052, westX, bottomY);             // beyond W gate, E -> 3040
  put(3053, eastX, bottomY);             // beyond E gate, W -> 3041
  put(3268, nx, Math.round(topY / 2));   // beyond N gate, S -> 3262, N -> 3210
  // west leg (column at westX): 3052 -> 3206 -> 3207 -> 3208(NW bend)
  put(3206, westX, bottomY + 2 * WALL_STEP);
  put(3207, westX, bottomY + 3 * WALL_STEP);
  put(3208, westX, topY);
  // north stretch at topY, 3210 over the N gate
  put(3209, Math.round((westX + nx) / 2), topY);
  put(3210, nx, topY);
  put(3211, Math.round((nx + eastX) / 2), topY);
  put(3212, eastX, topY);                // NE bend
  // east leg (column at eastX): 3212 -> 3213 -> 3214 -> 3053
  put(3213, eastX, 0);
  put(3214, eastX, bottomY + 2 * WALL_STEP);
  return placed;
}

/** Force a vertical street straight: trace the N-S chain through `anchor` and snap every room
 * to the chain's dominant x (keeps y). Outliers like Площадь Астрал join Изумрудный/Набережная. */
function straightenVertical(ctx: Ctx, anchor: number): void {
  if (!ctx.placed.has(anchor)) return;
  const nsNbr = (vn: number, dir: Direction) =>
    ctx.byVnum.get(vn)?.exits.find((e) => e.dir === dir && ctx.placed.has(e.target))?.target;
  const chain = [anchor];
  const seen = new Set([anchor]);
  for (let cur = anchor; ;) { const n = nsNbr(cur, 'north'); if (n == null || seen.has(n)) break; chain.unshift(n); seen.add(n); cur = n; }
  for (let cur = anchor; ;) { const s = nsNbr(cur, 'south'); if (s == null || seen.has(s)) break; chain.push(s); seen.add(s); cur = s; }
  if (chain.length < 3) return;

  const counts = new Map<number, number>();
  for (const vn of chain) { const p = ctx.placed.get(vn); if (p) counts.set(p.x, (counts.get(p.x) ?? 0) + 1); }
  let targetX = ctx.placed.get(anchor)!.x, best = -1;
  for (const [x, c] of counts) if (c > best) { best = c; targetX = x; }

  for (const vn of chain) {
    const p = ctx.placed.get(vn);
    if (!p || p.x === targetX) continue;
    const dest = cellKey(targetX, p.y, p.z);
    if (ctx.cells.has(dest) && ctx.cells.get(dest) !== vn) continue; // don't overwrite another room
    ctx.cells.delete(cellKey(p.x, p.y, p.z));
    p.x = targetX;
    ctx.cells.set(dest, vn);
  }
}

/**
 * Re-embed a grid-consistent block of rooms onto its OWN tight local grid, with zero
 * wrong-side warps and zero collisions.
 *
 * Used for districts the trunk-first BFS can't embed on the main lattice even though they ARE
 * grid-consistent: midgaard's Emerald Avenue / Park / Crowded Street complex (a sub-block that
 * stitches back into the placed city — `standalone=false`), and smidgaard, whose whole surface
 * is one such grid with no surrounding city to attach to (`standalone=true`). Algorithm:
 *   1. union-find columns (N/S edges share x) and rows (E/W edges share y),
 *   2. longest-path rank each class (compact; both blocks' class graphs are cycle-free),
 *   3. conflict-colour per rank to separate only the classes that would actually collide,
 *      giving 0 warps + 0 collisions,
 *   4a. standalone: place the rigid block directly at z=0 (caller hangs any vertical-only
 *       components — e.g. an underground river — off their seams afterwards), OR
 *   4b. sub-block: stitch into the already-placed city at whichever attachment yields the
 *       fewest bent cross-block edges, then shift it clear of existing rooms.
 *
 * No-op (returns false) if the block is too small to be the expected grid.
 */
function embedGridBlock(ctx: Ctx, memberVnums: number[], standalone: boolean): boolean {
  const blockSet = new Set<number>(memberVnums);
  const members = memberVnums.filter((v) => ctx.byVnum.has(v));
  if (members.length < 20) return false;  // sentinel — too small to be the expected grid
  const inBlock = (v: number) => blockSet.has(v) && ctx.byVnum.has(v);

  // Internal cardinal edges (dedup undirected per axis).
  const edges: Array<{ u: number; v: number; dir: Direction }> = [];
  const seenE = new Set<string>();
  for (const v of members) {
    for (const e of ctx.byVnum.get(v)!.exits) {
      if (!inBlock(e.target) || e.dir === 'up' || e.dir === 'down') continue;
      const axis = (e.dir === 'north' || e.dir === 'south') ? 'ns' : 'ew';
      const key = `${Math.min(v, e.target)}-${Math.max(v, e.target)}-${axis}`;
      if (seenE.has(key)) continue;
      seenE.add(key);
      edges.push({ u: v, v: e.target, dir: e.dir });
    }
  }

  // Union-find: N/S edges merge a column (shared x); E/W edges merge a row (shared y).
  const find = (m: Map<number, number>, x: number): number => {
    if (!m.has(x)) m.set(x, x);
    let r = x; while (m.get(r)! !== r) r = m.get(r)!;
    while (m.get(x)! !== r) { const n = m.get(x)!; m.set(x, r); x = n; }
    return r;
  };
  const xp = new Map<number, number>(), yp = new Map<number, number>();
  for (const v of members) { find(xp, v); find(yp, v); }
  const xf = (v: number) => find(xp, v), yf = (v: number) => find(yp, v);
  for (const e of edges) {
    if (e.dir === 'north' || e.dir === 'south') xp.set(xf(e.u), xf(e.v));
    else yp.set(yf(e.u), yf(e.v));
  }

  // Order edges between classes (east: col(u) < col(v); north: row(u) < row(v)).
  const xord: Array<[number, number]> = [], yord: Array<[number, number]> = [];
  for (const e of edges) {
    if (e.dir === 'east') xord.push([xf(e.u), xf(e.v)]);
    else if (e.dir === 'west') xord.push([xf(e.v), xf(e.u)]);
    else if (e.dir === 'north') yord.push([yf(e.u), yf(e.v)]);
    else yord.push([yf(e.v), yf(e.u)]);
  }

  const longestPath = (classes: Set<number>, ord: Array<[number, number]>): Map<number, number> => {
    const g = new Map<number, number[]>(), indeg = new Map<number, number>();
    for (const c of classes) { g.set(c, []); indeg.set(c, 0); }
    const ek = new Set<string>();
    for (const [a, b] of ord) {
      if (a === b) continue;
      const k = `${a}>${b}`; if (ek.has(k)) continue; ek.add(k);
      g.get(a)!.push(b); indeg.set(b, indeg.get(b)! + 1);
    }
    const rank = new Map<number, number>(); for (const c of classes) rank.set(c, 0);
    const id = new Map(indeg);
    const q = [...classes].filter((c) => id.get(c) === 0);
    while (q.length) {
      const u = q.shift()!;
      for (const w of g.get(u)!) {
        rank.set(w, Math.max(rank.get(w)!, rank.get(u)! + 1));
        id.set(w, id.get(w)! - 1);
        if (id.get(w) === 0) q.push(w);
      }
    }
    return rank;
  };
  // Tightening (standalone/smidgaard only): longest-path-from-sources parks an under-constrained
  // appendage class (an interior stub hanging off the grid by one exit) at rank 0, stretching its
  // single edge clear across the map and crossing everything. Pull each loose class to its
  // neighbours' median, clamped to the *current* neighbour-feasible range so every ordering
  // constraint stays satisfied; rigid grid classes (range collapses to one value) never move.
  // Gated off for the midgaard sub-block (standalone=false) so its embed stays byte-identical.
  const tighten = (classes: Set<number>, ord: Array<[number, number]>, asap: Map<number, number>): Map<number, number> => {
    const succ = new Map<number, Set<number>>(), pred = new Map<number, Set<number>>();
    for (const c of classes) { succ.set(c, new Set()); pred.set(c, new Set()); }
    for (const [a, b] of ord) { if (a !== b) { succ.get(a)!.add(b); pred.get(b)!.add(a); } }
    let maxR = 0; for (const c of classes) maxR = Math.max(maxR, asap.get(c)!);
    const rank = new Map(asap);
    for (let pass = 0; pass < 16; pass++) {
      let moved = false;
      for (const v of classes) {
        let lo = 0, hi = maxR;
        const targets: number[] = [];
        for (const p of pred.get(v)!) { const r = rank.get(p)!; lo = Math.max(lo, r + 1); targets.push(r + 1); }
        for (const s of succ.get(v)!) { const r = rank.get(s)!; hi = Math.min(hi, r - 1); targets.push(r - 1); }
        if (!targets.length || lo > hi) continue;   // isolated, or (defensively) infeasible
        targets.sort((a, b) => a - b);
        const want = Math.max(lo, Math.min(hi, targets[(targets.length - 1) >> 1]));
        if (want !== rank.get(v)!) { rank.set(v, want); moved = true; }
      }
      if (!moved) break;
    }
    return rank;
  };
  const xClasses = new Set(members.map(xf)), yClasses = new Set(members.map(yf));
  const Rx0 = longestPath(xClasses, xord), Ry0 = longestPath(yClasses, yord);
  const Rx = standalone ? tighten(xClasses, xord, Rx0) : Rx0;
  const Ry = standalone ? tighten(yClasses, yord, Ry0) : Ry0;

  const lx = new Map<number, number>(), ly = new Map<number, number>();
  for (const v of members) { lx.set(v, Rx.get(xf(v))!); ly.set(v, Ry.get(yf(v))!); }

  // Within one rank, split classes whose members share the perpendicular coordinate (greedy
  // colouring), then renumber (rank, sub) to a dense sequence written back into `prim`.
  const repair = (
    classOf: (v: number) => number, rankOf: Map<number, number>,
    sec: (v: number) => number, prim: Map<number, number>, classes: Set<number>,
  ): void => {
    const byRank = new Map<number, number[]>();
    for (const c of classes) { const r = rankOf.get(c)!; (byRank.get(r) ?? byRank.set(r, []).get(r)!).push(c); }
    const mem = new Map<number, number[]>();
    for (const v of members) { const c = classOf(v); (mem.get(c) ?? mem.set(c, []).get(c)!).push(v); }
    const sub = new Map<number, number>();
    for (const [, cs] of byRank) {
      // Each class spans a [min,max] interval on the perpendicular axis. Two classes may share
      // a rank only if their intervals are DISJOINT — that prevents both collisions (same cell)
      // and obstructions (a room of one class sitting between two edge-adjacent rooms of another
      // on the merged line). Greedy interval-colouring.
      const span = new Map<number, [number, number]>();
      for (const c of cs) {
        let lo = Infinity, hi = -Infinity;
        for (const v of (mem.get(c) ?? [])) { const s = sec(v); if (s < lo) lo = s; if (s > hi) hi = s; }
        span.set(c, [lo, hi]);
      }
      cs.sort((a, b) => a - b);
      const cols: Array<Array<[number, number]>> = [];
      for (const c of cs) {
        const [lo, hi] = span.get(c)!;
        let placed = false;
        for (let k = 0; k < cols.length; k++) {
          if (!cols[k].some(([olo, ohi]) => lo <= ohi && olo <= hi)) {
            cols[k].push([lo, hi]); sub.set(c, k); placed = true; break;
          }
        }
        if (!placed) { cols.push([[lo, hi]]); sub.set(c, cols.length - 1); }
      }
    }
    const keys = [...new Set([...classes].map((c) => `${rankOf.get(c)}.${sub.get(c) ?? 0}`))]
      .sort((a, b) => { const [ra, sa] = a.split('.').map(Number); const [rb, sb] = b.split('.').map(Number); return ra - rb || sa - sb; });
    const idx = new Map(keys.map((k, i) => [k, i] as const));
    for (const v of members) { const c = classOf(v); prim.set(v, idx.get(`${rankOf.get(c)}.${sub.get(c) ?? 0}`)!); }
  };
  repair(yf, Ry, (v) => lx.get(v)!, ly, yClasses); // split rows, dense ly
  repair(xf, Rx, (v) => ly.get(v)!, lx, xClasses); // split columns, dense lx

  // Local coords are now clean (0 warps, 0 collisions).
  const SCALE = 2;    // local cell → grid cells (block keeps its own tight pitch)

  // Standalone whole-area block: nothing else is placed yet, so the clean local grid IS the
  // layout — drop it at the origin at z=0. The caller hangs vertical-only components afterwards.
  if (standalone) {
    for (const u of members) {
      place(ctx, u, SCALE * lx.get(u)!, SCALE * ly.get(u)!, 0, 0, isMazeRoom(ctx.byVnum.get(u)!));
    }
    return true;
  }

  // Sub-block: stitch into the city — pick the attachment to an already-placed non-block room
  // minimising bent cross-block edges.
  const GAP = 3;      // attachment connector length into the city
  interface Att { cityV: number; blockV: number; dir: Direction; } // dir = block → city
  const atts: Att[] = [];
  for (const v of members) {
    for (const e of ctx.byVnum.get(v)!.exits) {
      if (e.dir === 'up' || e.dir === 'down' || inBlock(e.target)) continue;
      const ta = ctx.vnumToArea[e.target];
      if (ta && ta !== ctx.meta.file) continue;  // cross-area stub, not an anchor
      const cp = ctx.placed.get(e.target);
      if (!cp || cp.z !== 0) continue;
      atts.push({ cityV: e.target, blockV: v, dir: e.dir });
    }
  }
  if (atts.length === 0) return false;

  const evalTransform = (Tx: number, Ty: number): { bends: number; coll: number } => {
    const worldOf = (u: number): [number, number] => [SCALE * lx.get(u)! + Tx, SCALE * ly.get(u)! + Ty];
    let bends = 0, coll = 0;
    for (const b of atts) {
      const [bx, by] = worldOf(b.blockV); const C = ctx.placed.get(b.cityV)!;
      const [bdx, bdy] = DIR_DELTAS[b.dir];
      const clean = bdx !== 0
        ? (by === C.y && Math.sign(C.x - bx) === bdx)
        : (bx === C.x && Math.sign(C.y - by) === bdy);
      if (!clean) bends++;
    }
    for (const u of members) {
      const [wx, wy] = worldOf(u);
      const occ = ctx.cells.get(cellKey(wx, wy, 0));
      if (occ != null && !inBlock(occ)) coll++;
    }
    return { bends, coll };
  };

  let best: { Tx: number; Ty: number; score: number } | null = null;
  for (const a of atts) {
    const C = ctx.placed.get(a.cityV)!;
    const [dx, dy] = DIR_DELTAS[a.dir];
    const Tx = (C.x - dx * GAP) - SCALE * lx.get(a.blockV)!;
    const Ty = (C.y - dy * GAP) - SCALE * ly.get(a.blockV)!;
    const { bends, coll } = evalTransform(Tx, Ty);
    const score = coll * 1000 + bends;
    if (!best || score < best.score) best = { Tx, Ty, score };
  }
  if (!best) return false;

  // Remove old block placements, then shift the chosen transform down until clear of the city.
  for (const u of members) { const p = ctx.placed.get(u); if (p) ctx.cells.delete(cellKey(p.x, p.y, p.z)); }
  let { Tx, Ty } = best;
  const worldOf = (u: number): [number, number] => [SCALE * lx.get(u)! + Tx, SCALE * ly.get(u)! + Ty];
  const collidesCity = () => members.some((u) => { const [wx, wy] = worldOf(u); return ctx.cells.has(cellKey(wx, wy, 0)); });
  let guard = 0;
  while (collidesCity() && guard++ < 400) Ty -= SCALE;

  for (const u of members) {
    const [wx, wy] = worldOf(u);
    const p = ctx.placed.get(u);
    if (p) { p.x = wx; p.y = wy; p.z = 0; }
    else ctx.placed.set(u, { vnum: u, x: wx, y: wy, z: 0, cluster: 0 });
    ctx.cells.set(cellKey(wx, wy, 0), u);
  }
  return true;
}

/** Midgaard southern district (Emerald/Park/Crowded) — the original sub-block caller. */
function embedSouthBlock(ctx: Ctx): boolean {
  const SOUTH = new Set<number>();
  for (let v = 3100; v <= 3143; v++) SOUTH.add(v);
  [3047, 3051, 3068, 3069, 3070, 3255, 3256, 3270, 3271, 3272, 3273].forEach((v) => SOUTH.add(v));
  return embedGridBlock(ctx, [...SOUTH], false);
}

/**
 * Whole-area clean-grid embed for a self-contained grid city (smidgaard / Южный Мидгаард).
 * Its surface is grid-consistent (verified: acyclic column/row classes, 0 warps, 0 collisions)
 * but trunk-first BFS forced it onto one lattice and produced 14 off-axis arcs. Unlike the
 * midgaard sub-block there is no surrounding placed city to stitch into — every external exit is
 * cross-area — so the block IS the area: embed its surface directly at z=0, then hang the
 * vertical-only components (the underground river at z=-1) off their up/down seams. No-op
 * (returns false) if the area's largest cardinal component is too small to be the expected grid.
 */
function embedStandaloneArea(ctx: Ctx, rooms: Room[]): boolean {
  // Largest cardinal-connected component = the surface grid; the river is a separate component
  // joined to the surface only by up/down seams.
  const adj = new Map<number, number[]>();
  for (const r of rooms) adj.set(r.vnum, []);
  for (const r of rooms) {
    for (const e of r.exits) {
      if (e.dir === 'up' || e.dir === 'down' || !ctx.byVnum.has(e.target)) continue;
      adj.get(r.vnum)!.push(e.target);
    }
  }
  const seen = new Set<number>();
  let surface: number[] = [];
  for (const r of rooms) {
    if (seen.has(r.vnum)) continue;
    const comp: number[] = []; const q = [r.vnum]; seen.add(r.vnum);
    while (q.length) {
      const v = q.shift()!; comp.push(v);
      for (const w of adj.get(v) ?? []) if (!seen.has(w)) { seen.add(w); q.push(w); }
    }
    if (comp.length > surface.length) surface = comp;
  }
  if (!embedGridBlock(ctx, surface, true)) return false;

  // Hang vertical-only components (the river) directly under/over their up/down seam to a
  // placed room, then BFS the rest of that component out cardinally on its own z-plane.
  let progress = true;
  while (progress) {
    progress = false;
    for (const r of rooms) {
      if (ctx.placed.has(r.vnum)) continue;
      for (const e of r.exits) {
        if (e.dir !== 'up' && e.dir !== 'down') continue;
        const partner = ctx.placed.get(e.target);
        if (!partner) continue;
        const nz = partner.z - DIR_DELTAS[e.dir][2];
        let x = partner.x, y = partner.y;
        if (ctx.cells.has(cellKey(x, y, nz))) {
          const f = findFreeNear(ctx, x, y, nz);
          if (!f) continue;
          x = f.x; y = f.y;
        }
        place(ctx, r.vnum, x, y, nz, 0, isMazeRoom(r));
        ctx.arrivalDir.set(r.vnum, REVERSE_DIR[e.dir]);
        bfsExpand(ctx, [r.vnum], 0);
        progress = true; break;
      }
    }
  }
  placeStragglers(ctx, rooms, 0);
  return true;
}

export function computeLayout(
  meta: AreaMeta,
  rooms: Room[],
  vnumToArea: Record<number, string>,
): AreaLayout {
  const byVnum = new Map<number, Room>();
  for (const r of rooms) byVnum.set(r.vnum, r);
  const ctx: Ctx = {
    meta, byVnum, vnumToArea,
    placed: new Map(), cells: new Map(), emitted: new Set(), exits: [],
    arrivalDir: new Map(),
  };

  const remaining = new Set(rooms.map((r) => r.vnum));
  let cluster = 0;
  let cursorX = 0;

  // Midgaard: lay the aligned wall frame first, then grow the city inward off it (cluster 0).
  if (meta.file === 'midgaard') {
    const wall = placeMidgaardWalls(ctx, rooms);
    if (wall.size > 0) {
      const outer = placeMidgaardOuterPath(ctx);
      bfsExpand(ctx, [...wall, ...outer], 0);
      placeStragglers(ctx, rooms, 0);
      for (const r of rooms) if (ctx.placed.has(r.vnum)) remaining.delete(r.vnum);
      let maxX = 0;
      for (const p of ctx.placed.values()) if (p.x > maxX) maxX = p.x;
      cursorX = maxX + CLUSTER_GAP;
      cluster = 1;
    }
  }

  // Smidgaard (Южный Мидгаард): a self-contained grid city — embed it whole on a clean local
  // grid before the generic BFS, which otherwise produces 14 grid-irreducible off-axis arcs.
  if (meta.file === 'smidgaard' && embedStandaloneArea(ctx, rooms)) {
    for (const r of rooms) if (ctx.placed.has(r.vnum)) remaining.delete(r.vnum);
  }

  while (remaining.size > 0) {
    const cands = rooms.filter((r) => remaining.has(r.vnum));
    const anchor = pickAnchor(cands);
    bfsCluster(ctx, anchor, cluster, cursorX);
    placeStragglers(ctx, cands, cluster);

    let maxX = cursorX;
    let placedAny = false;
    for (const r of cands) {
      const p = ctx.placed.get(r.vnum);
      if (p) { if (p.x > maxX) maxX = p.x; remaining.delete(r.vnum); placedAny = true; }
    }
    if (!placedAny) break;  // safety
    cursorX = maxX + CLUSTER_GAP;
    cluster++;
  }

  // Orphans (no clear cardinal seat / fully stranded): drop at the cursor.
  for (const r of rooms) {
    if (ctx.placed.has(r.vnum)) continue;
    const f = findFreeNear(ctx, cursorX, 0, 0) ?? { x: cursorX, y: 0 };
    place(ctx, r.vnum, f.x, f.y, 0, cluster, isMazeRoom(r));
    cursorX += 2;
  }

  if (meta.file === 'midgaard') {
    straightenVertical(ctx, 3001); // Leo Temple axis (already straight; idempotent)
    // Southern district (Emerald/Park/Crowded) gets a clean local-grid re-embed instead of
    // straightenVertical(3103) + placeMidgaardSouth, which produced the wrong-side warps.
    embedSouthBlock(ctx);
  }

  emitAllEdges(ctx, rooms);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const zSet = new Set<number>();
  for (const p of ctx.placed.values()) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    zSet.add(p.z);
  }
  if (!Number.isFinite(minX)) { minX = maxX = minY = maxY = 0; }

  const roomsRecord: Record<number, Room> = {};
  for (const r of rooms) roomsRecord[r.vnum] = r;
  const placedRecord: Record<number, PlacedRoom> = {};
  for (const [v, p] of ctx.placed) placedRecord[v] = p;

  return {
    meta,
    rooms: roomsRecord,
    placed: placedRecord,
    exits: ctx.exits,
    zLayers: [...zSet].sort((a, b) => a - b),
    bounds: { minX, maxX, minY, maxY },
    clusters: cluster,
  };
}
