/**
 * Standalone diagnostic renderer: read a layout JSON, emit an SVG that reproduces the
 * app's geometry (placedToScreen + manhattanPath + cardinalArc) but colour-codes every
 * edge by how it ACTUALLY renders, so we can see bent connectors vs clean straights vs warps.
 *
 *   node scripts/render-svg.mjs public/data/area-midgaard.json /tmp/mid.svg [zFilter]
 *
 * Colours:
 *   grey   = clean straight cardinal (aligned, clear)
 *   orange = "open" but NOT grid-aligned → renders as a bent Manhattan path (visual warp)
 *   magenta= warp style (dashed arc)
 *   red    = wrong-side warp
 *   cyan   = cross-area stub
 *   yellow = up/down
 */
import fs from 'node:fs';

const TILE_W = 124, TILE_H = 72, GAP_X = 74, GAP_Y = 70;
const STEP_X = TILE_W + GAP_X, STEP_Y = TILE_H + GAP_Y;
const EDGE_GAP = 7;
const Z_SHIFT_X = STEP_X * 0.65, Z_SHIFT_Y = STEP_Y * 0.65;
const DIR_DELTAS = { north:[0,1,0], south:[0,-1,0], east:[1,0,0], west:[-1,0,0], up:[0,0,1], down:[0,0,-1] };
const REVERSE_DIR = { north:'south', south:'north', east:'west', west:'east', up:'down', down:'up' };
// sector → label text colour (mirror of src/sectors.ts), for colouring vertical exits by target.
const SECTOR_TEXT = { inside:'#d9b94a', city:'#ffffff', field:'#8ee34f', forest:'#6cba2e', hills:'#c4a000', mountain:'#a7aaa3', water_swim:'#55a3f2', water_noswim:'#4a86d8', underwater:'#5a90d0', air:'#7fc0ff', desert:'#fdea56', cave:'#a7aaa3', jungle:'#45c9b0', tundra:'#e6e9e1', unknown:'#a7aaa3' };
const sectorText = (vnum) => { const r = L.rooms[vnum]; if (!r) return '#888888'; const s = r.flags?.includes('indoors') ? 'inside' : r.sector; return SECTOR_TEXT[s] || SECTOR_TEXT.unknown; };

const file = process.argv[2];
const out = process.argv[3] || '/tmp/map.svg';
const zFilter = process.argv[4] != null ? Number(process.argv[4]) : null;
const L = JSON.parse(fs.readFileSync(file, 'utf-8'));
const B = L.bounds;

function placedToScreen(p) {
  return {
    sx: (p.x - B.minX) * STEP_X + p.z * Z_SHIFT_X,
    sy: (B.maxY - p.y) * STEP_Y - p.z * Z_SHIFT_Y,
  };
}
function cardinalPort(cx, cy, hw, hh, dir) {
  switch (dir) {
    case 'north': return [cx, cy - hh];
    case 'south': return [cx, cy + hh];
    case 'east':  return [cx + hw, cy];
    case 'west':  return [cx - hw, cy];
    default:      return [cx, cy];
  }
}
function targetFacingPortDir(scx, scy, dcx, dcy) {
  const dx = scx - dcx, dy = scy - dcy;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'east' : 'west';
  return dy > 0 ? 'south' : 'north';
}
function manhattanPath(scx, scy, shw, shh, dcx, dcy, dhw, dhh, exitDir, detour) {
  const LEAVE = 28, DETOUR = 78;
  const [sx, sy] = cardinalPort(scx, scy, shw, shh, exitDir);
  const targetDir = targetFacingPortDir(scx, scy, dcx, dcy);
  const [tx, ty] = cardinalPort(dcx, dcy, dhw, dhh, targetDir);
  const dirX = exitDir === 'east' ? 1 : exitDir === 'west' ? -1 : 0;
  const dirY = exitDir === 'south' ? 1 : exitDir === 'north' ? -1 : 0;
  const p2x = sx + dirX * LEAVE, p2y = sy + dirY * LEAVE;
  const tDirX = targetDir === 'east' ? 1 : targetDir === 'west' ? -1 : 0;
  const tDirY = targetDir === 'south' ? 1 : targetDir === 'north' ? -1 : 0;
  const p3x = tx + tDirX * LEAVE, p3y = ty + tDirY * LEAVE;
  if (detour) {
    const laneDx = dirX !== 0 ? 0 : 1, laneDy = dirX !== 0 ? -1 : 0;
    const lx1 = p2x + laneDx * DETOUR, ly1 = p2y + laneDy * DETOUR;
    const lx2 = p3x + laneDx * DETOUR, ly2 = p3y + laneDy * DETOUR;
    return `M${sx},${sy} L${p2x},${p2y} L${lx1},${ly1} L${lx2},${ly2} L${p3x},${p3y} L${tx},${ty}`;
  }
  let cornerX, cornerY;
  if (dirY !== 0) { cornerX = p3x; cornerY = p2y; } else { cornerX = p2x; cornerY = p3y; }
  return `M${sx},${sy} L${p2x},${p2y} L${cornerX},${cornerY} L${p3x},${p3y} L${tx},${ty}`;
}
function cardinalArc(cx1, cy1, hw1, hh1, cx2, cy2, hw2, hh2, dir) {
  const [sxp, syp] = cardinalPort(cx1, cy1, hw1, hh1, dir);
  const [txp, typ] = cardinalPort(cx2, cy2, hw2, hh2, REVERSE_DIR[dir]);
  const ddx = txp - sxp, ddy = typ - syp;
  const len = Math.hypot(ddx, ddy) || 1;
  const bow = Math.min(64, len * 0.3);
  const ctrlX = (sxp + txp) / 2 + (-ddy / len) * bow;
  const ctrlY = (syp + typ) / 2 + (ddx / len) * bow;
  return `M${sxp},${syp} Q${ctrlX},${ctrlY} ${txp},${typ}`;
}

