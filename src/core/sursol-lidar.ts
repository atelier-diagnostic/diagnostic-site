// Grille de hauteur du sursol LiDAR HD (MNH = MNS − MNT, 50 cm) sur le cercle
// d'analyse, pour les volumes du bâti mesurés.
//
// Mêmes tuiles et même zoom que l'analyse de la canopée (canopee-lidar.ts) :
// les deux partagent le cache des tuiles, rien n'est demandé deux fois.
// Pixels hors couverture LiDAR : NaN.

import { hauteurSursolTuile, TAILLE_TUILE } from "../atelier/relief-dem";

const C = 20037508.342789244;
const MAX_TUILES = 36;

export interface GrilleSursol {
  largeur: number;
  hauteur: number;
  /** Hauteur au-dessus du sol (m), ligne 0 au nord ; NaN hors couverture. */
  h: Float32Array;
  /** Coin nord-ouest de la grille et taille d'un pixel, en mètres Web Mercator. */
  x0: number;
  y0: number;
  pxMerc: number;
  /** Taille d'un pixel au sol (m). */
  pixelM: number;
  /** Part des tuiles reçues (0-1). */
  couverture: number;
}

const memo = new Map<string, Promise<GrilleSursol>>();

export function grilleSursol(lat: number, lon: number, rayonM: number, progression?: (faites: number, total: number) => void): Promise<GrilleSursol> {
  const cle = `${lat.toFixed(5)},${lon.toFixed(5)},${Math.round(rayonM)}`;
  let p = memo.get(cle);
  if (!p) {
    p = calculer(lat, lon, rayonM, progression);
    memo.set(cle, p);
    p.catch(() => memo.delete(cle));
    if (memo.size > 6) memo.delete(memo.keys().next().value!);
  }
  return p;
}

async function calculer(lat: number, lon: number, rayonM: number, progression?: (faites: number, total: number) => void): Promise<GrilleSursol> {
  const k = 1 / Math.cos((lat * Math.PI) / 180);
  let z = 18;
  while (z > 14 && (Math.ceil((2 * rayonM * k) / ((2 * C) / 2 ** z)) + 1) ** 2 > MAX_TUILES) z--;
  const t = (2 * C) / 2 ** z;
  const pxMerc = t / TAILLE_TUILE;
  const cx = (lon * C) / 180;
  const cy = (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * C) / Math.PI;
  const d = rayonM * k;
  const tx0 = Math.floor((cx - d + C) / t), tx1 = Math.floor((cx + d + C) / t);
  const ty0 = Math.floor((C - (cy + d)) / t), ty1 = Math.floor((C - (cy - d)) / t);
  const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1;
  const W = nx * TAILLE_TUILE, H = ny * TAILLE_TUILE;
  const h = new Float32Array(W * H).fill(NaN);
  let recues = 0, faites = 0;
  const total = nx * ny;
  const taches: Promise<void>[] = [];
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++)
      taches.push(
        hauteurSursolTuile(z, tx, ty)
          .then((tuile) => {
            recues++;
            const ox = (tx - tx0) * TAILLE_TUILE, oy = (ty - ty0) * TAILLE_TUILE;
            for (let j = 0; j < TAILLE_TUILE; j++)
              for (let i = 0; i < TAILLE_TUILE; i++) {
                const v = tuile[j * TAILLE_TUILE + i];
                if (Number.isFinite(v) && v > -50 && v < 400) h[(oy + j) * W + ox + i] = Math.max(0, v);
              }
          })
          .catch(() => undefined)
          .finally(() => progression?.(++faites, total)),
      );
  await Promise.all(taches);
  if (!recues) throw new Error("LiDAR HD indisponible");
  return { largeur: W, hauteur: H, h, x0: -C + tx0 * t, y0: C - ty0 * t, pxMerc, pixelM: pxMerc / k, couverture: recues / total };
}
