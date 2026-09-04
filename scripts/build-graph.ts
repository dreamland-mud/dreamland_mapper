/**
 * Parse dreamland_areas/*.are.xml → per-area JSON layouts.
 *
 * Run: pnpm build:graph
 *
 * Reads from $AREAS_DIR or ../dreamland_areas. Writes to public/data/.
 */

import { XMLParser } from 'fast-xml-parser';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AreaMeta, Direction, Exit, LocalizedText, MapperIndex, Room } from '../src/types.js';
import { ALL_DIRECTIONS } from '../src/types.js';
import { computeLayout } from '../src/layout/layout.js';
import { countBentEdges, hintSummary, pickLayout, readHints, type HintReportRow } from '../src/layout/hints.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const AREAS_DIR = process.env.AREAS_DIR
  ? path.resolve(process.env.AREAS_DIR)
  : path.resolve(PROJECT_ROOT, '..', 'dreamland_areas');
const OUT_DIR = path.join(PROJECT_ROOT, 'public', 'data');
// Hand-corrected coordinates, one file per area. Absent directory = no hints at all,
// which is the state every area starts in.
const HINTS_DIR = process.env.HINTS_DIR
  ? path.resolve(process.env.HINTS_DIR)
  : path.join(PROJECT_ROOT, 'hints');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  // Disable entity expansion: large area files (midgaard, library, etc.) blow past
  // fast-xml-parser's hardcoded 1000-expansion limit. We decode entities ourselves below.
  processEntities: false,
  // <node name="3500">…</node> inside <rooms> is always a list, even with one entry.
  isArray: (name) => name === 'node',
});

function decodeEntities(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos);/g, (_, e) =>
    e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : "'",
  );
}

/**
 * Strip Dreamland render markers from a display string:
 *  - color codes  `{r`, `{g`, `{x`, `{D`, `{1`, `{2` etc. → drop the marker
 *  - gender (flexer) switches `{Sf…{Sm…{Sx` → KEEP verbatim, resolved per player sex by the
 *    web client (mudjs flexer.js); colour codes inside them are still stripped
 *  - pad-string genitive cascades  `майст|ер|ра|ру|ра|ром|ре` → keep just the nominative head
 *    (text before the first `|`)
 *  - `{hh<vnum>...{x` help anchors → keep inner text only
 *  - extra whitespace from gender-marker dropouts → collapse
 */