// obstructed detection (aligned edge with a tile between endpoints)
const placedArr = Object.values(L.placed);
function isObstructed(e) {
  const f = L.placed[e.from], t = L.placed[e.to];
  if (!f || !t || f.z !== t.z) return false;
  if (f.y === t.y) {
    const lo = Math.min(f.x, t.x), hi = Math.max(f.x, t.x);
    return placedArr.some((p) => p.vnum !== e.from && p.vnum !== e.to && p.z === f.z && p.y === f.y && p.x > lo && p.x < hi);
  } else if (f.x === t.x) {
    const lo = Math.min(f.y, t.y), hi = Math.max(f.y, t.y);
    return placedArr.some((p) => p.vnum !== e.from && p.vnum !== e.to && p.z === f.z && p.x === f.x && p.y > lo && p.y < hi);
  }
  return false;
}
function isAligned(e) {
  const a = L.placed[e.from], b = L.placed[e.to];
  if (!a || !b || a.z !== b.z) return false;
  const ah = e.dir === 'east' || e.dir === 'west';
  return ah ? a.y === b.y : a.x === b.x;
}

const inLayer = (p) => zFilter == null || p.z === zFilter;

// bounds in screen space
let minSX = Infinity, minSY = Infinity, maxSX = -Infinity, maxSY = -Infinity;
for (const p of placedArr) {
  if (!inLayer(p)) continue;
  const { sx, sy } = placedToScreen(p);
  minSX = Math.min(minSX, sx); minSY = Math.min(minSY, sy);
  maxSX = Math.max(maxSX, sx + TILE_W); maxSY = Math.max(maxSY, sy + TILE_H);
}
const PAD = 80;
const W = maxSX - minSX + PAD * 2, H = maxSY - minSY + PAD * 2;
const ox = PAD - minSX, oy = PAD - minSY;

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(W)}" height="${Math.round(H)}" viewBox="0 0 ${Math.round(W)} ${Math.round(H)}">`;
svg += `<rect width="100%" height="100%" fill="#121212"/>`;
svg += `<g transform="translate(${ox},${oy})">`;

let counts = { straight: 0, bent: 0, warp: 0, wrongside: 0, oneway: 0, cross: 0, vert: 0 };

