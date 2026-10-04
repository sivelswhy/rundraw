import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { place, simplify, type LngLat, type Placement, type Pt } from './geometry';

// Réseau de rues lu dans les tuiles vectorielles OpenFreeMap (zoom 14 : toutes
// les rues et chemins). Les intersections sont les sommets partagés entre voies,
// donc ponts et tunnels ne se croisent pas par erreur.

const Z = 14;
const TILEJSON = 'https://tiles.openfreemap.org/planet';
const MAX_TILES = 64;

/** Classes OpenMapTiles praticables à pied. */
const WALKABLE = new Set(['primary', 'secondary', 'tertiary', 'minor', 'service', 'track', 'path', 'pedestrian', 'living_street']);

let tileUrl: Promise<string> | null = null;
const tiles = new Map<string, Promise<RawTile>>();

interface RawLine {
  /** Coordonnées x, y alternées, en pixels globaux au zoom 14 (extent 4096). */
  xy: number[];
  /** Extrémités posées sur le bord de la tuile, à recoudre avec la voisine. */
  startOnEdge: boolean;
  endOnEdge: boolean;
}

interface RawTile {
  lines: RawLine[];
}

function getTileUrl() {
  tileUrl ??= fetch(TILEJSON)
    .then((r) => r.json())
    .then((j) => j.tiles[0] as string)
    .catch((e) => {
      tileUrl = null;
      throw e;
    });
  return tileUrl;
}

function loadTile(x: number, y: number): Promise<RawTile> {
  const key = `${x}/${y}`;
  let p = tiles.get(key);
  if (!p) {
    p = getTileUrl()
      .then((url) => fetch(url.replace('{z}', String(Z)).replace('{x}', String(x)).replace('{y}', String(y))))
      .then(async (res) => {
        if (res.status === 204 || res.status === 404) return { lines: [] };
        if (!res.ok) throw new Error(`Tuile ${key} : ${res.status}`);
        return decodeTile(new Uint8Array(await res.arrayBuffer()), x, y);
      });
    p.catch(() => tiles.delete(key));
    tiles.set(key, p);
  }
  return p;
}

function decodeTile(buf: Uint8Array, tx: number, ty: number): RawTile {
  const layer = new VectorTile(new PbfReader(buf)).layers.transportation;
  const lines: RawLine[] = [];
  if (!layer) return { lines };
  const k = 4096 / layer.extent;
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    const props = f.properties;
    if (!WALKABLE.has(String(props.class))) continue;
    if (props.access === 'no' || props.foot === 'no') continue;
    for (const ring of f.loadGeometry()) {
      if (ring.length < 2) continue;
      const pts = ring.map((p) => [tx * 4096 + Math.round(p.x * k), ty * 4096 + Math.round(p.y * k)] as Pt);
      lines.push(...clipToTile(pts, tx * 4096, ty * 4096));
    }
  }
  return { lines };
}

/**
 * Découpe une polyligne exactement au carré de sa tuile. Les tuiles débordent
 * d'une marge sur leurs voisines ; sans découpe nette, une rue qui traverse la
 * frontière serait coupée en deux morceaux qui ne se touchent pas.
 */
