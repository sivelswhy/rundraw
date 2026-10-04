import type { LngLat } from './geometry';

const escape = (s: string) => s.replace(/[<>&"]/g, (c) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', '"': 'quot' }[c]};`);

/** Itinéraire à suivre (importable dans Strava, Garmin, Komoot, Coros…). */
export function routeToGpx(name: string, line: LngLat[]): string {
  const pts = line.map(([lng, lat]) => `      <trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"/>`).join('\n');
  return wrap(name, `  <trk>\n    <name>${escape(name)}</name>\n    <type>running</type>\n    <trkseg>\n${pts}\n    </trkseg>\n  </trk>`);
}

function wrap(name: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RunDraw" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${escape(name)}</name><time>${new Date().toISOString()}</time></metadata>
${body}
</gpx>
`;
}

export async function downloadGpx(filename: string, gpx: string) {
  const file = new File([gpx], filename, { type: 'application/gpx+xml' });
  // Sur mobile, la feuille de partage permet d'envoyer directement vers l'app de sport.
  if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slug(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'dessin';
}
