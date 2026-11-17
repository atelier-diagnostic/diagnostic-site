// Relief de l'atelier : altitudes du RGE ALTI® (IGN) servies par le WMS
// raster de la Géoplateforme en flottants bruts (BIL 32 bits), converties à la
// volée en tuiles « terrarium » que MapLibre sait lire pour le terrain 3D et
// l'ombrage. Sans clé.
//
// Le protocole « ignbil:// » reçoit l'URL WMS sans « https:// », lit les
// 256 × 256 altitudes (float32, petit-boutiste) et encode chaque pixel :
// v = altitude + 32768 ; R = v / 256, G = v mod 256, B = fraction × 256.
// Hors couverture (valeur de « pas de donnée ») : altitude 0.

import maplibregl from "maplibre-gl";

const TAILLE = 256;
export const DEM_TUILES =
  "ignbil://data.geopf.fr/wms-r?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap" +
  "&LAYERS=ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES&STYLES=&FORMAT=image/x-bil;bits=32" +
  `&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=${TAILLE}&HEIGHT=${TAILLE}`;

let enregistre = false;

/** Convertit des altitudes en image terrarium (PNG). */
async function versTerrarium(z: Float32Array): Promise<ArrayBuffer> {
  const px = new Uint8ClampedArray(TAILLE * TAILLE * 4);
  for (let i = 0; i < TAILLE * TAILLE; i++) {
    let h = z[i];
    if (!Number.isFinite(h) || h < -1000 || h > 9000) h = 0;
    const v = h + 32768;
    const e = Math.floor(v);
    px[i * 4] = (e >> 8) & 255;
    px[i * 4 + 1] = e & 255;
    px[i * 4 + 2] = Math.floor((v - e) * 256);
    px[i * 4 + 3] = 255;
  }
  const toile = new OffscreenCanvas(TAILLE, TAILLE);
  toile.getContext("2d")!.putImageData(new ImageData(px, TAILLE, TAILLE), 0, 0);
  const blob = await toile.convertToBlob({ type: "image/png" });
  return blob.arrayBuffer();
}

// Le WMS de l'IGN limite le débit (429) et renvoie parfois 502/504 : six
// requêtes au plus en même temps, trois nouvelles tentatives espacées, et les
// tuiles déjà converties gardées en mémoire (le terrain et l'ombrage, et les
// allers-retours 2D/3D, redemandent les mêmes).
const MAX_EN_COURS = 6;
let enCours = 0;
const file: (() => void)[] = [];
const cache = new Map<string, Promise<Float32Array>>();
const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function creneau<T>(f: () => Promise<T>): Promise<T> {
  if (enCours >= MAX_EN_COURS) await new Promise<void>((r) => file.push(r));
  enCours++;
  try {
    return await f();
  } finally {
    enCours--;
    file.shift()?.();
  }
}

async function charger(url: string): Promise<Float32Array> {
  for (let essai = 0; ; essai++) {
    let rep: Response;
    try {
      // Délai de 20 s ; aux nouvelles tentatives, on contourne le cache HTTP
      // (une réponse d'erreur peut y être gardée).
      rep = await creneau(() => fetch(url, { signal: AbortSignal.timeout(20_000), cache: essai ? "reload" : "default" }));
    } catch (e) {
      if (essai >= 3) throw e;
      await attendre([600, 1500, 3500][essai]);
      continue;
    }
    if (rep.ok) {
      const buf = await rep.arrayBuffer();
      if (buf.byteLength < TAILLE * TAILLE * 4) throw new Error("Relief IGN : réponse inattendue");
      return new Float32Array(buf, 0, TAILLE * TAILLE);
    }
    if (essai >= 3 || !(rep.status === 429 || rep.status >= 500)) throw new Error(`Relief IGN : HTTP ${rep.status}`);
    await attendre([600, 1500, 3500][essai] + Math.random() * 400);
  }
}

export function enregistrerProtocoleRelief(): void {
  if (enregistre) return;
  enregistre = true;
  maplibregl.addProtocol("ignbil", async (params) => ({
    data: await versTerrarium(await altitudesBrutes(params.url.replace(/^ignbil:\/\//, "https://"))),
  }));
}

/** Altitudes brutes d'une tuile (256 × 256, ligne 0 au nord), mises en cache. */
function altitudesBrutes(url: string): Promise<Float32Array> {
  let p = cache.get(url);
  if (!p) {
    p = charger(url);
    cache.set(url, p);
    p.catch(() => cache.delete(url));
    if (cache.size > 600) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/** Altitudes de la tuile Web Mercator (z, x, y), mêmes requêtes que le terrain. */
export const TAILLE_TUILE = TAILLE;
export function altitudesTuile(z: number, x: number, y: number): Promise<Float32Array> {
  const C = 20037508.342789244;
  const t = (2 * C) / 2 ** z;
  const bbox = [-C + x * t, C - (y + 1) * t, -C + (x + 1) * t, C - y * t].join(",");
  return altitudesBrutes(DEM_TUILES.replace("ignbil://", "https://").replace("{bbox-epsg-3857}", bbox));
}