function clipToTile(pts: Pt[], x0: number, y0: number): RawLine[] {
  const x1 = x0 + 4096, y1 = y0 + 4096;
  const out: RawLine[] = [];
  let cur: RawLine | null = null;

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const clip = clipSegment(a, b, x0, y0, x1, y1);
    if (!clip) {
      if (cur) { out.push(cur); cur = null; }
      continue;
    }
    const [p, q, enters, exits] = clip;
    if (!cur || enters) {
      if (cur) out.push(cur);
      cur = { xy: [p[0], p[1]], startOnEdge: enters, endOnEdge: false };
    }
    cur.xy.push(q[0], q[1]);
    if (exits) {
      cur.endOnEdge = true;
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out.filter((l) => l.xy.length >= 4);
}

/** Liang–Barsky ; les points de coupe sont posés pile sur le bord. */
function clipSegment(a: Pt, b: Pt, x0: number, y0: number, x1: number, y1: number): [Pt, Pt, boolean, boolean] | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = 0, t1 = 1, e0 = -1, e1 = -1;
  const checks: [number, number, number][] = [[-dx, a[0] - x0, 0], [dx, x1 - a[0], 1], [-dy, a[1] - y0, 2], [dy, y1 - a[1], 3]];
  for (const [p, q, edge] of checks) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) { t0 = r; e0 = edge; }
    } else {
      if (r < t0) return null;
      if (r < t1) { t1 = r; e1 = edge; }
    }
  }
  const at = (t: number, edge: number): Pt => {
    const pt: Pt = [a[0] + t * dx, a[1] + t * dy];
    if (edge === 0) pt[0] = x0;
    if (edge === 1) pt[0] = x1;
    if (edge === 2) pt[1] = y0;
    if (edge === 3) pt[1] = y1;
    return pt;
  };
  const enters = t0 > 0, exits = t1 < 1;
  if (t1 - t0 < 1e-9 && (enters || exits)) return null;
  return [enters ? at(t0, e0) : a, exits ? at(t1, e1) : b, enters, exits];
}

// ---------------------------------------------------------------- Projections

const WORLD = 4096 * 2 ** Z;

function lngLatToGlobal([lng, lat]: LngLat): Pt {
  const s = Math.sin((lat * Math.PI) / 180);
  return [((lng + 180) / 360) * WORLD, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD];
}

function globalToLngLat(gx: number, gy: number): LngLat {
  const n = Math.PI - (2 * Math.PI * gy) / WORLD;
  return [(gx / WORLD) * 360 - 180, (Math.atan(Math.sinh(n)) * 180) / Math.PI];
}

/** Plan local en mètres (x vers l'est, y vers le nord) autour d'un point de référence. */
class Local {
  private cos: number;
  constructor(private ref: LngLat) {
    this.cos = Math.cos((ref[1] * Math.PI) / 180);
  }
  to([lng, lat]: LngLat): Pt {
    return [(lng - this.ref[0]) * 111_320 * this.cos, (lat - this.ref[1]) * 111_320];
  }
  from([x, y]: Pt): LngLat {
    return [this.ref[0] + x / (111_320 * this.cos), this.ref[1] + y / 111_320];
  }
}

// ---------------------------------------------------------------- Graphe

interface Graph {
  xy: Float64Array;
  lngLat: LngLat[];
  adj: number[][];
  /** Index spatial des nœuds : cellule → nœuds. */
  cells: Map<string, number[]>;
  cell: number;
  /** Nœuds du réseau principal (les bouts de chemin isolés sont ignorés). */
  main: Uint8Array;
  local: Local;
}

const CELL = 60;

function buildGraph(raws: RawTile[], ref: LngLat): Graph {
  const local = new Local(ref);
  const ids = new Map<number, number>();
  const xs: number[] = [];
  const lngLat: LngLat[] = [];
  const adj: number[][] = [];
  const edgeSeen = new Set<number>();

  // Points de frontière : la même rue, vue depuis deux tuiles, tombe au même
  // endroit du bord à une fraction de pixel près. On les fusionne.
  const edgeIds = new Map<string, { along: number; id: number }[]>();
  const edgeNode = (gx: number, gy: number) => {
    const onX = gx % 4096 === 0;
    const line = onX ? `x${gx}` : `y${gy}`;
    const along = onX ? gy : gx;
    const bucket = Math.floor(along);
    for (const b of [bucket - 1, bucket, bucket + 1]) {
      for (const e of edgeIds.get(`${line}:${b}`) ?? []) if (Math.abs(e.along - along) < 1.5) return e.id;
    }
    const id = node(Math.round(gx), Math.round(gy), true);
    const k = `${line}:${bucket}`;
    if (!edgeIds.has(k)) edgeIds.set(k, []);
    edgeIds.get(k)!.push({ along, id });
    return id;
  };

  const node = (gx: number, gy: number, fresh = false): number => {
    const key = gx * 2 ** 27 + gy;
    let id = fresh ? undefined : ids.get(key);
    if (id === undefined) {
      id = lngLat.length;
      if (!fresh) ids.set(key, id);
      const ll = globalToLngLat(gx, gy);
      lngLat.push(ll);
      const [x, y] = local.to(ll);
      xs.push(x, y);
      adj.push([]);
    }
    return id;
  };

  for (const raw of raws) {
    for (const { xy: line, startOnEdge, endOnEdge } of raw.lines) {
      const last = line.length - 2;
      const at = (i: number) =>
        (i === 0 && startOnEdge) || (i === last && endOnEdge) ? edgeNode(line[i], line[i + 1]) : node(line[i], line[i + 1]);
      let prev = at(0);
      for (let i = 2; i < line.length; i += 2) {
        const cur = at(i);
        if (cur !== prev) {
          // Les tuiles voisines se chevauchent : on ignore les arêtes déjà vues.
          const key = Math.min(prev, cur) * 4_194_304 + Math.max(prev, cur);
          if (!edgeSeen.has(key)) {
            edgeSeen.add(key);
            adj[prev].push(cur);
            adj[cur].push(prev);
          }
        }
        prev = cur;
      }
    }
  }

  const xy = Float64Array.from(xs);
  const main = mainComponent(adj);
  const cells = new Map<string, number[]>();
  for (let i = 0; i < lngLat.length; i++) {
    if (!main[i]) continue;
    const k = `${Math.floor(xy[i * 2] / CELL)},${Math.floor(xy[i * 2 + 1] / CELL)}`;
    let c = cells.get(k);
    if (!c) cells.set(k, (c = []));
    c.push(i);
  }
  return { xy, lngLat, adj, cells, cell: CELL, local, main };
}

