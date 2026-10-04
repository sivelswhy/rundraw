import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, MapLayerMouseEvent, MapLayerTouchEvent } from 'maplibre-gl';
import type * as GeoJSON from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
// Le worker de MapLibre est empaqueté par Vite (avec ses imports) : sans ça,
// son URL calculée à l'exécution ne pointe vers rien et la carte reste noire.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { animate, type AnimationPlaybackControls } from 'motion';
import './style.css';
import { normalizeText, supportedChar, textToPath } from './font';
import {
  extent, formatDistance, haversine, lengthOf, normalize, offsetMeters,
  place, simplify, toLngLat,
  type LngLat, type Placement, type Pt,
} from './geometry';
import { downloadGpx, routeToGpx, slug } from './gpx';
import { alignToStreets, prefetch, snapToStreets } from './roads';
import { Sheet } from './sheet';
import { loadImage, otsu, traceImage } from './trace';

maplibregl.setWorkerUrl(workerUrl);

type Step = 'draw' | 'place';
type Source = 'text' | 'image' | 'hand';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll(sel)] as T[];

const STORAGE_KEY = 'rundraw:v1';
const MIN_SIZE = 80;
const MAX_SIZE = 12_000;

// ---------------------------------------------------------------- État

const state = {
  step: 'draw' as Step,
  source: 'text' as Source,
  text: 'RUN',
  /** Tracé brut par source, avant normalisation. */
  raw: { text: [] as Pt[], image: [] as Pt[], hand: [] as Pt[] },
  /** Forme normalisée posée sur la carte. */
  shape: null as Pt[] | null,
  placement: null as Placement | null,
  /** Tracé calé sur les rues (null = tracé libre). */
  route: null as LngLat[] | null,
  /** Caler automatiquement le dessin sur les rues. */
  snap: true,
};

const saved = readSaved();
if (saved) Object.assign(state, saved, { step: 'draw' });

function readSaved(): Partial<typeof state> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      const { step: _step, ...rest } = state;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
    } catch {
      /* stockage indisponible : l'app fonctionne quand même */
    }
  }, 300);
}

// ---------------------------------------------------------------- Toast et retour haptique

let toastTimer = 0;
function toast(message: string, ms = 2600) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), ms);
}

const haptic = (pattern: number | number[]) => navigator.vibrate?.(pattern);

// ---------------------------------------------------------------- Carte

const darkScheme = matchMedia('(prefers-color-scheme: dark)');
const styleUrl = () => `https://tiles.openfreemap.org/styles/${darkScheme.matches ? 'dark' : 'positron'}`;

const map = new maplibregl.Map({
  container: 'map',
  style: styleUrl(),
  center: state.placement?.center ?? [2.3488, 48.8534],
  zoom: state.placement ? 14 : 13,
  attributionControl: { compact: true },
  pitchWithRotate: false,
  dragRotate: false,
});
map.touchZoomRotate.disableRotation();
if (import.meta.env.DEV) Object.assign(window, { map });
darkScheme.addEventListener('change', () => map.setStyle(styleUrl()));

// Vrai dès que nos couches existent (isStyleLoaded() redevient faux à chaque chargement de tuiles).
let mapReady = false;
map.on('styledata', () => { if (!map.getLayer('design')) mapReady = false; });

const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const line = (coords: LngLat[]): GeoJSON.Feature => ({
  type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords },
});
const point = (c: LngLat): GeoJSON.Feature => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } });

function setData(id: string, data: GeoJSON.Feature | GeoJSON.FeatureCollection) {
  (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);
}

map.on('style.load', () => {
  for (const id of ['design', 'route', 'start']) map.addSource(id, { type: 'geojson', data: empty });
  const round = { 'line-join': 'round', 'line-cap': 'round' } as const;
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: round, paint: { 'line-color': '#fff', 'line-width': 9, 'line-opacity': 0.85 } });
  map.addLayer({ id: 'design', type: 'line', source: 'design', layout: round, paint: { 'line-color': '#ff5a1f', 'line-width': 5 } });
  map.addLayer({ id: 'route', type: 'line', source: 'route', layout: round, paint: { 'line-color': '#ff5a1f', 'line-width': 5 } });
  map.addLayer({ id: 'start', type: 'circle', source: 'start', paint: { 'circle-radius': 7, 'circle-color': '#fff', 'circle-stroke-color': '#ff5a1f', 'circle-stroke-width': 4 } });
  // Zone de saisie large et invisible : attraper le dessin sans viser au pixel près.
  mapReady = true;
  map.addLayer({ id: 'design-hit', type: 'line', source: 'design', layout: round, paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 30 } });
  renderMap();
});

