import { useEffect, useMemo, useRef, useState } from 'react';
import type { AreaLayout, MapperIndex } from '../types.js';
import { Map } from './Map.js';
import { AsciiMap } from './AsciiMap.js';
import { SidePanel } from './SidePanel.js';
import { Search } from './Search.js';
import { findPath, pathToSpeedwalk } from '../pathfinding.js';
import { t } from '../i18n.js';

const TARGET_AREAS = ['newthalos', 'midgaard', 'aarak2', 'midennir'];

/** Placeholder current-room anchors per area until the live player position is wired in
 *  post-integration. There must always be a current room — never null. */
const DEFAULT_CURRENT: Record<string, number> = {
  newthalos: 9506, // В Центре Рыночной Площади
};

/** Re-base z (in place) so the ground floor becomes z=0. Considers only the MAIN (largest)
 * cluster, ignoring stray disconnected rooms. If one layer holds a clear plurality (>=40%)
 * of the cluster's rooms it is the ground (flat cities → the room level); otherwise the
 * layer with the most cross-area exits is the ground (towers → the entrance floor). */
function rebaseZ(l: AreaLayout): void {
  const clusterSize: Record<number, number> = {};
  for (const p of Object.values(l.placed)) clusterSize[p.cluster] = (clusterSize[p.cluster] || 0) + 1;
  let mainCluster = 0, mainSize = -1;
  for (const [c, n] of Object.entries(clusterSize)) if (n > mainSize) { mainSize = n; mainCluster = Number(c); }

  const roomZ: Record<number, number> = {};
  for (const p of Object.values(l.placed)) if (p.cluster === mainCluster) roomZ[p.z] = (roomZ[p.z] || 0) + 1;
  let mostRoomsZ = 0, maxRooms = -1;
  for (const [z, n] of Object.entries(roomZ)) if (n > maxRooms) { maxRooms = n; mostRoomsZ = Number(z); }
  if (maxRooms < 0) return;

  let target = mostRoomsZ;
  if (maxRooms < 0.4 * mainSize) {
    const crossZ: Record<number, number> = {};
    for (const e of l.exits) {
      if (e.style !== 'cross_area') continue;
      const p = l.placed[e.from];
      if (p && p.cluster === mainCluster) crossZ[p.z] = (crossZ[p.z] || 0) + 1;
    }
    const entries = Object.entries(crossZ);
    if (entries.length) target = Number(entries.sort((a, b) => b[1] - a[1])[0][0]);
  }
  if (target === 0) return;
  for (const p of Object.values(l.placed)) p.z -= target;
  l.zLayers = l.zLayers.map((z) => z - target).sort((a, b) => a - b);
}

