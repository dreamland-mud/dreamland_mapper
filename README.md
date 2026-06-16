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

## Test areas

- `newthalos`, `midgaard` — dense city layouts (avenues + cross-streets)
- `aarak2` — multi-z stress test
- `midennir` — disconnected segments stress test

## Stack

React 18 + TypeScript + Vite + d3-zoom + Fuse.js + MUI v5. Targets integration into [`mudjs`](https://github.com/dreamland-mud/mudjs).
