# Dreamland Mapper (PoC)

Dynamic automapper for Dreamland MUD. Reads area XML files, computes layouts, and renders interactive room graphs in the browser.

## Usage

```bash
pnpm install        # or npm install
pnpm build:graph    # parse area XMLs → public/data/*.json
pnpm dev            # start vite dev server on :5173
```

`build:graph` reads from `../dreamland_areas/`. Override via `AREAS_DIR` env var.

## Layout strategy

Single algorithm in `src/layout/layout.ts` (`computeLayout`) — trunk-first BFS:

- BFS from the most-connected ("trunk") anchor, depth-first along the arrival direction so
  avenues run dead straight.
- A room is only placed by extending a **straight, variable-length** connector along its
  exit's own direction to the nearest clear cell — never displaced to the opposite side, so
  a "south" room can't render above its parent.
- Edges the graph can't embed cardinally (cycle closures, blocked rays) become **warps**;
  the renderer draws genuinely opposite-side ones as red arcs and self-loops as small sticks.
- Disconnected components → side-by-side clusters. Maze rooms (all exits → same target) →
  "✦ a terrible void ✦" tile. Cross-area exits → stub with target-area badge.

The full history of approaches tried and rejected (cartographer-map extraction, streets-first,
SCC edge-sacrifice, etc.) is in `backup/NOTES.md`.

## Layout hints

Some areas defeat any layout algorithm: the exit graph isn't planar, or the shape a player
knows isn't the shape the exits describe. `hints/<area>.json` says where such rooms really
belong; the layout runs as usual and the hints are applied **on top of the result**,
correcting those rooms and leaving everything the algorithm got right alone.

```json
{
  "area": "haon",
  "source": "hand-corrected in the mudjs client",
  "updated": "2026-09-04",
  "rooms": { "6013": { "x": 0, "y": -9, "z": 0 } }
}
```

Only `rooms` matters; the rest is documentation. Coordinates are the same grid `placed`
uses in the output and **may be fractional**: a half puts a room between two rows, which is
how stairs and diagonals get separated. Hints for rooms that no longer exist in the area,
and two hints on one cell, are dropped with a warning — a stale hint file must never break
a build.

**Hints are advice, not law.** An area that has them is laid out **twice**, with and
without, and the hinted run is kept only while it doesn't have MORE **bent edges** than the
plain one. So hints can never make a map worse than the algorithm alone: at worst they cost
a second layout pass. A tie keeps the hints — nothing was lost, and the human drew that
shape on purpose.

A bent edge is a connection that is not aligned on its own axis, or points the wrong way,
or has another room standing in its straight line. Vertical links — up/down exits, and any
link whose two rooms sit on different layers — are **not** counted: the client shows one
layer at a time, so a staircase landing a cell off is invisible to the reader. That is deliberately **not** the same as
a warp: grid cities are classified in relaxed mode (`isCorrectSide`), where an edge whose
target merely lies on the correct side still counts as a clean connector. In Midgaard that
hides two plainly crooked links — 3078→3083 (Бюро Находок, dead east but through the armour
shop) and 3006→3007 (the Snorting Boar, east and a row north) — and counting warps would
call a hint that straightens them worthless.

Seeding was tried first — pin the rooms, then grow the area off them — and it made maps
worse: the rest of the area regrows from a partial skeleton and loses what the algorithm
had right. Correcting a finished layout keeps both halves of the work.

When a hint file stops paying for itself, the build says so **once** for the whole run
(`public/data/hints-report.json`, and one Discord message from `regen-graph.sh`), naming
the areas and both warp counts. Override the hints directory with `HINTS_DIR`.

## Test areas

- `newthalos`, `midgaard` — dense city layouts (avenues + cross-streets)
- `aarak2` — multi-z stress test
- `midennir` — disconnected segments stress test

## Stack

React 18 + TypeScript + Vite + d3-zoom + Fuse.js + MUI v5. Targets integration into [`mudjs`](https://github.com/dreamland-mud/mudjs).
