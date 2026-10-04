import { simplify, type Pt } from './geometry';

const MAX_SIDE = 240;

export interface TraceOptions {
  /** 0–255 : les pixels plus sombres que ce seuil forment la silhouette. */
  threshold: number;
  invert: boolean;
}

export async function loadImage(file: File): Promise<ImageData> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  // Fond blanc : un PNG transparent se lit comme « clair ».
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** Seuil d'Otsu : bonne valeur de départ pour séparer le motif du fond. */
export function otsu(img: ImageData): number {
  const hist = new Array(256).fill(0);
  const { data } = img;
  for (let i = 0; i < data.length; i += 4) hist[luma(data, i)]++;
  const total = img.width * img.height;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

function luma(d: Uint8ClampedArray, i: number): number {
  return Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
}

/**
 * Contour extérieur de la plus grande silhouette de l'image,
 * en coordonnées pixels, simplifié et fermé.
 */
export function traceImage(img: ImageData, { threshold, invert }: TraceOptions): Pt[] {
  const { width: w, height: h, data } = img;
  // Bordure de 1 px pour que le suivi de contour ne sorte jamais de la grille.
  const W = w + 2, H = h + 2;
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dark = luma(data, (y * w + x) * 4) < threshold;
      mask[(y + 1) * W + x + 1] = dark !== invert ? 1 : 0;
    }
  }

  const start = largestComponentStart(mask, W);
  if (start < 0) return [];
  const contour = mooreTrace(mask, W, start);
  if (contour.length < 3) return [];
  const simple = simplify(contour, 1.2);
  simple.push(simple[0]);
  return simple;
}

/** Repère la plus grande composante connexe et ne garde qu'elle dans le masque. */
function largestComponentStart(mask: Uint8Array, W: number): number {
  const label = new Int32Array(mask.length);
  const stack: number[] = [];
  let bestSize = 0, bestLabel = 0, bestStart = -1, next = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || label[i]) continue;
    next++;
    let size = 0;
    label[i] = next;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (q >= 0 && q < mask.length && mask[q] && !label[q]) {
          label[q] = next;
          stack.push(q);
        }
      }
    }
    // Parcours ligne par ligne : `i` est le pixel le plus haut puis le plus à gauche.
    if (size > bestSize) { bestSize = size; bestLabel = next; bestStart = i; }
  }
  if (bestSize < 12) return -1;
  for (let i = 0; i < mask.length; i++) mask[i] = label[i] === bestLabel ? 1 : 0;
  return bestStart;
}

// Voisins de Moore dans le sens horaire, en commençant à l'ouest.
const DX = [-1, -1, 0, 1, 1, 1, 0, -1];
const DY = [0, -1, -1, -1, 0, 1, 1, 1];

function mooreTrace(mask: Uint8Array, W: number, start: number): Pt[] {
  const sx = start % W, sy = Math.floor(start / W);
  const out: Pt[] = [[sx, sy]];
  let x = sx, y = sy;
  // On arrive sur le pixel de départ depuis l'ouest (il est vide par construction).
  let dir = 0;
  const limit = mask.length * 4;
  for (let step = 0; step < limit; step++) {
    let found = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + k) % 8;
      const nx = x + DX[d], ny = y + DY[d];
      if (mask[ny * W + nx]) {
        x = nx; y = ny;
        // Reprendre la recherche à partir du voisin qui précède, côté vide.
        dir = (d + 6) % 8;
        found = true;
        break;
      }
    }
    if (!found) break;
    if (x === sx && y === sy) break;
    out.push([x, y]);
  }
  return out;
}