// edges
for (const e of L.exits) {
  const fromP = L.placed[e.from], toP = L.placed[e.to];
  if (!fromP) continue;
  if (zFilter != null && !inLayer(fromP)) continue;
  if (e.style === 'cross_area') {
    counts.cross++;
    const { sx, sy } = placedToScreen(fromP);
    const dx = e.dir==='east'?1:e.dir==='west'?-1:0, dy = e.dir==='north'?-1:e.dir==='south'?1:0;
    const cx = sx+TILE_W/2, cy = sy+TILE_H/2;
    svg += `<line x1="${cx}" y1="${cy}" x2="${cx+dx*60}" y2="${cy+dy*60}" stroke="#06989a" stroke-width="2" stroke-dasharray="10 5"/>`;
    continue;
  }
  if (!toP) continue;
  if (zFilter != null && !inLayer(toP)) continue;
  const fromS = placedToScreen(fromP), toS = placedToScreen(toP);
  const cx1 = fromS.sx+TILE_W/2, cy1 = fromS.sy+TILE_H/2;
  const cx2 = toS.sx+TILE_W/2, cy2 = toS.sy+TILE_H/2;
  if (e.dir === 'up' || e.dir === 'down') {
    counts.vert++;
    svg += `<line x1="${cx1}" y1="${cy1}" x2="${cx2}" y2="${cy2}" stroke="${sectorText(e.to)}" stroke-width="1.8" stroke-dasharray="6 4" opacity="0.85"/>`;
    continue;
  }
  if (e.style === 'warp') {
    const d = cardinalArc(cx1, cy1, TILE_W/2+EDGE_GAP, TILE_H/2+EDGE_GAP, cx2, cy2, TILE_W/2+EDGE_GAP, TILE_H/2+EDGE_GAP, e.dir);
    // One-way warps render as a neutral grey directional connector in the live map, not a
    // purple/red arc (see mudjs Map.tsx warp branch) — mirror that here.
    if (e.bidirectional === false) {
      counts.oneway++;
      svg += `<path d="${d}" fill="none" stroke="#888888" stroke-width="2.0" stroke-dasharray="4 5" opacity="0.8"/>`;
      continue;
    }
    const wrong = (() => {
      if (fromP.z !== toP.z) return false;
      const [ddx, ddy] = DIR_DELTAS[e.dir];
      if (ddx !== 0) { const s = Math.sign(toP.x-fromP.x); return s!==0 && s!==Math.sign(ddx); }
      if (ddy !== 0) { const s = Math.sign(toP.y-fromP.y); return s!==0 && s!==Math.sign(ddy); }
      return false;
    })();
    if (wrong) counts.wrongside++; else counts.warp++;
    svg += `<path d="${d}" fill="none" stroke="${wrong?'#ff3030':'#d384cb'}" stroke-width="2.4" stroke-dasharray="4 5"/>`;
    continue;
  }
  // open / door
  const aligned = isAligned(e);
  const detour = isObstructed(e);
  const d = manhattanPath(cx1, cy1, TILE_W/2+EDGE_GAP, TILE_H/2+EDGE_GAP, cx2, cy2, TILE_W/2+EDGE_GAP, TILE_H/2+EDGE_GAP, e.dir, detour);
  const bent = !aligned || detour;
  if (bent) counts.bent++; else counts.straight++;
  const col = bent ? '#ff9a2e' : '#888888';
  const wdt = bent ? 2.6 : 2.0;
  svg += `<path d="${d}" fill="none" stroke="${col}" stroke-width="${wdt}"/>`;
}

// tiles
for (const p of placedArr) {
  if (!inLayer(p)) continue;
  const { sx, sy } = placedToScreen(p);
  const room = L.rooms[p.vnum];
  const name = (room?.name || '').slice(0, 16);
  const fill = p.isVoid ? '#3a1010' : '#1e1e24';
  const stroke = p.isVoid ? '#cc0000' : '#3a6ea5';
  svg += `<rect x="${sx}" y="${sy}" width="${TILE_W}" height="${TILE_H}" rx="7" fill="${fill}" stroke="${stroke}" stroke-width="1.4"/>`;
  svg += `<text x="${sx+TILE_W/2}" y="${sy+18}" font-size="15" font-family="monospace" fill="#7fd3ff" text-anchor="middle">${p.vnum}</text>`;
  svg += `<text x="${sx+TILE_W/2}" y="${sy+40}" font-size="12" font-family="monospace" fill="#cccccc" text-anchor="middle">${escapeXml(name)}</text>`;
  if (p.z !== 0) svg += `<text x="${sx+TILE_W/2}" y="${sy+58}" font-size="11" font-family="monospace" fill="#fdea56" text-anchor="middle">z=${p.z}</text>`;
}

svg += `</g></svg>`;
fs.writeFileSync(out, svg);
function escapeXml(s){return s.replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));}
console.error(JSON.stringify({ out, zFilter, edgeRender: counts, bentPlusWarp: counts.bent+counts.warp+counts.wrongside }));
