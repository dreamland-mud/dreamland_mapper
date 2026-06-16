# Layout algorithm notes — pickup-where-we-left-off

## Session 5 (2026-06-16): Arcadia — data fix beat the code fix

Arcadia's indoor fey-citadel court was interleaved with the outdoor meadow, and the four
self-looped `Вечная <season>` rooms (12151–12154 — exits all self; reachable only one-way from
the Холлы) were exiled far east as a stray cluster → map-spanning wrong-side diagonals.

First tried a code fix: generalized `embedSouthBlock` → `embedSubBlock` + an arcadia-gated
`embedPalace` that constraint-embedded the z=0 court as a rigid block lifted above the meadow.
It worked (crossings 110→83) but was area-specific code.

**Superseded by a DATA fix (kept): Kit added an up/down stair on the castle entrance
(12119 Врата ⇅ 12123 Вестибюль).** That puts the whole castle on z+1, so the default trunk-first
algo lays it out on its own layer with **zero meadow interference** — the z1 court renders as a
clean symmetric cross (0 warps, 0 crossings on that layer), and the Вечные sit with their Холлы.
Arcadia z0(meadow) keeps its intrinsic tangle (warp18/cross2); overall cross 110→78. **All
embedPalace/embedSubBlock code was reverted** (layout.ts back to the trunk-first baseline;
`embedSouthBlock` is once again the only area-gated exception). Lesson: **a data fix (vertical
entrance → natural z-layer separation) is cleaner and better than area-gated layout code — prefer
it.** For other tangled multi-level areas, adding stair exits in the area is the first lever.

## Session 4 (2026-06-15): midgaard south — constraint re-embed on a local grid

Goal: rebuild midgaard minimising warps, relaxing the grid (rooms/secondary paths needn't
share the main-street grid; lengths may vary).

Key correction to Session 2's "85% of wrong-side warps are irreducible" claim: that floor only
holds under *uniform* spacing. midgaard's room graph is in fact fully **grid-consistent** — a
row/column constraint embedding (union-find rows via E/W edges + columns via N/S edges →
longest-path rank per class → per-rank interval-colouring to separate classes whose perpendicular
spans overlap) places **every** cardinal edge on its correct side with 0 directional warps and 0
collisions, because variable-length connectors absorb the non-zero cycle sums (e.g. the
3111→3118→3135→…→3111 loop sums to (-2,0)).

BUT the global constraint layout **regressed**: killing the 3 lying-arcs cost ~84 room-crossing
detour connectors + a 15-wide×45-tall staircase sprawl (directional-correctness vs clear-paths vs
compactness is a 3-way tension; minimising one alone wrecks the others). Confirmed visually — do
not ship the global version.

It DOES win at **sub-block scale** (low density → almost no obstructions). Shipped:
`embedSouthBlock` re-embeds the Emerald/Park/Crowded complex (vnums 3100–3143 + a few + 3256 the
southern-gate exterior) with the constraint method, then stitches the rigid block into the
already-placed city at the attachment that minimises bent cross-block edges, shifting it clear.
Replaced the old `straightenVertical(3103)` + `placeMidgaardSouth` (deleted). Interval-colouring
(disjoint perpendicular ranges) rather than cell-colouring was needed to kill obstructions too.

Result: midgaard render-accurate bent+warp **18 → 11**; south district **11 → 3, zero warps**.
The 2 long opposite-side diagonals (3118↔3135, 3119↔3133) are gone. Remaining 2 "warps" are a
down-stair (3051→3200) and the river z-jump (3201→3202) — inherent cross-z, not planar lies.
Remaining bends: 3 cross-block south attachments (3071/3104/3124 — multi-attach, auto-minimised) +
~7 pre-existing non-south (hotel, east-wall road, temple — out of scope). Other areas unchanged
(gated to `meta.file === 'midgaard'`; global warps 872 → 871, exactly the gate fix).

Tooling: `scripts/render-svg.mjs <layout.json> <out.svg> [zFilter]` renders any layout JSON to a
diagnostic SVG (grey=clean, orange=bent/detour, magenta=warp, red=wrong-side) for `qlmanage -t`.

## Session 3 (2026-06-14): settled on trunk-first, cleaned up

After Session 2's renderer fix, chased better *layout* (not just rendering). Outcome: the
simple **trunk-first BFS won**, everything fancier regressed. Final state:

- **Single algorithm**: `src/layout/layout.ts` `computeLayout` — trunk-first BFS, depth-first
  along the arrival direction (straight avenues), straight variable-length never-wrong-side
  placement. (This is what was called "+straight" mid-session.) Metrics: ~629 planar warps,
  148 wrong-side, 94% clean, compact. Best of everything tried.