/** Plus grande composante connexe du réseau. */
function mainComponent(adj: number[][]): Uint8Array {
  const comp = new Int32Array(adj.length).fill(-1);
  let best = -1, bestSize = 0;
  const stack: number[] = [];
  for (let s = 0, c = 0; s < adj.length; s++) {
    if (comp[s] >= 0) continue;
    let size = 0;
    comp[s] = c;
    stack.push(s);
    while (stack.length) {
      const n = stack.pop()!;
      size++;
      for (const m of adj[n]) if (comp[m] < 0) { comp[m] = c; stack.push(m); }
    }
    if (size > bestSize) { bestSize = size; best = c; }
    c++;
  }
  return Uint8Array.from(comp, (c) => (c === best ? 1 : 0));
}

function nearestNode(g: Graph, [x, y]: Pt, maxDist: number): number {
  const r = Math.ceil(maxDist / g.cell);
  const cx = Math.floor(x / g.cell), cy = Math.floor(y / g.cell);
  let best = -1, bestD = maxDist;
  for (let i = -r; i <= r; i++) {
    for (let j = -r; j <= r; j++) {
      for (const n of g.cells.get(`${cx + i},${cy + j}`) ?? []) {
        const d = Math.hypot(g.xy[n * 2] - x, g.xy[n * 2 + 1] - y);
        if (d < bestD) { bestD = d; best = n; }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------- Itinéraire qui épouse le dessin

function distToSegment(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

class Heap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() { return this.ids.length; }
  push(id: number, key: number) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id); keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p]; keys[i] = keys[p];
      i = p;
    }
    ids[i] = id; keys[i] = key;
  }
  pop(): number {
    const { ids, keys } = this;
    const top = ids[0];
    const lastId = ids.pop()!, lastKey = keys.pop()!;
    if (ids.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= ids.length) break;
        if (c + 1 < ids.length && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= lastKey) break;
        ids[i] = ids[c]; keys[i] = keys[c];
        i = c;
      }
      ids[i] = lastId; keys[i] = lastKey;
    }
    return top;
  }
}

/** Nœuds du réseau principal à moins de `radius` d'un point. */
function nodesNear(g: Graph, [x, y]: Pt, radius: number): number[] {
  const r = Math.ceil(radius / g.cell);
  const cx = Math.floor(x / g.cell), cy = Math.floor(y / g.cell);
  const out: number[] = [];
  for (let i = -r; i <= r; i++) {
    for (let j = -r; j <= r; j++) {
      for (const n of g.cells.get(`${cx + i},${cy + j}`) ?? []) {
        if (Math.hypot(g.xy[n * 2] - x, g.xy[n * 2 + 1] - y) <= radius) out.push(n);
      }
    }
  }
  return out;
}

