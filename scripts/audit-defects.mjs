#!/usr/bin/env node
/**
 * Audit the built mapper graph (public/data/*.json) for map-rendering defects.
 *
 * One call replaces a stack of ad-hoc analysis: it classifies every warp by how it
 * actually RENDERS (purple/red arc vs self-loop stick vs vertical line), ranks zones,
 * and scans for the area-data defects worth fixing (reverse-direction mismatches,
 * broken exits, one-way exits).
 *
 * Build the data first (`npm run build:graph`), then:
 *   node scripts/audit-defects.mjs              global: arc ranking + root-cause totals + defect tally
 *   node scripts/audit-defects.mjs <area>       per-area arc detail (kind, from→to dir, room names, z-layers)
 *   node scripts/audit-defects.mjs --mismatch   ALL reverse-dir mismatch pairs + reverse-slot status (fix list)
 *   node scripts/audit-defects.mjs --broken     exits whose target room exists in no mapped area
 *   node scripts/audit-defects.mjs --oneway [area]   one-way exits (A→B with no B→A)
 *   node scripts/audit-defects.mjs --valve [area]    topologically-suspect one-way exits
 *                                                    (A dir→B, no return, B anchored elsewhere)
 *
 * What renders as a curved ARC (the thing players see as a stray purple/red line):
 *   style==='warp' AND from!==to (self-loops are sticks) AND dir is N/S/E/W
 *   (up/down warps are intercepted as vertical lines/stubs, not arcs) AND the link is
 *   bidirectional AND not blocked. Two render forms are NOT arcs (counted separately):
 *     oneway  — neutral GREY directional connector + chevron (no return exit)
 *     blocked — neutral GREY Manhattan detour lane (collinear/correct-side, just obstructed)
 *   wrongSide() mirrors the renderer: opposite-half-plane → red, else purple.
 *
 * Override the data dir with $DATA_DIR (default: ../public/data next to this script).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '..', 'public', 'data');

const REVERSE = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' };
const DELTA = { north: [0, 1, 0], south: [0, -1, 0], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 0, 1], down: [0, 0, -1] };

/** Exact mirror of the renderer's warpWrongSide(): same-z, opposite half-plane → red arc. */
function wrongSide(dir, f, t) {
  if (f.z !== t.z) return false;
  const [ddx, ddy] = DELTA[dir];
  if (ddx !== 0) { const s = Math.sign(t.x - f.x); return s !== 0 && s !== Math.sign(ddx); }
  if (ddy !== 0) { const s = Math.sign(t.y - f.y); return s !== 0 && s !== Math.sign(ddy); }
  return false;
}

function loadAreas() {
  if (!fs.existsSync(DATA)) {
    console.error(`DATA_DIR not found: ${DATA}\nRun \`npm run build:graph\` first.`);
    process.exit(1);
  }
  const files = fs.readdirSync(DATA).filter((f) => f.startsWith('area-') && f.endsWith('.json'));
  const layouts = {};
  const globalRoom = {}; // vnum → area file (every mapped room)
  for (const f of files) {
    const L = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
    layouts[L.meta.file] = L;
    for (const v of Object.keys(L.rooms)) globalRoom[v] = L.meta.file;
  }
  let index = null;
  const ip = path.join(DATA, 'index.json');
  if (fs.existsSync(ip)) index = JSON.parse(fs.readFileSync(ip, 'utf8'));
  return { layouts, globalRoom, index };
}

/** Classify every warp in a layout by render form + root cause. */
function classify(L) {
  const { rooms, placed } = L;
  const out = { arcP: 0, arcR: 0, oneway: 0, blocked: 0, stick: 0, vline: 0, detail: [] };
  for (const e of L.exits) {
    if (e.style !== 'warp') continue;
    if (e.from === e.to) { out.stick++; continue; }
    if (e.dir === 'up' || e.dir === 'down') { out.vline++; continue; }
    const sP = placed[e.from], tP = placed[e.to], tR = rooms[e.to], sR = rooms[e.from];
    if (!sP || !tP || !tR) { out.arcR++; continue; }
    const back = tR.exits.find((x) => x.target === e.from);
    const [dx, dy] = DELTA[e.dir];
    let kind, note = '';
    // The renderer (Map.tsx warp branch) only draws a purple/red ARC for bidirectional warps
    // that are neither one-way nor blocked. Mirror that here so the arc counts match the screen:
    //   one-way  → neutral grey directional connector + chevron (not an arc)
    //   blocked  → grey Manhattan detour lane (collinear/correct-side, just obstructed) (not an arc)
    if (!back) {
      out.oneway++;
      kind = 'oneway';
    } else {
      const red = wrongSide(e.dir, sP, tP);
      if (red) { out.arcR++; kind = 'fold'; }
      else if (back.dir !== REVERSE[e.dir]) { out.arcP++; kind = 'mismatch'; note = `B:${back.dir}→A`; }
      else if (dx !== 0 ? tP.y === sP.y : tP.x === sP.x) { out.blocked++; kind = 'blocked'; }
      else { out.arcP++; kind = 'perp'; }
    }
    out.detail.push({
      from: e.from, to: e.to, dir: e.dir, kind, note,
      fromName: (sR?.name || '').replace(/\s+/g, ' ').slice(0, 24),
      toName: (tR?.name || '').replace(/\s+/g, ' ').slice(0, 24),
    });
  }
  return out;
}