- **Tried and REJECTED** (do not revisit without a fundamentally different idea):
  - *streets-first* (lay longest runs as spines): fixed 9560/midgaard locally but sprawled
    3–10× and flattened grids (area153 → 157×1). Priority-BFS variant still flat-collapsed.
  - *cartographer hybrid* (parse the hand-drawn dreamland.rocks/maps): 3 extraction methods,
    all failed — char positions aren't a clean grid (quantize → 24% jitter; unit-grid from
    ASCII adjacency → conflict cascade → flat sprawl). The maps were drawn for eyes, not
    parsers. Dead end. (fetch-maps script + cartographer.ts deleted.)
  - *SCC edge-sacrifice*, *cleanStragglers* (dir-aware findFreeCell): no win / regressions.
- **Known accepted imperfection**: intersection rooms like newthalos 9560 can sit 1 col off
  their dominant street (9551/9707 align at x54, 9560 at x53). Cartographer fixes it by hand;
  no greedy algorithm reproduced it without breaking the rest. Accepted.
- **Cleanup**: removed bfs.ts (logic moved to layout.ts), all dataset variants, the dataset
  switcher in App.tsx, layered.ts opts (scc/streets/cleanStragglers). One layout, one dataset
  (`public/data`). z0 is the default focus layer.

## Goal
Auto-generate readable 2D maps from MUD area XML. The layout problem is: place each
room in a graph (with cardinal-direction-tagged exits) onto an integer grid such that
each cardinal exit can be drawn as a straight line connector at exactly SPACING=3
cells in its declared direction. Edges that can't be placed cardinally render as
"warps" (curved/dashed).

## Current state of the repo

Two implementations are saved side-by-side; `src/layout/bfs.ts` currently holds the
**rewrite** (cardinal-first BFS). To revert to the layered-passes approach:

```bash
cp backup/bfs.ts.layered-passes.bak src/layout/bfs.ts
npm run build:graph
```

Both backups have matching `data.*.bak/` directories with the area-JSON they produced,
so you can A/B compare in the browser without rebuilding.

| | layered-passes | cardinal-first rewrite |
|---|---|---|
| file | `bfs.ts.layered-passes.bak` | `bfs.ts.cardinal-first-rewrite.bak` |
| LOC  | ~850 | ~600 |
| pipeline | BFS with chain-aware cascade decisions → rectify → snapLeaves → resolveBlockedConnectors | BFS with forward-cascade + long-cardinal fallback → rectifyWarps |
| clean cardinal at SPACING multiples | 9439 | 9375 |
| openDiagonal (styled-cardinal but rendered diagonal) | **62** | 0 |
| warp/bent | 603 | 737 |
| **total visually bent** | **665** | **737** |

The rewrite is *worse* on the headline metric by 72 edges (~10%) but gets to zero
fake-cardinals. Old approach's openDiagonals show up in render as straight diagonal
lines, which look buggy.

## Session 2 (2026-06-14): wrong-side warps — diagnosis + renderer fix