/** Marges pour cadrer la carte sans que la feuille ne masque le dessin. */
function viewPadding() {
  if (matchMedia('(min-width: 760px)').matches) return { top: 90, bottom: 50, left: 24 + sheetEl.offsetWidth + 40, right: 50 };
  // On cadre selon le cran visé par la feuille, pas sa position en plein ressort.
  const visible = sheet.isExpanded ? sheetEl.offsetHeight : 132;
  return { top: 90, bottom: Math.min(visible, innerHeight * 0.6) + 24, left: 36, right: 36 };
}

function fitTo(coords: LngLat[], animated = true) {
  if (coords.length < 2) return;
  const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  // MapLibre garde la marge du dernier déplacement et l'ajouterait à celle-ci.
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  map.fitBounds(bounds, { padding: viewPadding(), maxZoom: 17, duration: animated ? 700 : 0 });
}

/** Largeur visible de la carte, en mètres. */
function viewportMeters() {
  const c = map.getCanvas();
  const pad = viewPadding();
  const y = (pad.top + c.clientHeight - pad.bottom) / 2;
  const a = map.unproject([pad.left, y]).toArray() as LngLat;
  const b = map.unproject([c.clientWidth - pad.right, y]).toArray() as LngLat;
  const h = haversine(map.unproject([0, pad.top]).toArray() as LngLat, map.unproject([0, c.clientHeight - pad.bottom]).toArray() as LngLat);
  return { width: haversine(a, b), height: h, center: map.unproject([(pad.left + c.clientWidth - pad.right) / 2, y]).toArray() as LngLat };
}

// ---------------------------------------------------------------- Feuille et étapes

const sheetEl = $('#sheet');
const sheet = new Sheet(sheetEl, $('#sheet-head'));

function setStep(step: Step) {
  state.step = step;
  for (const tab of $$('.steps button')) tab.setAttribute('aria-selected', String(tab.dataset.step === step));
  for (const panel of $$('[data-panel]')) panel.hidden = panel.dataset.panel !== step;
  ($('.steps [data-step="place"]') as HTMLButtonElement).disabled = !state.shape;
  sheet.expand(true);
  renderMap();
  if (step === 'place' && !state.route && !aligning) scheduleSnap(0);
}

for (const tab of $$<HTMLButtonElement>('.steps button')) {
  tab.addEventListener('click', () => {
    if (tab.disabled || tab.dataset.step === state.step) return;
    setStep(tab.dataset.step as Step);
  });
}

// ---------------------------------------------------------------- Étape 1 : la forme

const previewPath = $('#preview-path') as unknown as SVGPathElement;
const previewStart = $('#preview-start') as unknown as SVGCircleElement;
const placeBtn = $<HTMLButtonElement>('#place-btn');

function currentRaw(): Pt[] {
  return state.raw[state.source];
}

function renderPreview() {
  const shape = normalize(currentRaw());
  $('#preview').hidden = state.source === 'hand';
  placeBtn.disabled = shape.length < 2;
  if (shape.length < 2) {
    previewPath.setAttribute('d', '');
    previewStart.setAttribute('r', '0');
    return;
  }
  previewPath.setAttribute('d', 'M' + shape.map(([x, y]) => `${x.toFixed(4)} ${y.toFixed(4)}`).join('L'));
  previewStart.setAttribute('cx', String(shape[0][0]));
  previewStart.setAttribute('cy', String(shape[0][1]));
  previewStart.setAttribute('r', '0.025');
}

