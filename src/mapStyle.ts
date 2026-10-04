import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl';

// Style de carte inspiré d'Apple Plans (mode clair), sur les données
// OpenStreetMap servies par OpenFreeMap (schéma OpenMapTiles).

const C = {
  land: '#f6f4ef',
  urban: '#f1efe9',
  park: '#cfe8bc',
  wood: '#bfdea9',
  grass: '#d6ecc6',
  sand: '#f5ebc9',
  water: '#a3cef4',
  waterLabel: '#3f7fc4',
  hospital: '#f8e0e2',
  education: '#f6eed6',
  industrial: '#ebe8ee',
  cemetery: '#dcebd2',
  aeroway: '#e6e4ed',
  building: '#e8e5df',
  buildingEdge: '#dbd7d0',
  road: '#ffffff',
  roadCase: '#dad5cc',
  primary: '#fde69c',
  primaryCase: '#ebc566',
  motorway: '#fcc95a',
  motorwayCase: '#e3a63a',
  path: '#ffffff',
  rail: '#c8c4bd',
  boundary: '#c3bdd3',
  label: '#3c3c3c',
  labelSoft: '#777470',
  roadLabel: '#6b6862',
  halo: '#ffffff',
  parkLabel: '#4f8a3a',
};

const FONT = ['Noto Sans Regular'];
const FONT_BOLD = ['Noto Sans Bold'];
const FONT_ITALIC = ['Noto Sans Italic'];

const zoomWidth = (stops: [number, number][]): ExpressionSpecification =>
  ['interpolate', ['exponential', 1.6], ['zoom'], ...stops.flat()] as ExpressionSpecification;

const classIs = (...classes: string[]): ExpressionSpecification => ['match', ['get', 'class'], classes, true, false];
const notTunnel: ExpressionSpecification = ['!=', ['get', 'brunnel'], 'tunnel'];
const isTunnel: ExpressionSpecification = ['==', ['get', 'brunnel'], 'tunnel'];
const name: ExpressionSpecification = ['coalesce', ['get', 'name:fr'], ['get', 'name']];

/** Largeurs par catégorie de route (remplissage), selon le zoom. */
const ROADS = [
  { id: 'service', classes: ['service', 'track'], color: C.road, casing: C.roadCase, width: [[14, 0.5], [16, 3], [19, 10]] as [number, number][], minzoom: 14 },
  { id: 'minor', classes: ['minor'], color: C.road, casing: C.roadCase, width: [[12, 0.6], [14, 2.2], [16, 6], [19, 18]] as [number, number][], minzoom: 12 },
  { id: 'secondary', classes: ['secondary', 'tertiary'], color: C.road, casing: C.roadCase, width: [[9, 0.6], [12, 2], [14, 4.5], [16, 9], [19, 24]] as [number, number][], minzoom: 9 },
  { id: 'primary', classes: ['primary', 'trunk'], color: C.primary, casing: C.primaryCase, width: [[7, 0.6], [10, 1.8], [13, 4], [16, 11], [19, 28]] as [number, number][], minzoom: 6 },
  { id: 'motorway', classes: ['motorway'], color: C.motorway, casing: C.motorwayCase, width: [[5, 0.6], [9, 1.8], [12, 3.6], [16, 12], [19, 30]] as [number, number][], minzoom: 5 },
];

function roadLayers(prefix: string, filter: ExpressionSpecification, opacity = 1): LayerSpecification[] {
  const casings: LayerSpecification[] = [];
  const fills: LayerSpecification[] = [];
  for (const r of ROADS) {
    const f: ExpressionSpecification = ['all', filter, classIs(...r.classes)];
    casings.push({
      id: `${prefix}-${r.id}-case`, type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: r.minzoom, filter: f,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': r.casing,
        'line-opacity': opacity,
        // Le liseré n'apparaît qu'à partir de la largeur où il se lit.
        'line-gap-width': zoomWidth(r.width),
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 16, 1, 19, 1.5],
      },
    });
    fills.push({
      id: `${prefix}-${r.id}`, type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: r.minzoom, filter: f,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': r.color, 'line-width': zoomWidth(r.width), 'line-opacity': opacity },
    });
  }
  return [...casings, ...fills];
}

