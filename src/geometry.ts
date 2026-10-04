export type Pt = [number, number];
export type LngLat = [number, number];

/** Où et comment la forme est posée sur la carte. */
export interface Placement {
  center: LngLat;
  /** Plus grande dimension de la forme, en mètres. */
  size: number;
  /** Rotation en degrés, sens horaire. */
  rotation: number;
}

const M_PER_DEG = 111_320;

/** Recentre la forme sur l'origine et ramène sa plus grande dimension à 1. */
export function normalize(path: Pt[]): Pt[] {
  if (path.length === 0) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of path) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return path.map(([x, y]) => [(x - cx) / span, (y - cy) / span]);
}

/** Demi-dimensions de la forme normalisée (pour placer la poignée). */
export function extent(path: Pt[]): Pt {
  let hx = 0, hy = 0;
  for (const [x, y] of path) { hx = Math.max(hx, Math.abs(x)); hy = Math.max(hy, Math.abs(y)); }
  return [hx, hy];
}

/** Ramer–Douglas–Peucker. */
export function simplify(path: Pt[], tolerance: number): Pt[] {
  if (path.length < 3) return path;
  const keep = new Uint8Array(path.length);
  keep[0] = keep[path.length - 1] = 1;
  const stack: [number, number][] = [[0, path.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(path[i], path[a], path[b]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolerance && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return path.filter((_, i) => keep[i]);
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Point local (unité, y vers le bas) → coordonnées géographiques. */
export function toLngLat([x, y]: Pt, { center, size, rotation }: Placement): LngLat {
  const r = (rotation * Math.PI) / 180;
  const ex = x * size, ny = -y * size;
  const dx = ex * Math.cos(r) + ny * Math.sin(r);
  const dy = -ex * Math.sin(r) + ny * Math.cos(r);
  const lat = center[1] + dy / M_PER_DEG;
  const lng = center[0] + dx / (M_PER_DEG * Math.cos((center[1] * Math.PI) / 180));
  return [lng, lat];
}

/** Décalage en mètres (est, nord) entre deux points proches. */
export function offsetMeters(from: LngLat, to: LngLat): Pt {
  const cos = Math.cos((from[1] * Math.PI) / 180);
  return [(to[0] - from[0]) * M_PER_DEG * cos, (to[1] - from[1]) * M_PER_DEG];
}

export function place(path: Pt[], placement: Placement): LngLat[] {
  return path.map((p) => toLngLat(p, placement));
}

export function haversine(a: LngLat, b: LngLat): number {
  const R = 6_371_000;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad, dLng = (b[0] - a[0]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function lengthOf(line: LngLat[]): number {
  let d = 0;
  for (let i = 1; i < line.length; i++) d += haversine(line[i - 1], line[i]);
  return d;
}

/** Ajoute des points pour qu'aucun segment ne dépasse `step` mètres. */
export function densify(line: LngLat[], step: number): LngLat[] {
  if (line.length < 2) return line;
  const out: LngLat[] = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const n = Math.max(1, Math.ceil(haversine(a, b) / step));
    for (let k = 1; k <= n; k++) {
      out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
  }
  return out;
}

export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 2 : 1).replace('.', ',')} km`;
}