function setSource(source: Source) {
  state.source = source;
  for (const b of $$('#source-tabs button')) b.setAttribute('aria-checked', String(b.dataset.source === source));
  for (const p of $$('[data-source-panel]')) p.hidden = p.dataset.sourcePanel !== source;
  if (source === 'hand') sizePad();
  renderPreview();
  sheet.settle();
  save();
}
for (const b of $$('#source-tabs button')) b.addEventListener('click', () => setSource(b.dataset.source as Source));

// Texte
const textInput = $<HTMLInputElement>('#text-input');
textInput.value = state.text;
function updateText() {
  state.text = textInput.value;
  state.raw.text = textToPath(state.text);
  const ignored = [...new Set([...normalizeText(state.text)].filter((c) => !supportedChar(c)))];
  const hint = $('#text-hint');
  hint.classList.toggle('warn', ignored.length > 0);
  hint.textContent = ignored.length
    ? `Ignoré : ${ignored.join(' ')}. Lettres, chiffres, ! - + . et ♥ seulement.`
    : 'Lettres, chiffres, ! - + . et ♥ (tape <3).';
  renderPreview();
  save();
}
textInput.addEventListener('input', updateText);
textInput.addEventListener('keydown', (e) => e.key === 'Enter' && !placeBtn.disabled && placeOnMap());

// Image
let image: ImageData | null = null;
const threshold = $<HTMLInputElement>('#threshold');
const invert = $<HTMLInputElement>('#invert');
const drop = $('#drop');

async function useImage(file: File | undefined) {
  if (!file || !file.type.startsWith('image/')) return;
  try {
    image = await loadImage(file);
  } catch {
    toast("Impossible de lire cette image.");
    return;
  }
  threshold.value = String(otsu(image));
  invert.checked = false;
  $('#drop-label').textContent = file.name;
  $('#image-controls').hidden = false;
  retrace();
  sheet.settle();
}

let retraceFrame = 0;
function retrace() {
  cancelAnimationFrame(retraceFrame);
  retraceFrame = requestAnimationFrame(() => {
    if (!image) return;
    state.raw.image = traceImage(image, { threshold: +threshold.value, invert: invert.checked });
    if (state.raw.image.length < 3) toast('Aucune forme nette : ajuste le seuil ou inverse.');
    renderPreview();
    save();
  });
}
$<HTMLInputElement>('#image-input').addEventListener('change', (e) => useImage((e.target as HTMLInputElement).files?.[0]));
threshold.addEventListener('input', retrace);
invert.addEventListener('change', retrace);
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  useImage(e.dataTransfer?.files[0]);
});
if (state.raw.image.length) $('#drop-label').textContent = 'Image précédente conservée. Choisis-en une autre ?';

// Main levée
const pad = $<HTMLCanvasElement>('#pad');
const padCtx = pad.getContext('2d')!;
let strokes: Pt[][] = [];

function sizePad() {
  const dpr = devicePixelRatio || 1;
  const w = pad.clientWidth, h = pad.clientHeight;
  if (!w) return;
  pad.width = w * dpr;
  pad.height = h * dpr;
  padCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Retrouver le dessin précédent : on le recadre dans la zone.
  if (!strokes.length && state.raw.hand.length) {
    const n = normalize(state.raw.hand), s = Math.min(w, h) * 0.8;
    strokes = [n.map(([x, y]) => [w / 2 + x * s, h / 2 + y * s] as Pt)];
  }
  drawPad();
}

function drawPad() {
  const w = pad.clientWidth, h = pad.clientHeight;
  padCtx.clearRect(0, 0, w, h);
  padCtx.lineJoin = padCtx.lineCap = 'round';
  // Liaisons entre traits : ce que la course ajoutera.
  padCtx.setLineDash([4, 6]);
  padCtx.lineWidth = 2;
  padCtx.strokeStyle = 'rgba(255, 90, 31, 0.5)';
  padCtx.beginPath();
  for (let i = 1; i < strokes.length; i++) {
    const a = strokes[i - 1].at(-1)!, b = strokes[i][0];
    padCtx.moveTo(a[0], a[1]);
    padCtx.lineTo(b[0], b[1]);
  }
  padCtx.stroke();
  padCtx.setLineDash([]);
  padCtx.lineWidth = 4;
  padCtx.strokeStyle = '#ff5a1f';
  for (const s of strokes) {
    padCtx.beginPath();
    padCtx.moveTo(s[0][0], s[0][1]);
    if (s.length === 1) padCtx.lineTo(s[0][0] + 0.1, s[0][1]);
    for (const [x, y] of s) padCtx.lineTo(x, y);
    padCtx.stroke();
  }
}