/**
 * A* d'un nœud vers l'angle suivant du dessin. Chaque rue coûte sa longueur,
 * majorée selon son écart au trait (segment a→b) : le chemin retenu est celui
 * qui colle à la forme, pas le plus court. L'arrivée peut se faire sur
 * n'importe quel nœud proche de l'angle (avec un coût selon la distance) :
 * on évite ainsi le crochet autour d'un pâté de maisons pour toucher le nœud
 * le plus proche.
 */
function legRoute(g: Graph, from: number, targets: Map<number, number>, a: Pt, b: Pt, sigma: number, budget: number): number[] | null {
  const radius = sigma * 2;
  const cost = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, number>();
  const heap = new Heap();
  const SINK = -1;
  let best = -1, bestCost = Infinity;
  heap.push(from, 0);
  let visited = 0;
  while (heap.size) {
    const n = heap.pop();
    if (n === SINK) break;
    if (++visited > budget) return null;
    const cn = cost.get(n)!;
    const finish = targets.get(n);
    if (finish !== undefined && cn + finish < bestCost) {
      bestCost = cn + finish;
      best = n;
      heap.push(SINK, bestCost);
    }
    const nx = g.xy[n * 2], ny = g.xy[n * 2 + 1];
    const dn = distToSegment(nx, ny, a, b);
    for (const m of g.adj[n]) {
      const mx = g.xy[m * 2], my = g.xy[m * 2 + 1];
      const len = Math.hypot(mx - nx, my - ny);
      const dm = distToSegment(mx, my, a, b);
      const dmid = distToSegment((nx + mx) / 2, (ny + my) / 2, a, b);
      const dev = (dn + dm + 2 * dmid) / 4 / sigma;
      const c = cn + len * (1 + Math.min(dev * dev, 60));
      if (c < (cost.get(m) ?? Infinity)) {
        cost.set(m, c);
        prev.set(m, n);
        heap.push(m, c + Math.max(0, Math.hypot(b[0] - mx, b[1] - my) - radius));
      }
    }
  }
  if (best < 0) return null;
  const path = [best];
  for (let n = best; n !== from; ) {
    n = prev.get(n)!;
    path.push(n);
  }
  return path.reverse();
}

/** Nœuds d'arrivée possibles autour d'un angle, avec leur coût d'écart. */
function targetsAround(g: Graph, corner: Pt, sigma: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const n of nodesNear(g, corner, sigma * 2)) {
    const d = Math.hypot(g.xy[n * 2] - corner[0], g.xy[n * 2 + 1] - corner[1]);
    out.set(n, d * (1 + (d / sigma) ** 2));
  }
  if (!out.size) {
    // Aucune rue juste à côté : on vise la plus proche dans un rayon plus large.
    const n = nearestNode(g, corner, sigma * 4);
    if (n >= 0) out.set(n, 0);
  }
  return out;
}

/**
 * Supprime les allers-retours parasites (petites impasses empruntées pour
 * atteindre un point du dessin), sans toucher aux retours voulus par le dessin.
 */
function removeSpurs(seq: number[], g: Graph, maxLen: number): number[] {
  const len = (a: number, b: number) => Math.hypot(g.xy[a * 2] - g.xy[b * 2], g.xy[a * 2 + 1] - g.xy[b * 2 + 1]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < seq.length - 1; i++) {
      if (seq[i - 1] !== seq[i + 1]) continue;
      // Étend l'aller-retour tant qu'il est symétrique.
      let k = 1, l = len(seq[i - 1], seq[i]);
      while (i - k - 1 >= 0 && i + k + 1 < seq.length && seq[i - k - 1] === seq[i + k + 1]) {
        l += len(seq[i - k - 1], seq[i - k]);
        k++;
      }
      if (l <= maxLen) {
        seq.splice(i - k + 1, 2 * k);
        changed = true;
        break;
      }
    }
  }
  // Doublons consécutifs.
  return seq.filter((n, i) => i === 0 || n !== seq[i - 1]);
}

export interface SnapResult {
  line: LngLat[];
  /** Part du dessin couverte par des rues (le reste est relié en ligne droite). */
  coverage: number;
}