export function appleLightStyle(): StyleSpecification {
  return {
    version: 8,
    name: 'RunDraw clair',
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Données © <a href="https://www.openstreetmap.org/copyright" target="_blank">contributeurs OpenStreetMap</a>' },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': C.land } },

      // Sol
      { id: 'landuse-urban', type: 'fill', source: 'omt', 'source-layer': 'landuse', filter: classIs('residential', 'suburb', 'neighbourhood', 'commercial', 'retail'), paint: { 'fill-color': C.urban } },
      { id: 'landuse-industrial', type: 'fill', source: 'omt', 'source-layer': 'landuse', filter: classIs('industrial', 'railway', 'garages', 'military'), paint: { 'fill-color': C.industrial } },
      { id: 'landuse-education', type: 'fill', source: 'omt', 'source-layer': 'landuse', filter: classIs('school', 'university', 'college', 'kindergarten'), paint: { 'fill-color': C.education } },
      { id: 'landuse-hospital', type: 'fill', source: 'omt', 'source-layer': 'landuse', filter: classIs('hospital'), paint: { 'fill-color': C.hospital } },
      { id: 'landuse-cemetery', type: 'fill', source: 'omt', 'source-layer': 'landuse', filter: classIs('cemetery'), paint: { 'fill-color': C.cemetery } },
      { id: 'landcover-sand', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: classIs('sand', 'beach'), paint: { 'fill-color': C.sand } },
      { id: 'landcover-grass', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: classIs('grass', 'farmland', 'wetland'), paint: { 'fill-color': C.grass, 'fill-opacity': 0.8 } },
      { id: 'landcover-wood', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: classIs('wood', 'forest'), paint: { 'fill-color': C.wood } },
      { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': C.park } },
      { id: 'landuse-pitch', type: 'fill', source: 'omt', 'source-layer': 'landuse', filter: classIs('pitch', 'stadium', 'playground', 'park', 'garden'), paint: { 'fill-color': C.park } },

      // Eau
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', filter: ['!=', ['get', 'brunnel'], 'tunnel'], paint: { 'fill-color': C.water } },
      {
        id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', filter: notTunnel,
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': C.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 14, 1.5, 18, 4] },
      },

      // Aéroports et bâtiments
      { id: 'aeroway-area', type: 'fill', source: 'omt', 'source-layer': 'aeroway', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': C.aeroway } },
      {
        id: 'aeroway-runway', type: 'line', source: 'omt', 'source-layer': 'aeroway', filter: ['==', ['geometry-type'], 'LineString'],
        paint: { 'line-color': '#d9d6e2', 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 10, 1, 16, 30] },
      },
      {
        id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 14,
        paint: {
          'fill-color': C.building,
          'fill-outline-color': C.buildingEdge,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 1],
        },
      },

      // Tunnels, discrets
      ...roadLayers('tunnel', isTunnel, 0.45),

      // Chemins piétons
      {
        id: 'path', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 14,
        filter: ['all', notTunnel, classIs('path', 'pedestrian')],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        // Blancs comme chez Apple : ils se lisent sur le sol crème comme dans les parcs.
        paint: { 'line-color': C.path, 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.8, 17, 2.5, 19, 5] },
      },

      // Voies ferrées
      {
        id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 11,
        filter: ['all', notTunnel, classIs('rail', 'transit')],
        paint: { 'line-color': C.rail, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 16, 1.6] },
      },

      // Routes
      ...roadLayers('road', notTunnel),

      // Limites administratives
      {
        id: 'boundary', type: 'line', source: 'omt', 'source-layer': 'boundary',
        filter: ['all', ['<=', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': C.boundary, 'line-width': 1, 'line-dasharray': [3, 2] },
      },

      // Libellés
      {
        id: 'water-name', type: 'symbol', source: 'omt', 'source-layer': 'water_name',
        layout: { 'text-field': name, 'text-font': FONT_ITALIC, 'text-size': 13, 'text-letter-spacing': 0.04, 'text-max-width': 6 },
        paint: { 'text-color': C.waterLabel, 'text-halo-color': 'rgba(255,255,255,0.6)', 'text-halo-width': 1 },
      },
      {
        id: 'waterway-name', type: 'symbol', source: 'omt', 'source-layer': 'waterway', minzoom: 13,
        layout: { 'text-field': name, 'text-font': FONT_ITALIC, 'text-size': 12, 'symbol-placement': 'line', 'text-letter-spacing': 0.06 },
        paint: { 'text-color': C.waterLabel, 'text-halo-color': 'rgba(255,255,255,0.6)', 'text-halo-width': 1 },
      },
      {
        id: 'park-name', type: 'symbol', source: 'omt', 'source-layer': 'park', minzoom: 14,
        filter: ['has', 'name'],
        layout: { 'text-field': name, 'text-font': FONT, 'text-size': 12, 'text-max-width': 7 },
        paint: { 'text-color': C.parkLabel, 'text-halo-color': C.halo, 'text-halo-width': 1.2 },
      },
      {
        id: 'road-name', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 13,
        filter: classIs('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor'),
        layout: {
          'text-field': name,
          'text-font': FONT,
          'symbol-placement': 'line',
          'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 17, 13],
          'text-letter-spacing': 0.01,
        },
        paint: { 'text-color': C.roadLabel, 'text-halo-color': C.halo, 'text-halo-width': 1.5 },
      },
      {
        id: 'place-neighbourhood', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 12,
        filter: classIs('suburb', 'quarter', 'neighbourhood'),
        layout: {
          'text-field': name,
          'text-font': FONT_BOLD,
          'text-transform': 'uppercase',
          'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 12],
          'text-letter-spacing': 0.12,
          'text-max-width': 8,
        },
        paint: { 'text-color': C.labelSoft, 'text-halo-color': C.halo, 'text-halo-width': 1.2 },
      },
      {
        id: 'place-village', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 10,
        filter: classIs('village', 'hamlet'),
        layout: { 'text-field': name, 'text-font': FONT, 'text-size': 12, 'text-max-width': 8 },
        paint: { 'text-color': C.label, 'text-halo-color': C.halo, 'text-halo-width': 1.4 },
      },
      {
        id: 'place-town', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 7,
        filter: classIs('town'),
        layout: { 'text-field': name, 'text-font': FONT_BOLD, 'text-size': ['interpolate', ['linear'], ['zoom'], 8, 12, 14, 15], 'text-max-width': 8 },
        paint: { 'text-color': C.label, 'text-halo-color': C.halo, 'text-halo-width': 1.5 },
      },
      {
        id: 'place-city', type: 'symbol', source: 'omt', 'source-layer': 'place', maxzoom: 15,
        filter: classIs('city'),
        layout: {
          'text-field': name,
          'text-font': FONT_BOLD,
          'text-size': ['interpolate', ['linear'], ['zoom'], 5, 13, 10, 18, 14, 22],
          'text-letter-spacing': -0.01,
          'text-max-width': 8,
        },
        paint: { 'text-color': '#2a2a2a', 'text-halo-color': C.halo, 'text-halo-width': 1.6 },
      },
      {
        id: 'place-country', type: 'symbol', source: 'omt', 'source-layer': 'place', maxzoom: 7,
        filter: classIs('country'),
        layout: { 'text-field': name, 'text-font': FONT_BOLD, 'text-transform': 'uppercase', 'text-size': 13, 'text-letter-spacing': 0.15 },
        paint: { 'text-color': '#5e5a55', 'text-halo-color': C.halo, 'text-halo-width': 1.5 },
      },
    ],
  };
}