let drawing = false;
pad.addEventListener('pointerdown', (e) => {
  pad.setPointerCapture(e.pointerId);
  drawing = true;
  // Le point apparaît dès l'appui.
  strokes.push([[e.offsetX, e.offsetY]]);
  drawPad();
});
pad.addEventListener('pointermove', (e) => {
  if (!drawing) return;
  const s = strokes.at(-1)!;
  for (const ev of e.getCoalescedEvents?.() ?? [e]) s.push([ev.offsetX, ev.offsetY]);
  drawPad();
});
const endStroke = () => {
  if (!drawing) return;
  drawing = false;
  state.raw.hand = simplify(strokes.flat(), 1.2);
  renderPreview();
  save();
};
pad.addEventListener('pointerup', endStroke);
pad.addEventListener('pointercancel', endStroke);
$('#pad-clear').addEventListener('click', () => {
  strokes = [];
  state.raw.hand = [];
  drawPad();
  renderPreview();
  save();
});
new ResizeObserver(() => state.source === 'hand' && sizePad()).observe(pad);

placeBtn.addEventListener('click', placeOnMap);

function placeOnMap() {
  const shape = normalize(currentRaw());
  if (shape.length < 2) return;
  state.shape = shape;
  state.route = null;
  const firstTime = !state.placement;
  setStep('place');
  if (firstTime) {
    const view = viewportMeters();
    const [hx, hy] = extent(shape);
    // La forme occupe ~70 % de la zone visible…
    const fit = Math.min((view.width * 0.7) / (2 * hx || 1), (view.height * 0.7) / (2 * hy || 1));
    // …mais jamais en dessous d'une taille où ses traits couvrent plusieurs pâtés
    // de maisons : en dessous, aucun calage sur les rues ne reste lisible.
    const letters = state.source === 'text' ? [...normalizeText(state.text)].filter((c) => c !== ' ' && supportedChar(c)).length : 0;
    const minimum = letters ? Math.max(1500, letters * 620) : 1500;
    state.placement = { center: view.center, size: clampSize(Math.max(fit, minimum)), rotation: 0 };
  }
  renderMap();
  // Sur téléphone, on replie la feuille : le dessin passe au premier plan.
  if (!matchMedia('(min-width: 760px)').matches) sheet.expand(false);
  fitTo(place(state.shape, state.placement!));
  if (state.snap) autoAlign(false);
  save();
}

// ---------------------------------------------------------------- Étape 2 : placer

const sizeInput = $<HTMLInputElement>('#size');
const rotationInput = $<HTMLInputElement>('#rotation');
const snapToggle = $<HTMLInputElement>('#snap-toggle');
const snapHint = $('#snap-hint');
snapToggle.checked = state.snap;

const clampSize = (s: number) => Math.min(MAX_SIZE, Math.max(MIN_SIZE, s));
// Échelle logarithmique : autant de précision à 200 m qu'à 5 km.
const sizeToSlider = (s: number) => (Math.log(s / MIN_SIZE) / Math.log(MAX_SIZE / MIN_SIZE)) * 1000;
const sliderToSize = (v: number) => MIN_SIZE * (MAX_SIZE / MIN_SIZE) ** (v / 1000);

const handleEl = document.createElement('div');
handleEl.className = 'handle';
handleEl.setAttribute('aria-label', 'Agrandir et tourner');
const handle = new maplibregl.Marker({ element: handleEl, draggable: true });
let handleDragging = false;
let handleShown = false;

function designLine(): LngLat[] {
  return state.shape && state.placement ? place(state.shape, state.placement) : [];
}

function cornerLngLat(): LngLat {
  const [hx, hy] = extent(state.shape!);
  return toLngLat([hx, -hy], state.placement!);
}