/** Tuiles nécessaires pour couvrir le dessin, marge comprise. */
function tilesFor(design: LngLat[], marginM: number): [number, number][] | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of design) {
    const [x, y] = lngLatToGlobal(p);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  // Mètres → pixels globaux à cette latitude.
  const lat = design[0][1];
  const mPerPx = (40_075_016 * Math.cos((lat * Math.PI) / 180)) / WORLD;
  const m = marginM / mPerPx;
  const x0 = Math.floor((minX - m) / 4096), x1 = Math.floor((maxX + m) / 4096);
  const y0 = Math.floor((minY - m) / 4096), y1 = Math.floor((maxY + m) / 4096);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_TILES) return null;
  const out: [number, number][] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([x, y]);
  return out;
}

let cached: { key: string; graph: Graph } | null = null;

/** Précharge les rues autour du dessin (appelé pendant qu'on le déplace). */
export function prefetch(design: LngLat[], size: number) {
  const t = tilesFor(design, Math.max(200, size * 0.15));
  t?.forEach(([x, y]) => loadTile(x, y).catch(() => {}));
}

async function graphFor(design: LngLat[], margin: number): Promise<Graph> {
  const list = tilesFor(design, margin);
  if (!list) throw new Error('Dessin trop grand pour le caler sur les rues (12 km maximum).');
  const key = list.map((t) => t.join('/')).join(';');
  if (cached?.key !== key) {
    const raws = await Promise.all(list.map(([x, y]) => loadTile(x, y)));
    cached = { key, graph: buildGraph(raws, design[0]) };
  }
  return cached.graph;
}

const sigmaFor = (size: number) => Math.min(45, Math.max(12, size * 0.015));

export async function snapToStreets(design: LngLat[], size: number): Promise<SnapResult> {
  const g = await graphFor(design, Math.max(200, size * 0.15));

  // Tolérance d'écart : ~1,5 % de la taille, entre 12 et 45 m.
  const sigma = sigmaFor(size);
  const pts = design.map((p) => g.local.to(p));
  // Les tout petits zigzags du dessin (contours d'image) ne se courent pas.
  const corners = simplifyKeepEnds(pts, sigma * 0.5);

  const seq: number[] = [];
  const out: LngLat[] = [];
  let covered = 0, total = 0;
  let prevNode = nearestNode(g, corners[0], sigma * 4);

  const flushSeq = () => {
    for (const n of removeSpurs(seq.splice(0), g, Math.max(40, sigma * 2.5))) out.push(g.lngLat[n]);
  };

  for (let i = 1; i < corners.length; i++) {
    const a = corners[i - 1], b = corners[i];
    const legLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    total += legLen;
    const targets = targetsAround(g, b, sigma);
    const path = prevNode >= 0 && targets.size ? legRoute(g, prevNode, targets, a, b, sigma, 60_000) : null;
    if (path) {
      if (!seq.length) seq.push(path[0]);
      seq.push(...path.slice(1));
      covered += legLen;
      prevNode = path[path.length - 1];
    } else {
      // Pas de rue praticable ici (eau, parc fermé…) : on relie en ligne droite.
      flushSeq();
      if (!out.length) out.push(g.local.from(a));
      out.push(g.local.from(b));
      prevNode = nearestNode(g, b, sigma * 4);
    }
  }
  flushSeq();
  return { line: out, coverage: total ? covered / total : 0 };
}

function simplifyKeepEnds(pts: Pt[], tol: number): Pt[] {
  return pts.length > 2 ? simplify(pts, tol) : pts;
}

// ---------------------------------------------------------------- Alignement automatique

/**
 * Carte des distances à la rue la plus proche, sur une grille fine : chaque
 * position candidate du dessin s'évalue alors en simples lectures de cases.
 */