function stripMarkers(s: string): string {
  let out = s;
  // {hh<vnum>text{x → text  (help anchors)
  out = out.replace(/\{hh\d+([^{]*)\{x/g, '$1');
  // Clickable command links {hc<text>{hx / {hc<text>{x (the <text> may itself contain
  // colour codes, e.g. {hc{cюг{x{x). Drop the {hc opener and {hx closer; the generic
  // stripper below removes any inner colour codes and the trailing {x. Must run before
  // that stripper, which would otherwise eat "{h" and leave the stray "c" (the "cюг" bug).
  out = out.replace(/\{hc/g, '');
  out = out.replace(/\{hx/g, '');
  // Preserve gender (flexer) switches {Sm}{Sf}{Sx so the web client can resolve them per
  // player sex instead of baking a single (male) form here. Shield them from the generic
  // {<alnum> stripper below (which would eat "{S" and leave a stray "m"/"f"), then restore.
  // Colour codes inside the switch content are NOT shielded, so they still get stripped.
  out = out.replace(/\{S([mfx])/g, '\x01$1');
  // generic color/style codes: {<letter or digit>
  out = out.replace(/\{[a-zA-Z0-9]/g, '');
  // restore the shielded flexer switches
  out = out.replace(/\x01([mfx])/g, '{S$1');
  // Flexer pad-string cascade: <stem>|<nom>|<gen>|<dat>|<acc>|<inst>|<prep>
  // Render nominative form: stem + first case ending. Repeat for each cascade in the string.
  // Case alternates contain no spaces (word-internal), so use [^\s|]* to prevent
  // the last segment from eating across word boundaries (e.g. "ом Талос" as one match).
  out = out.replace(
    /(\S+?)\|([^\s|]*)\|([^\s|]*)\|([^\s|]*)\|([^\s|]*)\|([^\s|]*)\|([^\s|]*)/g,
    (_match, stem, nom) => stem + nom,
  );
  // collapse double spaces
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

function arr<T>(x: T | T[] | undefined | null): T[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

/** Pull text from a `<tag l="ru">value</tag>` array, preferring ru → en → ua → first. */
function pickLang(nodes: any | any[] | undefined): string {
  if (nodes == null) return '';
  const list = arr(nodes);
  const pick = (l: string) => list.find((n) => n?.['@_l'] === l);
  const node = pick('ru') ?? pick('en') ?? pick('ua') ?? list[0];
  if (node == null) return '';
  const raw = typeof node === 'string' ? node : String(node['#text'] ?? '');
  return stripMarkers(decodeEntities(raw.trim()));
}

/** Pull a `<tag l="LANG">value</tag>` for one specific language only (no fallback). */
function langOf(nodes: any | any[] | undefined, l: string): string {
  if (nodes == null) return '';
  const node = arr(nodes).find((n) => n?.['@_l'] === l);
  if (node == null) return '';
  const raw = typeof node === 'string' ? node : String(node['#text'] ?? '');
  return stripMarkers(decodeEntities(raw.trim()));
}

/**
 * Per-language name (+ optional description, + optional speedwalk) for the non-default
 * locales, so the web map can render room/area text in the viewer's config language.
 * The default fields stay RU-preferred (pickLang); this only carries en/ua when the XML
 * has them. Returns undefined when nothing localizes, to keep the JSON lean.
 */
function i18nOf(nameNodes: any, descNodes?: any, walkNodes?: any): LocalizedText | undefined {
  const out: LocalizedText = {};
  for (const l of ['en', 'ua'] as const) {
    const entry: { name?: string; description?: string; speedwalk?: string } = {};
    const n = langOf(nameNodes, l);
    if (n) entry.name = n;
    if (descNodes !== undefined) {
      const d = langOf(descNodes, l);
      if (d) entry.description = d;
    }
    if (walkNodes !== undefined) {
      const w = langOf(walkNodes, l);
      if (w) entry.speedwalk = w;
    }
    if (entry.name || entry.description || entry.speedwalk) out[l] = entry;
  }
  return out.en || out.ua ? out : undefined;
}

function parseFlags(raw: string | undefined): string[] {
  if (!raw) return [];
  return String(raw).trim().split(/\s+/).filter(Boolean);
}

function parseExit(dir: Direction, node: any): Exit | null {
  const targetRaw = node?.target;
  if (targetRaw == null || targetRaw === '') return null;
  const target = Number(targetRaw);
  if (!Number.isFinite(target) || target < 0) return null;
  const exit: Exit = {
    dir,
    target,
    flags: parseFlags(node?.flags),
  };
  const key = node?.key;
  if (key != null && key !== '' && Number(key) >= 0) exit.key = Number(key);
  const kw = pickLang(node?.keyword);
  if (kw) exit.keyword = kw;
  return exit;
}

function parseArea(filePath: string, file: string): { meta: AreaMeta; rooms: Room[] } | null {
  let xml: string;
  try {
    xml = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    console.warn(`[parse-fail] ${file}:`, (err as Error).message);
    return null;
  }
  const area = doc?.area;
  if (!area) return null;

  const ad = area.areadata ?? {};
  const meta: AreaMeta = {
    file,
    name: pickLang(ad.name) || file,
    vnumLow: Number(ad.vnumLow ?? 0),
    vnumHigh: Number(ad.vnumHigh ?? 0),
    levelLow: Number(ad.levelLow ?? 0),
    levelHigh: Number(ad.levelHigh ?? 0),
    authors: String(ad.authors ?? ''),
    flags: parseFlags(ad.flags),
    speedwalk: pickLang(ad.speedwalk) || undefined,
    altname: pickLang(ad.altname) || undefined,
    /* Most speedwalks are a compass path and read the same in any language, but
       30 of them are a sentence ("enter the portal in your city's temple"), and
       pickLang alone handed the Russian one to every reader. The area XML has
       had all three languages all along. */
    i18n: i18nOf(ad.name, undefined, ad.speedwalk),
  };

  const roomNodes = arr(area.rooms?.node);
  const rooms: Room[] = [];
  for (const rn of roomNodes) {
    const vnum = Number(rn?.['@_name']);
    if (!Number.isFinite(vnum)) continue;

    const exitNodes = arr(rn?.exits?.node);
    const exits: Exit[] = [];
    for (const en of exitNodes) {
      const dirName = String(en?.['@_name'] ?? '') as Direction;
      if (!ALL_DIRECTIONS.includes(dirName)) continue;
      const ex = parseExit(dirName, en);
      if (ex) exits.push(ex);
    }

    rooms.push({
      vnum,
      area: file,
      name: pickLang(rn?.name),
      description: pickLang(rn?.description),
      sector: String(rn?.sector ?? 'unknown'),
      flags: parseFlags(rn?.flags),
      exits,
      i18n: i18nOf(rn?.name, rn?.description),
    });
  }

  return { meta, rooms };
}

function main() {
  if (!fs.existsSync(AREAS_DIR)) {
    console.error(`AREAS_DIR not found: ${AREAS_DIR}`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Read area.lst.xml for ordering, but fall back to glob.
  const lstPath = path.join(AREAS_DIR, 'area.lst.xml');
  let areaFiles: string[] = [];
  if (fs.existsSync(lstPath)) {
    const lstDoc = parser.parse(fs.readFileSync(lstPath, 'utf-8'));
    areaFiles = arr(lstDoc?.arealist?.node).map((n: any) => {
      // entries look like <node>limbo.are</node>
      if (typeof n === 'string') return n;
      if (n?.['#text']) return String(n['#text']);
      return null;
    }).filter((s): s is string => !!s);
  }
  if (areaFiles.length === 0) {
    areaFiles = fs.readdirSync(AREAS_DIR)
      .filter((f) => f.endsWith('.are.xml'))
      .map((f) => f.replace(/\.xml$/, ''));
  }

  // Finished areas intentionally absent from area.lst.xml that should still be mapped
  // (players can reach them, e.g. via a portal). Mirror the game's list + these extras;
  // we deliberately do NOT map every on-disk file (that would pull in hidden stubs and
  // instanced/disabled zones like donjon). Added only if present on disk.
  //
  // NOTE: Orodruin / Mount Doom (vnum 35000-35099) used to live here as the stale
  // `area148.are` snapshot, mapped because orodruin wasn't yet in area.lst.xml. It now IS
  // (orodruin.are, the current 35k file the game loads), so it maps normally — adding
  // area148 again would map the same vnums twice from an outdated April snapshot.
  const EXTRA_AREAS: string[] = [];
  for (const extra of EXTRA_AREAS) {
    const stem = extra.replace(/\.are$/, '');
    if (
      fs.existsSync(path.join(AREAS_DIR, `${stem}.are.xml`)) &&
      !areaFiles.includes(extra) &&
      !areaFiles.includes(stem)
    ) {
      areaFiles.push(extra);
    }
  }

  console.log(`Parsing ${areaFiles.length} areas from ${AREAS_DIR}…`);

  const allMeta: AreaMeta[] = [];
  const vnumToArea: Record<number, string> = {};
  // First pass — parse + build vnum→area index for cross-area resolution.
  const parsed: Array<{ meta: AreaMeta; rooms: Room[] }> = [];
  for (const fname of areaFiles) {
    const stem = fname.replace(/\.are$/, '');
    const fp = path.join(AREAS_DIR, `${stem}.are.xml`);
    if (!fs.existsSync(fp)) continue;
    const r = parseArea(fp, stem);
    if (!r) continue;
    parsed.push(r);
    allMeta.push(r.meta);
    for (const room of r.rooms) vnumToArea[room.vnum] = stem;
  }

  // Second pass — layout.
  let totalRooms = 0;
  let totalEdges = 0;
  let totalWarps = 0;
  let totalVoids = 0;
  let totalBent = 0;
  const hintRows: HintReportRow[] = [];
  for (const { meta, rooms } of parsed) {
    if (rooms.length === 0) continue;
    // Areas with hints are laid out TWICE and the better run wins. Hints are a human's
    // guess about a graph no algorithm reads perfectly; the build measures the guess
    // instead of trusting it, so a stale hint file degrades to "slightly slower build".
    const load = readHints(HINTS_DIR, meta.file, rooms);
    const native = computeLayout(meta, rooms, vnumToArea);
    const hinted = load && load.hints.size ? computeLayout(meta, rooms, vnumToArea, load.hints) : null;
    const choice = pickLayout(native, hinted);
    if (load) {
      hintRows.push({
        area: meta.file,
        bentNative: choice.bentNative,
        bentHinted: choice.bentHinted,
        warpsNative: choice.warpsNative,
        warpsHinted: choice.warpsHinted,
        used: choice.used,
        warnings: load.warnings,
      });
    }
    const layout = choice.layout;
    totalRooms += rooms.length;
    totalEdges += layout.exits.length;
    totalWarps += layout.exits.filter((e) => e.style === 'warp').length;
    totalBent += countBentEdges(layout);
    totalVoids += Object.values(layout.placed).filter((p) => p.isVoid).length;
    fs.writeFileSync(path.join(OUT_DIR, `area-${meta.file}.json`), JSON.stringify(layout));
  }

  const index: MapperIndex = { areas: allMeta, vnumToArea };
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index));

  console.log(`✓ Built ${parsed.length} areas, ${totalRooms} rooms, ${totalEdges} edges`);
  console.log(`  warps: ${totalWarps}, bent edges: ${totalBent}, void rooms: ${totalVoids}`);

  // Hints: one report for the whole run. The file is what regen-graph.sh forwards to
  // Discord — a single message, never one per area.
  if (hintRows.length) {
    const helped = hintRows.filter((r) => r.used);
    const saved = helped.reduce((sum, r) => sum + (r.bentNative - r.bentHinted), 0);
    console.log(`  hints: ${helped.length} of ${hintRows.length} area(s) improved, ${saved} bent edges straightened`);
    const summary = hintSummary(hintRows);
    fs.writeFileSync(
      path.join(OUT_DIR, 'hints-report.json'),
      JSON.stringify({ areas: hintRows, summary }, null, 2),
    );
    if (summary) console.log(summary);
  }
}

main();
