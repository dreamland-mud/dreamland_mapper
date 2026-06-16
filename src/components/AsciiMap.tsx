/**
 * Legacy-style ASCII map: rooms on the current z-layer drawn on a monospace grid with
 * `-`/`|` corridors, the old in-game automap look. Rooms are clickable (select / set-current).
 */

import { Fragment, useMemo } from 'react';
import type { AreaLayout } from '../types.js';
import { sectorStyle } from '../sectors.js';

interface Props {
  layout: AreaLayout;
  currentVnum: number | null;
  selectedVnum: number | null;
  onSelectRoom: (vnum: number) => void;
  onSetCurrent: (vnum: number) => void;
}

interface Cell { ch: string; vnum?: number; color?: string }

const ROOM_CH = '#';

export function AsciiMap({ layout, currentVnum, selectedVnum, onSelectRoom, onSetCurrent }: Props) {
  // Show the layer the current room is on.
  const z = currentVnum != null ? (layout.placed[currentVnum]?.z ?? 0) : 0;

  const grid = useMemo<Cell[][]>(() => {
    const onLayer = Object.values(layout.placed).filter((p) => p.z === z);
    if (onLayer.length === 0) return [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of onLayer) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const gw = (maxX - minX) * 2 + 1;
    const gh = (maxY - minY) * 2 + 1;
    const g: Cell[][] = [];
    for (let r = 0; r < gh; r++) g.push(Array.from({ length: gw }, () => ({ ch: ' ' })));
    const gx = (x: number) => (x - minX) * 2;
    const gy = (y: number) => (maxY - y) * 2;

    for (const p of onLayer) {
      const room = layout.rooms[p.vnum];
      const sector = room?.flags?.includes('indoors') ? 'inside' : (room?.sector ?? 'unknown');
      g[gy(p.y)][gx(p.x)] = {
        ch: p.isVoid ? 'X' : ROOM_CH,
        vnum: p.vnum,
        color: p.isVoid ? '#cc0000' : sectorStyle(sector).text,
      };
    }
    for (const e of layout.exits) {
      const a = layout.placed[e.from], b = layout.placed[e.to];
      if (!a || !b || a.z !== z || b.z !== z) continue;
      if ((e.dir === 'east' || e.dir === 'west') && a.y === b.y && Math.abs(a.x - b.x) === 1) {
        const cx = (Math.min(a.x, b.x) - minX) * 2 + 1, cy = gy(a.y);
        if (g[cy][cx].ch === ' ') g[cy][cx] = { ch: '-' };
      } else if ((e.dir === 'north' || e.dir === 'south') && a.x === b.x && Math.abs(a.y - b.y) === 1) {
        const cy = (maxY - Math.max(a.y, b.y)) * 2 + 1, cx = gx(a.x);
        if (g[cy][cx].ch === ' ') g[cy][cx] = { ch: '|' };
      }
    }
    return g;
  }, [layout, z]);

  if (grid.length === 0) return <div className="ascii-map"><pre>—</pre></div>;

  return (
    <div className="ascii-map">
      <pre>
        {grid.map((row, r) => {
          const nodes: React.ReactNode[] = [];
          let buf = '';
          const flush = () => { if (buf) { nodes.push(buf); buf = ''; } };
          row.forEach((cell, c) => {
            if (cell.vnum != null) {
              flush();
              const isCur = cell.vnum === currentVnum;
              const isSel = cell.vnum === selectedVnum;
              const ch = isCur ? '@' : cell.ch;
              const color = isCur ? '#2cf4eb' : isSel ? '#bb86fc' : cell.color;
              const vnum = cell.vnum;
              nodes.push(
                <span key={c} className="ascii-room"
                      style={{ color, fontWeight: (isCur || isSel) ? 700 : 400 }}
                      onClick={() => onSelectRoom(vnum)}
                      onDoubleClick={() => onSetCurrent(vnum)}>{ch}</span>,
              );
            } else {
              buf += cell.ch;
            }
          });
          flush();
          return <Fragment key={r}>{nodes}{'\n'}</Fragment>;
        })}
      </pre>
    </div>
  );
}