function distanceField(g: Graph, center: Pt, half: number, res: number) {
  const n = Math.ceil((2 * half) / res);
  const x0 = center[0] - half, y0 = center[1] - half;
  const field = new Float32Array(n * n).fill(1e9);
  // Les rues du réseau principal, tracées dans la grille.
  for (let a = 0; a < g.adj.length; a++) {
    if (!g.main[a]) continue;
    const ax = g.xy[a * 2], ay = g.xy[a * 2 + 1];
    for (const b of g.adj[a]) {
      if (b < a) continue;
      const bx = g.xy[b * 2], by = g.xy[b * 2 + 1];
      const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / (res / 2)) || 1;
      for (let k = 0; k <= steps; k++) {
        const i = Math.floor((ax + ((bx - ax) * k) / steps - x0) / res);
        const j = Math.floor((ay + ((by - ay) * k) / steps - y0) / res);
        if (i >= 0 && j >= 0 && i < n && j < n) field[j * n + i] = 0;
      }
    }
  }
  // Transformée de distance du chanfrein (3-4), en deux passes.
  const d1 = res, d2 = res * Math.SQRT2;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let v = field[j * n + i];
      if (i > 0) v = Math.min(v, field[j * n + i - 1] + d1);
      if (j > 0) {
        v = Math.min(v, field[(j - 1) * n + i] + d1);
        if (i > 0) v = Math.min(v, field[(j - 1) * n + i - 1] + d2);
        if (i < n - 1) v = Math.min(v, field[(j - 1) * n + i + 1] + d2);
      }
      field[j * n + i] = v;
    }
  }
  for (let j = n - 1; j >= 0; j--) {
    for (let i = n - 1; i >= 0; i--) {
      let v = field[j * n + i];
      if (i < n - 1) v = Math.min(v, field[j * n + i + 1] + d1);
      if (j < n - 1) {
        v = Math.min(v, field[(j + 1) * n + i] + d1);
        if (i < n - 1) v = Math.min(v, field[(j + 1) * n + i + 1] + d2);
        if (i > 0) v = Math.min(v, field[(j + 1) * n + i - 1] + d2);
      }
      field[j * n + i] = v;
    }
  }
  return (x: number, y: number) => {
    const i = Math.floor((x - x0) / res), j = Math.floor((y - y0) / res);
    return i >= 0 && j >= 0 && i < n && j < n ? field[j * n + i] : 1e9;
  };
}

interface Candidate { dx: number; dy: number; rot: number; scale: number; s: number }

/**
 * Cherche autour de la position actuelle le décalage, la rotation et l'échelle
 * qui posent les traits du dessin sur des rues. Renvoie les meilleures
 * positions trouvées, de la meilleure à la moins bonne.
 */