export function App() {
  const [index, setIndex] = useState<MapperIndex | null>(null);
  const [areaFile, setAreaFile] = useState<string>(TARGET_AREAS[0]);
  const [layout, setLayout] = useState<AreaLayout | null>(null);
  const [currentVnum, setCurrentVnum] = useState<number | null>(null);
  const [selectedVnum, setSelectedVnum] = useState<number | null>(null);
  const [zFilter, setZFilter] = useState<number | 'all'>(0);
  const [ascii, setAscii] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // When arriving via a cross-area exit, land on this vnum in the freshly loaded area.
  const pendingVnumRef = useRef<number | null>(null);

  // Load index once.
  useEffect(() => {
    fetch('/data/index.json').then((r) => r.json()).then(setIndex).catch((err) => {
      console.error('Failed to load index.json — did you run `npm run build:graph`?', err);
    });
  }, []);

  // Load area on selection.
  useEffect(() => {
    fetch(`/data/area-${areaFile}.json`)
      .then((r) => r.json())
      .then((l: AreaLayout) => {
        rebaseZ(l); // make the ground layer z=0 before choosing the start room / default layer
        setLayout(l);
        // Pick the current room: a vnum we arrived at via a cross-area exit, else a known
        // anchor per area (market-square centre for newthalos), else a room on the ground
        // layer (z=0 after rebase). Set it as BOTH current and selected. Never null.
        const vals = Object.values(l.placed);
        const pending = pendingVnumRef.current;
        pendingVnumRef.current = null;
        const preferred = (pending != null && l.placed[pending]) ? pending : DEFAULT_CURRENT[areaFile];
        const start = (preferred != null && l.placed[preferred])
          ? l.placed[preferred]
          : (vals.find((p) => p.z === 0) ?? vals[0]);
        const startVnum = start ? start.vnum : null;
        setCurrentVnum(startVnum);
        setSelectedVnum(startVnum);
        setZFilter(start ? start.z : 0);
      })
      .catch((err) => console.error(`Failed to load area-${areaFile}`, err));
  }, [areaFile]);

  // Toast auto-dismiss.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const allAreas = useMemo(() => {
    if (!index) return [];
    return [...index.areas].sort((a, b) => a.file.localeCompare(b.file));
  }, [index]);

  // Active z-layer: follows the focused room. Selecting a tile re-focuses to its layer.
  const activeZ = useMemo(() => {
    if (!layout) return 0;
    const focus = selectedVnum ?? currentVnum;
    if (focus == null) return 0;
    return layout.placed[focus]?.z ?? 0;
  }, [layout, selectedVnum, currentVnum]);

  /** "Go to" a room: set as current AND select so the side panel refreshes to that room. */
  const goTo = (vnum: number) => {
    setCurrentVnum(vnum);
    setSelectedVnum(vnum);
  };

  /** Cross-area exit clicked: load the destination zone and land on the target room. */
  const handleCrossArea = (file: string, vnum: number) => {
    if (!file) return;
    pendingVnumRef.current = vnum;
    setAreaFile(file);
  };

  const handleRunTo = (target: number) => {
    if (!layout) return;
    if (currentVnum == null) {
      setToast(t.setCurrentFirst);
      return;
    }
    if (target === currentVnum) {
      setToast(t.alreadyThere);
      return;
    }
    const path = findPath(layout, currentVnum, target);
    if (!path) {
      setToast(t.noPath);
      return;
    }
    if (path.length === 0) {
      setToast(t.alreadyThere);
      return;
    }
    const speedwalk = pathToSpeedwalk(path);
    const cmd = `run ${speedwalk}`;
    navigator.clipboard?.writeText(cmd).catch(() => {});
    setToast(`${cmd}  ·  ${t.steps(path.length)}  ·  ${t.copied}`);
    console.log('[runTo]', { from: currentVnum, to: target, path, command: cmd });
    // Simulate the player actually running there: the target becomes the current room.
    goTo(target);
  };

  if (!index) return <div className="loading">{t.loadingIndex}</div>;
  if (!layout) return <div className="loading">{t.loadingArea}</div>;

  return (
    <div className="app-shell">
      <header className="topbar">
        <label className="field">
          <span className="field-label">{t.area}</span>
          <select
            className="select select--area"
            value={areaFile}
            onChange={(e) => setAreaFile(e.target.value)}
            aria-label={t.selectArea}
          >
            <optgroup label={t.testAreas}>
              {TARGET_AREAS.map((f) => <option key={f} value={f}>{f}</option>)}
            </optgroup>
            <optgroup label={t.allAreas}>
              {allAreas.map((a) => (
                <option key={a.file} value={a.file}>
                  {a.file}{a.name ? ` — ${a.name.slice(0, 28)}` : ''}
                </option>
              ))}
            </optgroup>
          </select>
        </label>

        <Search layout={layout} onPick={(v) => { setSelectedVnum(v); }} />

        <span className="spacer" />

        <label className="field">
          <span className="field-label">{t.layer}</span>
          <select
            className="select select--small"
            value={zFilter === 'all' ? 'all' : String(zFilter)}
            onChange={(e) => setZFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            aria-label={t.zLayerFilter}
          >
            <option value="all">{t.allLayers}</option>
            {layout.zLayers.map((z) => (
              <option key={z} value={z}>z = {z >= 0 ? `+${z}` : z}</option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className={`toggle-btn${ascii ? ' is-on' : ''}`}
          aria-pressed={ascii}
          onClick={() => setAscii((v) => !v)}
        >
          [ASCII]
        </button>
      </header>

      <main className="main">
        {ascii ? (
          <AsciiMap
            layout={layout}
            currentVnum={currentVnum}
            selectedVnum={selectedVnum}
            onSelectRoom={setSelectedVnum}
            onSetCurrent={goTo}
          />
        ) : (
          <Map
            layout={layout}
            index={index}
            currentVnum={currentVnum}
            selectedVnum={selectedVnum}
            activeZ={activeZ}
            onSelectRoom={setSelectedVnum}
            onSetCurrent={goTo}
            onCrossArea={handleCrossArea}
            onChangeZ={(z) => setZFilter(z)}
            zFilter={zFilter}
          />
        )}
        {toast && (
          <div role="status" className="toast">{toast}</div>
        )}
      </main>

      <aside className="aside">
        <SidePanel
          layout={layout}
          index={index}
          vnum={selectedVnum}
          currentVnum={currentVnum}
          onSetCurrent={goTo}
          onRunTo={handleRunTo}
        />
      </aside>
    </div>
  );
}