function globalReport(layouts) {
  const rows = [];
  for (const af of Object.keys(layouts)) {
    const L = layouts[af];
    const c = classify(L);
    rows.push({ file: af, nRooms: Object.keys(L.rooms).length, arcs: c.arcP + c.arcR, ...c });
  }
  rows.sort((a, b) => b.arcs - a.arcs);
  console.log('TRUE ARC RANKING (curved purple/red lines that should be straight)\n');
  console.log('rk  area            rooms  ARCS  purp  red | stick vline');
  console.log('-'.repeat(60));
  rows.slice(0, 20).forEach((r, i) => console.log(
    String(i + 1).padStart(2) + '  ' + r.file.padEnd(15) + ' ' + String(r.nRooms).padStart(4) + ' ' +
    String(r.arcs).padStart(5) + ' ' + String(r.arcP).padStart(5) + ' ' + String(r.arcR).padStart(4) + ' | ' +
    String(r.stick).padStart(5) + ' ' + String(r.vline).padStart(5)));
  const rc = { fold: 0, mismatch: 0, oneway: 0, blocked: 0, perp: 0 };
  let arcs = 0, oneway = 0, blocked = 0, sticks = 0, vlines = 0;
  for (const r of rows) {
    arcs += r.arcs; oneway += r.oneway; blocked += r.blocked; sticks += r.stick; vlines += r.vline;
    for (const d of r.detail) rc[d.kind]++;
  }
  console.log(`\nGLOBAL  arcs:${arcs}  oneway:${oneway}  blocked:${blocked}  sticks:${sticks}  vlines:${vlines}`);
  console.log('arc root-cause:', JSON.stringify(rc));
  console.log('  perp/fold = mostly intentional (3D / non-Euclidean / same-z mazes);');
  console.log('  oneway = grey directional connectors (not arcs) — most intentional (chutes/falls);');
  console.log('  blocked = grey detour lanes (not arcs) — collinear corridors with a tile on the line;');
  console.log('  mismatch/broken = the area-data fix candidates (see --mismatch, --broken).');
}

function areaReport(layouts, area) {
  const L = layouts[area];
  if (!L) { console.error(`no area "${area}". Available: see public/data/area-*.json`); process.exit(1); }
  const c = classify(L);
  const zc = {};
  for (const v of Object.keys(L.placed)) { const z = L.placed[v].z; zc[z] = (zc[z] || 0) + 1; }
  console.log(`${area} (${L.meta.name}) — ${Object.keys(L.rooms).length} rooms`);
  console.log(`arcs: ${c.arcP + c.arcR} (purple ${c.arcP}, red ${c.arcR})   oneway ${c.oneway}   blocked ${c.blocked}   sticks ${c.stick}   vlines ${c.vline}`);
  console.log('z-layers:', Object.keys(zc).sort((a, b) => a - b).map((z) => `${z}:${zc[z]}`).join(' '));
  const byKind = {};
  for (const d of c.detail) (byKind[d.kind] = byKind[d.kind] || []).push(d);
  for (const k of Object.keys(byKind)) {
    console.log(`\n  -- ${k} (${byKind[k].length}) --`);
    for (const d of byKind[k]) console.log(
      `     ${d.from} ${d.dir.padEnd(5)}→ ${d.to}  [${d.fromName} → ${d.toName}]${d.note ? '  {' + d.note + '}' : ''}`);
  }
}

function mismatchReport(layouts) {
  console.log('REVERSE-DIRECTION MISMATCH pairs (A dir→B but B back→A is not the opposite)\n');
  console.log('Fix = repoint the WRONG side to the true reverse, IF the room descriptions agree');
  console.log('(self-loops, named mazes, cones/spirals are usually intentional — judge each).\n');
  let n = 0;
  for (const af of Object.keys(layouts)) {
    const L = layouts[af];
    for (const v of Object.keys(L.rooms)) {
      const R = L.rooms[v];
      for (const e of R.exits) {
        const B = L.rooms[e.target];
        if (!B || +v >= +e.target) continue; // same-area, dedup pair once
        const back = B.exits.find((x) => x.target === +v);
        if (!back || back.dir === REVERSE[e.dir]) continue;
        const revFree = !B.exits.some((x) => x.dir === REVERSE[e.dir]);
        n++;
        console.log(`  ${af.padEnd(13)} ${v} ${e.dir}→${e.target} / ${e.target} ${back.dir}→${v}` +
          `   [rev ${REVERSE[e.dir]} ${revFree ? 'FREE' : 'used'}]  ${R.name.slice(0, 18)} | ${B.name.slice(0, 18)}`);
      }
    }
  }
  console.log(`\ntotal: ${n} mismatch pairs`);
}