export async function alignCandidates(shape: Pt[], start: Placement, count = 4): Promise<Placement[]> {
  const reach = Math.min(start.size * 0.25, 600);
  const maxScale = 1.25;
  // La zone doit couvrir toutes les positions candidates.
  const zone = place(shape, { ...start, size: start.size * maxScale });
  const g = await graphFor(zone, reach + Math.max(300, start.size * 0.15));
  const sigma = sigmaFor(start.size);
  const cap = sigma * 2.5;
  const c0 = g.local.to(start.center);
  const half = start.size * maxScale * 0.75 + reach + 50;
  const res = Math.max(4, sigma / 3);
  const dist = distanceField(g, c0, half, res);

  const sample = (step: number) => {
    const out: Pt[] = [];
    for (let i = 1; i < shape.length; i++) {
      const [ax, ay] = shape[i - 1], [bx, by] = shape[i];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
      for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
    }
    return out;
  };
  const fine = sample(sigma / 2 / start.size);
  const coarse = sample(sigma * 1.5 / start.size);

  const score = (pts: Pt[], c: Omit<Candidate, 's'>) => {
    const r = ((start.rotation + c.rot) * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
    const size = start.size * c.scale;
    let sum = 0;
    for (const [ux, uy] of pts) {
      const ex = ux * size, ny = -uy * size;
      const d = Math.min(cap, dist(c0[0] + c.dx + ex * cos + ny * sin, c0[1] + c.dy - ex * sin + ny * cos));
      sum += d * d;
    }
    return sum / pts.length;
  };

  // 1. Balayage grossier : rotations, échelles et décalages.
  const coarseHits: Candidate[] = [];
  const grid = 8;
  for (let rot = -45; rot <= 45; rot += 5) {
    for (const scale of [0.85, 1, 1.15]) {
      for (let i = -grid; i <= grid; i++) {
        for (let j = -grid; j <= grid; j++) {
          const c = { dx: (i / grid) * reach, dy: (j / grid) * reach, rot, scale, s: 0 };
          c.s = score(coarse, c);
          coarseHits.push(c);
        }
      }
    }
  }
  coarseHits.sort((a, b) => a.s - b.s);

  // 2. Affinage local des meilleures pistes (en gardant des pistes bien distinctes).
  const seeds: Candidate[] = [];
  for (const c of coarseHits) {
    if (seeds.length >= count * 3) break;
    if (seeds.some((s) => Math.hypot(s.dx - c.dx, s.dy - c.dy) < sigma * 2 && Math.abs(s.rot - c.rot) < 6)) continue;
    seeds.push(c);
  }
  const refined = seeds.map((seed) => {
    let best = { ...seed, s: score(fine, seed) };
    let steps = { dx: sigma, dy: sigma, rot: 2.5, scale: 0.04 };
    for (let iter = 0; iter < 120 && steps.dx > 1; iter++) {
      let improved = false;
      for (const key of ['dx', 'dy', 'rot', 'scale'] as const) {
        for (const sgn of [-1, 1]) {
          const c = { ...best, [key]: best[key] + sgn * steps[key] };
          if (Math.hypot(c.dx, c.dy) > reach * 1.2 || Math.abs(c.rot) > 50 || c.scale < 0.8 || c.scale > maxScale) continue;
          c.s = score(fine, c);
          if (c.s < best.s) { best = c; improved = true; }
        }
      }
      if (!improved) steps = { dx: steps.dx / 2, dy: steps.dy / 2, rot: steps.rot / 2, scale: steps.scale / 2 };
    }
    return best;
  });
  refined.sort((a, b) => a.s - b.s);

  return refined.slice(0, count).map((c) => ({
    center: g.local.from([c0[0] + c.dx, c0[1] + c.dy]),
    size: start.size * c.scale,
    rotation: start.rotation + c.rot,
  }));
}

/** Qualité d'un tracé calé : écart moyen au dessin, pénalisé par les détours. */
export function routeQuality(design: LngLat[], route: LngLat[]): number {
  const local = new Local(design[0]);
  const d = design.map((p) => local.to(p));
  const r = route.map((p) => local.to(p));
  const len = (pts: Pt[]) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
  // Écart moyen du tracé au dessin, échantillonné régulièrement.
  let sum = 0, n = 0;
  for (let i = 1; i < r.length; i++) {
    const a = r[i - 1], b = r[i];
    const k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 10));
    for (let t = 0; t < k; t++) {
      const px = a[0] + ((b[0] - a[0]) * t) / k, py = a[1] + ((b[1] - a[1]) * t) / k;
      let m = Infinity;
      for (let j = 1; j < d.length; j++) m = Math.min(m, distToSegment(px, py, d[j - 1], d[j]));
      sum += m;
      n++;
    }
  }
  const size = Math.max(...d.map((p) => Math.hypot(p[0] - d[0][0], p[1] - d[0][1]))) || 1;
  const deviation = n ? sum / n / size : 1;
  const detour = len(r) / (len(d) || 1);
  return deviation * 100 + Math.max(0, detour - 1);
}

export interface Aligned {
  placement: Placement;
  route: LngLat[];
  /** Plus c'est bas, plus le tracé calé ressemble au dessin. */
  quality: number;
}

/**
 * Essaie la position actuelle et les meilleures positions voisines, cale
 * chacune sur les rues et garde celle dont le tracé ressemble le plus au dessin.
 */
export async function alignToStreets(shape: Pt[], start: Placement): Promise<Aligned> {
  const candidates = [start, ...(await alignCandidates(shape, start))];
  let best: Aligned | null = null;
  for (const placement of candidates) {
    const design = place(shape, placement);
    const { line } = await snapToStreets(design, placement.size);
    // Légère préférence pour un dessin peu tourné : il reste plus lisible.
    const quality = routeQuality(design, line) + (Math.abs(placement.rotation - start.rotation) / 45) * 0.5;
    if (!best || quality < best.quality) best = { placement, route: line, quality };
  }
  return best!;
}