function renderMap() {
  renderStats();
  if (!mapReady) return;
  const design = designLine();
  const showDesign = state.step !== 'draw' && design.length > 1;
  setData('design', showDesign ? line(design) : empty);
  setData('route', showDesign && state.route ? line(state.route) : empty);
  const start = state.route?.[0] ?? design[0];
  setData('start', showDesign && start ? point(start) : empty);

  // Calé sur les rues : le dessin d'origine devient un simple guide en pointillés.
  map.setPaintProperty('design', 'line-width', state.route ? 2.5 : 5);
  map.setPaintProperty('design', 'line-opacity', state.route ? 0.55 : 1);
  map.setPaintProperty('design', 'line-dasharray', state.route ? [2, 2] : [1, 0]);

  if (state.step === 'place' && showDesign) {
    if (!handleDragging) handle.setLngLat(cornerLngLat());
    if (!handleShown) handle.addTo(map);
    handleShown = true;
  } else if (handleShown) {
    handle.remove();
    handleShown = false;
  }
}

function renderStats() {
  const p = state.placement;
  if (!p) return;
  const design = lengthOf(designLine());
  $('#stat-design').textContent = formatDistance(design);
  $('#stat-route').textContent = formatDistance(state.route ? lengthOf(state.route) : design);
  sizeInput.value = String(sizeToSlider(p.size));
  $('#size-out').textContent = formatDistance(p.size);
  rotationInput.value = String(Math.round(p.rotation));
  $('#rotation-out').textContent = `${Math.round(p.rotation)}°`;
  renderSnapHint();
}

let snapError = '';
function renderSnapHint() {
  let text: string, warn = false;
  if (!state.snap) text = 'Tracé libre : lignes droites, idéal sur une plage, un stade ou dans un parc.';
  else if (snapError) { text = snapError; warn = true; }
  else if (aligning) text = 'Recherche de la position où le dessin sera le plus net…';
  else if (!state.route) text = 'Calage sur les rues…';
  else {
    const ratio = lengthOf(state.route) / lengthOf(designLine());
    warn = ratio > 1.8;
    text = warn
      ? 'Beaucoup de détours pour suivre le dessin : agrandis-le, tourne-le ou déplace-le pour l’aligner sur les rues.'
      : 'Calé sur les rues et chemins. Le pointillé montre le dessin d’origine.';
  }
  snapHint.textContent = text;
  snapHint.classList.toggle('warn', warn);
  alignBtn.hidden = !state.snap;
}

/**
 * Toute modification du placement rend le calage obsolète. Pendant le geste on
 * montre le dessin seul ; dès qu'il s'arrête, le calage repart tout seul.
 */
function placementChanged() {
  alignAnim?.stop();
  alignAnim = null;
  state.route = null;
  snapError = '';
  renderMap();
  scheduleSnap();
  save();
}

sizeInput.addEventListener('input', () => {
  state.placement!.size = sliderToSize(+sizeInput.value);
  placementChanged();
});
rotationInput.addEventListener('input', () => {
  state.placement!.rotation = +rotationInput.value;
  placementChanged();
});

// Déplacer le dessin en l'attrapant directement, au point saisi.
let grab: Pt | null = null;
function startGrab(e: MapLayerMouseEvent | MapLayerTouchEvent) {
  if (state.step !== 'place' || !state.placement) return;
  if ('points' in e && e.points.length !== 1) return;
  e.preventDefault();
  grab = offsetMeters(e.lngLat.toArray() as LngLat, state.placement.center);
  map.getCanvas().style.cursor = 'grabbing';
}
function moveGrab(e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) {
  if (!grab || !state.placement) return;
  const [lng, lat] = e.lngLat.toArray();
  const cos = Math.cos((lat * Math.PI) / 180);
  state.placement.center = [lng + grab[0] / (111_320 * cos), lat + grab[1] / 111_320];
  placementChanged();
}
function endGrab() {
  if (!grab) return;
  grab = null;
  map.getCanvas().style.cursor = '';
}
map.on('mousedown', 'design-hit', startGrab);
map.on('touchstart', 'design-hit', startGrab);
map.on('mousemove', moveGrab);
map.on('touchmove', moveGrab);
map.on('mouseup', endGrab);
map.on('touchend', endGrab);
map.on('touchcancel', endGrab);
map.on('mouseenter', 'design-hit', () => state.step === 'place' && !grab && (map.getCanvas().style.cursor = 'grab'));
map.on('mouseleave', 'design-hit', () => !grab && (map.getCanvas().style.cursor = ''));