User spotted a room rendered on the wrong side of its parent ("9707 is south of
9551 but shown higher — this can't happen"). Investigation reframed the quality metric.

**The headline metric was blind to direction.** `visualBent = warp + openDiagonal`
counts neither (a) direction *inversions* on clean edges nor (b) *wrong-sided warps*
(target placed in the opposite half-plane from the exit's direction). New metrics:

- rewrite (live): **0** non-warp inversions, but **157 wrong-sided warps** (~21% of 737).
- layered-passes: 7 inversions + **167 wrong-sided warps** (~28% of 603).

**85% of wrong-side warps are mathematically irreducible.** Diagnostic integrates ideal
collision-free coords along a cardinal spanning tree, then classifies each wrong-side warp:

- PACKING-ARTIFACT (ideal satisfies it → fixable by better placement order): **24 (15%)**
- GRAPH-CONTRADICTION + COINCIDENT (wrong even in the ideal → floor): **133 (85%)**

A non-planar room graph with cycles cannot embed every cardinal exit on a 2D grid; some
edge *must* close on the wrong side. The user's 9551↔9707 is one of these — both rooms
integrate to the *same* ideal cell, so a cycle pins them to one row while the direct exit
claims a N/S relationship. Unfixable by any placement reorder.

**Conclusion: trunk-first (idea B/F) is NOT worth it for wrong-side.** Ceiling is the 24
packing artifacts (~0.2% of all edges) and it regresses warp *count*. Only revisit it if
we separately want to cut warp *count* (global floor of cycle-contradictions ≈ 272 edges
/ 2.7%, so current ~735 has ~465 of headroom there).

**Shipped fix — renderer honesty (`src/components/Map.tsx`), not geometry:**
1. Warps restyled unmistakable: dashed (`3 5`) + violet `#9b7cc4` (was solid grey,
   identical to `open`). Applies to all warps.
2. Wrong-side warps (`warpWrongSide()` geometry test) no longer draw a U-turn connector
   to the opposite-side tile — they render as a **labelled stub** off the correct cardinal
   port (`⤳ <target name>`), reusing the cross_area/vertical-stub pattern. Honest for all
   157 regardless of placement.

Also added a **Dataset switcher** in `App.tsx` (rewrite/layered) reading `public/data` vs
`public/data-layered/` for in-browser A/B.

## What we tried during this session (timeline)

1. **Resolve blocked connectors via cascade** (in old approach). Cascading the blocker
   perpendicular cleared the path 217 times but broke 495 unrelated alignments.
   *Lesson:* unconditional cascade is too disruptive; need a regression guard.

2. **Demote-only resolver** (no cascade): drops blockers to warp without moving.
   Eliminated all tile-crossings, but bumped warp count up.

3. **Rectify pass with small-offset-first + size-cap branches + regression guard.**
   This was the best single-pass addition — slid `{9665, 9666}` into y=27 to align
   with 9674. Regression guard (countAllBlockers stayed equal-or-better) was crucial.

4. **Snap leaves**: pull dead-end leaves to within 1 cell of parent. Initial version
   too aggressive (touched leaves at natural SPACING distance); fixed by gating on
   `currentDist > SPACING`. Also fixed to drag z-axis followers (9675/9691).

5. **Cardinal-first BFS rewrite.** No lateral fallback unless cascade and long-axis
   both fail. Single rectify post-pass. Cleaner code but 72 more warps total. The
   problem: old BFS had richer cascade decisions (forward+backward, chain-aware) and
   `resolveBlockedConnectors` was willing to make moves that the new `collectBranch`
   rejects as "leaky" (any external cardinal connection makes a branch unmovable).

## Specific test cases (newthalos)

| vnums | what user wants | layered-passes result | rewrite result |
|---|---|---|---|
| 9665, 9666, 9674, 9675 (cluster) | not on avenue row y=27 | partial: 9665 off, 9674 still on | 9674 at y=24 ✓ |
| 9675 ↔ 9691 (down stairs) | 9691 directly under 9675 | 9691 at (35,30); 9675 at (33,28) — detached | 9691 at (32,26,-1) under 9675 at (32,26,0) ✓ |
| 9604 (dead end) | adjacent to parent 9608, not 6 cells away | snapped to (30,19) ✓ | (29,20) — 1-cell off, both diagonal-warp |
| 9551 (avenue) | on y=27 with 9522/9550 | y=27 ✓ | y=26 — broken avenue ✗ |
| 9546 ↔ 9545 avenue | clean horizontal | warp (blocked by 9674) | clean (9665 not on avenue) ✓ |

## What user wants, in priority order

User's words mid-session: "less connectors intersecting, less bands and less
connectors bending, in this order." Later: "if I'd just tell you to minimize the
number of warps/bents and forget most other instructions..."

So the priority is **minimize total visually-bent connectors** (= warp + openDiagonal).
This is the metric to beat, and the layered-passes approach (665) is currently
unbeaten by the rewrite (737).

## Reference: midennir cartographer's layout

User pointed at `https://dreamland.rocks/maps/midennir.html` as exemplar. Key takeaways
from cartographer Zustin's hand-drawn layout:
- **Variable connector lengths within the same area.** Dense columns (e.g. hotel sub-
  cluster) push their southern neighbours to deep y-bands; sparse columns just have
  long straight verticals. Avenue room 3577 → 3578 is 2 rows; 3505 → 3508 is 5 rows.
- **All rooms snap to a global row-band lattice.** Avenue rooms all share y=0; their
  southern neighbours land at the column-specific deep band, with empty bands just
  having vertical connector lines passing through.
- **No connector intersects a tile** — Zustin chose y-positions specifically to avoid
  this.

## Ideas pool for next session

In rough order of "expected impact / implementation cost":

### A. Port the chain-aware cascade decision (closes most of the 72-edge gap)
The old `tryCascadeShift` had logic in the BFS placement step:
- When ideal cell taken, look at occupant's exit toward source.
- Compute occupant's perpendicular chain length (e.g., east-west chain when cascading
  N-S) and source's parallel chain length.
- If occupant has long perp chain AND source's parallel chain is shorter → backward
  cascade (slide source's chain back, recompute ideal). This protects long avenues
  from being torn apart.
- Else → forward cascade (slide occupant).

This gave the old approach more cardinal placements. Port to the rewrite: keep BFS
structure but add `perpendicularChainLength` and forward/backward decision.

### B. Spanning-tree-first placement
Identify the longest cardinal path through the graph (the "trunk"). Place it first,
then BFS from each trunk room outward. The trunk gets cardinal alignment guaranteed;
side branches conform around it. This matches how human cartographers (like Zustin)
actually draw maps — they identify the avenue first, then graft side streets.

Implementation: DFS to find longest cardinal path → topological-sort placement around
it. Branches with conflicts cascade or warp.

### C. Multi-anchor BFS with "best layout wins"
Run BFS from N different anchors (most-connected, highest-out-degree, geographic
extremes). For each, count visually-bent. Keep the layout with the lowest count.
Cheap if BFS is fast (it is) and gives nondeterminism a chance to find better
configurations.

### D. Sugiyama-style ranked layout (heavy)
Pre-assign each room to a row-band based on BFS distance from anchor along cardinal
axes. Use ranks to enforce "all north-of-trunk rooms at rank +1, etc." This is what
the column-density work in midennir would require to implement properly.

### E. Force-directed post-pass
After BFS, run a few iterations of physical simulation: each cardinal edge is a
spring with rest length SPACING in its direction; rooms repel each other. Snap to
grid at end. Smooth but hard to reason about / debug.

### F. Detect "avenue" rooms and protect their rows
Heuristic: rooms with ≥4 cardinal connections in N-S+E-W directions are avenue
hubs. Protect their rows/columns from intrusion by other clusters during BFS. When
a non-avenue room would land on an avenue row, force it off (cascade or alternative
placement).

## Helper functions worth keeping in the rewrite

The rewrite has these well-tested utilities. Don't re-derive:

- `cellKey(x, y, z)`: spatial index key.
- `findFreeCell(ctx, x, y, z)`: ring search for empty cell within DISPLACEMENT_RADIUS=4.
- `pathHasBlocker(ctx, sx, sy, tx, ty, z)`: check if any cell strictly between two
  axis-aligned points is occupied. Used to gate long-cardinal placements.
- `collectBranch(ctx, seed, excluded)`: BFS collect connected subgraph; returns null
  if the branch has external cardinal connections (i.e., would shear edges to the
  outside if slid). Up/down exits ignored.
- `slideBranch(ctx, branch, dx, dy)`: atomic translate. Pre-checks all targets,
  applies on success, returns false on any collision.
- `pickAnchor(rooms)`: most-connected non-maze room, lowest-vnum tiebreak.
- `geometryIsCardinal(ctx, source, target, exit)`: the "is this edge cardinal?" check
  used by both rectifyWarps and emitAllEdges. Single source of truth.

## Build / test commands

```bash
npm run build         # tsc + vite build
npm run build:graph   # regenerate public/data/area-*.json from dreamland_areas/
npm test              # vitest run, 9 tests
npm run dev           # local dev server for visual inspection
```

The metrics script that produced the comparison table above is inline in this notes
file's history; here it is reproduced:

```js
function metrics(layout) {
  let cleanStraight = 0, openDiagonal = 0, warpEdges = 0;
  for (const e of layout.exits) {
    if (e.style === 'cross_area' || e.style === 'random') continue;
    if (e.dir === 'up' || e.dir === 'down') continue;
    const a = layout.placed[e.from], b = layout.placed[e.to];
    if (!a || !b || a.z !== b.z) continue;
    const ah = (e.dir === 'east' || e.dir === 'west');
    const aligned = ah ? a.y === b.y : a.x === b.x;
    if (e.style === 'warp') { warpEdges++; continue; }
    if (!aligned) { openDiagonal++; continue; }
    cleanStraight++;
  }
  return { cleanStraight, openDiagonal, warpEdges, visualBent: warpEdges + openDiagonal };
}
```

Run with both backup/data.*.bak/area-*.json and public/data/area-*.json to compare.

## What a fresh attempt should NOT do

These were dead ends within this session:

1. **Cascade-shift in resolver without regression guard** — moves 495 unrelated
   alignments to fix 217 blockers.
2. **Strict cardinal-only BFS** (no lateral fallback ever) — stragglers all become
   warps and never get a chance to BFS-extend cardinally to their neighbours.
3. **Removing pathHasBlocker from long-axis fallback + post-pass cascade-blockers
   with regression guard** — the cascade succeeds rarely; net warps go UP.
4. **Snap leaves at `currentDist > 1`** (instead of `> SPACING`) — touches naturally-
   placed rooms and creates conflicts.
5. **Iterating rectify multiple passes** — passes fight each other, undoing earlier
   alignment work.

6. **Direction-aware `findFreeCell`** (Session 2, lever 1) — biased the displacement
   ring-search to the correct half-plane of the source. Premise was "cheap safe win,
   ~21 displacement wrong-sides fixed, no downside." WRONG: placement is order-coupled,
   so forcing correct-side displacement shoves rooms into cells the trunk needed and the
   disruption ripples — warps jumped **735 → 1007 (+270)** for only −8 wrong-side.
   Reverted. Lesson (again): any unguarded placement change has a huge blast radius; the
   real wrong-side fix was in the *renderer*, not the layout.