function brokenReport(layouts, globalRoom, index) {
  const inIndex = index ? index.vnumToArea : {};
  console.log('BROKEN exits (target room exists in no mapped area and not in the index)\n');
  let n = 0;
  for (const af of Object.keys(layouts)) {
    const L = layouts[af];
    for (const v of Object.keys(L.rooms)) {
      for (const e of L.rooms[v].exits) {
        if (globalRoom[e.target] == null && inIndex[e.target] == null) {
          n++;
          console.log(`  ${af} ${v} ${e.dir}→${e.target}  [${(L.rooms[v].name || '').slice(0, 28)}]`);
        }
      }
    }
  }
  console.log(`\ntotal: ${n} broken exits` + (n === 0 ? ' ✓' : ''));
}

function onewayReport(layouts, area) {
  console.log('ONE-WAY same-area exits (A→B with no exit back B→A) — many intentional (chutes/falls)\n');
  let n = 0;
  for (const af of Object.keys(layouts)) {
    if (area && af !== area) continue;
    const L = layouts[af];
    for (const v of Object.keys(L.rooms)) {
      for (const e of L.rooms[v].exits) {
        const B = L.rooms[e.target];
        if (!B) continue; // cross-area / broken handled elsewhere
        if (!B.exits.some((x) => x.target === +v)) {
          n++;
          if (n <= 60 || area) console.log(`  ${af.padEnd(13)} ${v} ${e.dir}→${e.target}  [${(L.rooms[v].name || '').slice(0, 22)}]`);
        }
      }
    }
  }
  console.log(`\ntotal: ${n} one-way exits` + (!area && n > 60 ? ' (showing first 60; pass an area to filter)' : ''));
}

/**
 * Topologically-suspect one-way exits: A dir→B (horizontal, no return) where B is ALSO
 * anchored by its own two-way links — so the one-way exit asserts an adjacency that
 * contradicts where B actually sits (the "rotating room" artifact, e.g. sewer 7037→7050).
 *
 * NOT auto-fixable. Many are intentional one-way ledges / slides / drops — read the room
 * DESCRIPTIONS before adding a return exit or deleting. Exempt by construction: up/down
 * pipes, and dead-drops (target reachable only one-way → falls/chutes, no two-way anchor).
 */
function valveReport(layouts, area) {
  console.log('TOPOLOGICALLY-SUSPECT one-way exits (A dir→B, no return, B anchored elsewhere)\n');
  console.log('Verify room descriptions before editing: add a return exit, delete the one-way,');
  console.log('or leave it (intentional ledge/slide/drop). Exempt: up/down + dead-drop falls.\n');
  let n = 0;
  for (const af of Object.keys(layouts)) {
    if (area && af !== area) continue;
    const L = layouts[af];
    const R = L.rooms, P = L.placed;
    const back = (a, b) => R[b] && R[b].exits.some((x) => x.target === +a);
    const rows = [];
    for (const v of Object.keys(R)) {
      for (const e of R[v].exits) {
        if (e.dir === 'up' || e.dir === 'down') continue; // vertical pipes exempt
        const b = e.target;
        if (!R[b]) continue;                              // cross-area / broken
        if (back(v, b)) continue;                         // two-way → fine
        const anchored = R[b].exits.filter((x) => back(b, x.target)).length;
        if (anchored === 0) continue;                     // dead-drop fall/chute → exempt
        const pa = P[v], pb = P[b];
        let rel = '?';
        if (pa && pb && pa.z === pb.z) {
          const [dx, dy] = DELTA[e.dir];
          const sx = Math.sign(pb.x - pa.x), sy = Math.sign(pb.y - pa.y);
          rel = (dx !== 0 ? sx === dx : sy === dy) ? 'correct-side'
            : (dx !== 0 ? sx === -dx : sy === -dy) ? 'OPPOSITE' : 'perp';
        } else if (pa && pb) rel = 'cross-z';
        rows.push({ v: +v, dir: e.dir, b, anchored, rel, name: (R[b].name || '').slice(0, 22) });
      }
    }
    if (rows.length === 0) continue;
    console.log(`${af} (${rows.length}):`);
    for (const r of rows) console.log(
      `  ${r.v} ${r.dir.padEnd(5)}→ ${r.b}  [anchor:${r.anchored}tw ${r.rel}]  ${r.name}`);
    n += rows.length;
  }
  console.log(`\ntotal: ${n} suspect one-way exits` + (area ? '' : ' (pass an area to filter)'));
}

function main() {
  const { layouts, globalRoom, index } = loadAreas();
  const arg = process.argv[2];
  if (arg === '--mismatch') return mismatchReport(layouts);
  if (arg === '--broken') return brokenReport(layouts, globalRoom, index);
  if (arg === '--oneway') return onewayReport(layouts, process.argv[3]);
  if (arg === '--valve') return valveReport(layouts, process.argv[3]);
  if (arg && !arg.startsWith('--')) return areaReport(layouts, arg);
  return globalReport(layouts);
}

main();