// Poignée : la distance au centre règle la taille, l'angle règle la rotation.
let handleStart: { v: Pt; size: number; rotation: number; snapped: boolean } | null = null;
const deg = ([x, y]: Pt) => (Math.atan2(y, x) * 180) / Math.PI;
handle.on('dragstart', () => {
  handleDragging = true;
  const p = state.placement!;
  handleStart = { v: offsetMeters(p.center, handle.getLngLat().toArray() as LngLat), size: p.size, rotation: p.rotation, snapped: false };
});
handle.on('drag', () => {
  if (!handleStart) return;
  const p = state.placement!;
  const v = offsetMeters(p.center, handle.getLngLat().toArray() as LngLat);
  p.size = clampSize(handleStart.size * (Math.hypot(...v) / (Math.hypot(...handleStart.v) || 1)));
  let rot = handleStart.rotation - (deg(v) - deg(handleStart.v));
  rot = ((((rot + 180) % 360) + 360) % 360) - 180;
  // Aimantation sur les angles droits, signalée par une petite vibration.
  const nearest = Math.round(rot / 90) * 90;
  const snap = Math.abs(rot - nearest) < 4;
  if (snap && !handleStart.snapped) haptic(8);
  handleStart.snapped = snap;
  p.rotation = snap ? (nearest === -180 ? 180 : nearest) : rot;
  placementChanged();
});
handle.on('dragend', () => {
  handleStart = null;
  // La poignée rejoint en ressort le coin réel (taille bornée, angle aimanté).
  const from = handle.getLngLat().toArray() as LngLat;
  const to = cornerLngLat();
  animate(0, 1, {
    type: 'spring', bounce: 0, visualDuration: 0.3,
    onUpdate: (t) => handle.setLngLat([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]),
    onComplete: () => { handleDragging = false; },
  });
});

// Calage sur les rues
let snapTimer = 0;
let snapSeq = 0;
let lastPrefetch = 0;

function scheduleSnap(delay = 220) {
  clearTimeout(snapTimer);
  snapSeq++;
  if (!state.snap || state.step !== 'place') return;
  const design = designLine();
  if (design.length < 2) return;
  // Pendant le geste, on télécharge déjà les rues de la zone.
  if (performance.now() - lastPrefetch > 300) {
    lastPrefetch = performance.now();
    prefetch(design, state.placement!.size);
  }
  snapTimer = window.setTimeout(() => runSnap(snapSeq), delay);
}

async function runSnap(seq: number) {
  const design = designLine();
  try {
    const { line: route } = await snapToStreets(design, state.placement!.size);
    if (seq !== snapSeq) return;
    state.route = route;
    snapError = '';
    save();
  } catch (e) {
    if (seq !== snapSeq) return;
    snapError = (e as Error).message.includes('trop grand')
      ? (e as Error).message
      : 'Impossible de charger les rues pour le moment. Vérifie ta connexion.';
  }
  renderMap();
}

// Alignement : on cherche tout près la position où les traits tombent sur des rues,
// puis le dessin y glisse en ressort. Le reprendre en main interrompt le mouvement.
const alignBtn = $<HTMLButtonElement>('#align-btn');
let alignAnim: AnimationPlaybackControls | null = null;
let aligning = false;

/**
 * Déplace, tourne et redimensionne un peu le dessin pour que ses traits
 * tombent sur des rues, puis l'y fait glisser en ressort.
 */
async function autoAlign(fromButton: boolean) {
  if (!state.shape || !state.placement || aligning) return;
  aligning = true;
  clearTimeout(snapTimer);
  const seq = ++snapSeq;
  alignBtn.disabled = true;
  alignBtn.textContent = 'Recherche de la position la plus nette…';
  renderSnapHint();
  const from = { ...state.placement };
  try {
    const { placement: to, route } = await alignToStreets(state.shape, from);
    // Le dessin a été repris en main entre-temps : on n'y touche plus.
    if (seq !== snapSeq) return;
    const unchanged = haversine(from.center, to.center) < 2 && Math.abs(to.rotation - from.rotation) < 0.5 && Math.abs(to.size / from.size - 1) < 0.01;
    if (unchanged) {
      state.route = route;
      if (fromButton) toast('Le dessin est déjà à sa position la plus nette ici.');
      renderMap();
      save();
      return;
    }
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const anim = animate(0, 1, {
      type: 'spring', bounce: 0, visualDuration: 0.55,
      onUpdate: (t) => {
        state.placement = {
          center: [lerp(from.center[0], to.center[0], t), lerp(from.center[1], to.center[1], t)],
          size: lerp(from.size, to.size, t),
          rotation: lerp(from.rotation, to.rotation, t),
        };
        renderMap();
      },
      onComplete: () => {
        if (alignAnim !== anim) return;
        alignAnim = null;
        haptic(10);
        state.placement = to;
        state.route = route;
        renderMap();
        fitTo(route);
        save();
      },
    });
    alignAnim = anim;
  } catch (e) {
    if (seq !== snapSeq) return;
    snapError = (e as Error).message.includes('trop grand')
      ? (e as Error).message
      : 'Impossible de charger les rues pour le moment. Vérifie ta connexion.';
    renderMap();
  } finally {
    aligning = false;
    alignBtn.disabled = false;
    alignBtn.textContent = 'Aligner sur les rues';
    renderSnapHint();
  }
}
alignBtn.addEventListener('click', () => autoAlign(true));

snapToggle.addEventListener('change', () => {
  state.snap = snapToggle.checked;
  state.route = null;
  snapError = '';
  renderMap();
  scheduleSnap(0);
  save();
});

const gpxName = () => (state.source === 'text' && state.text.trim() ? state.text.trim() : 'Dessin RunDraw');
$('#export-btn').addEventListener('click', () => {
  const coords = state.route ?? designLine();
  if (coords.length < 2) return;
  downloadGpx(`${slug(gpxName())}.gpx`, routeToGpx(gpxName(), coords));
});

// ---------------------------------------------------------------- Position

let me: maplibregl.Marker | null = null;
function showMe(p: LngLat) {
  if (!me) {
    const el = document.createElement('div');
    el.className = 'me';
    me = new maplibregl.Marker({ element: el });
  }
  me.setLngLat(p).addTo(map);
}

// ---------------------------------------------------------------- Recherche et localisation

$('#search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('#search-input');
  const q = input.value.trim();
  if (!q) return;
  input.blur();
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=fr&q=${encodeURIComponent(q)}`);
    const [hit] = await res.json();
    if (!hit) return toast(`Aucun lieu trouvé pour « ${q} ».`);
    goTo([+hit.lon, +hit.lat]);
  } catch {
    toast('Recherche indisponible pour le moment.');
  }
});

/** Va à un lieu ; à l'étape Parcours, le dessin suit. */
function goTo(c: LngLat) {
  if (state.step === 'place' && state.placement) {
    state.placement.center = c;
    placementChanged();
    fitTo(designLine());
  } else {
    map.flyTo({ center: c, zoom: Math.max(map.getZoom(), 14), padding: viewPadding(), duration: 900 });
  }
}

$('#locate').addEventListener('click', () => {
  navigator.geolocation?.getCurrentPosition(
    (pos) => {
      const p: LngLat = [pos.coords.longitude, pos.coords.latitude];
      showMe(p);
      goTo(p);
    },
    () => toast('Localisation refusée ou indisponible.'),
    { enableHighAccuracy: true, timeout: 10_000 },
  );
});

// ---------------------------------------------------------------- Démarrage

if (!state.raw.text.length) state.raw.text = textToPath(state.text);
updateText();
setSource(state.source);
setStep('draw');
if (state.shape && state.placement) {
  // On reprend là où on s'était arrêté.
  map.once('load', () => {
    setStep('place');
    fitTo(state.route ?? designLine(), false);
  });
}
