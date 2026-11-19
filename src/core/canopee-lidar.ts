// Canopée et arbres mesurés par le LiDAR HD de l'IGN.
//
// Deux sources ouvertes, sans clé, lues pixel par pixel dans le cercle :
//  - la hauteur du sursol LiDAR HD (MNH = MNS − MNT, 50 cm, WMS-R de la
//    Géoplateforme) : hauteur au-dessus du sol de ce que voit le laser ;
//  - CoSIA (IGN) : couverture du sol vue d'avion, pour ne garder que la
//    végétation (feuillus, conifères, broussailles) et écarter toits, murs,
//    lampadaires, véhicules.
// Canopée = pixel végétal d'au moins 3 m de haut.
//
// Arbres : sommets locaux de la canopée (fenêtre variable avec la hauteur,
// Popescu et Wynne 2004 : diamètre = 2,51 + 0,009 h²), puis houppier de
// chaque sommet par croissance de région (pixels assez hauts, pas trop loin).
// Méthode standard d'inventaire par LiDAR ; elle sépare bien les arbres
// isolés et d'alignement, moins bien les bosquets serrés (houppiers jointifs :
// plusieurs arbres peuvent être comptés comme un seul). La couverture de
// canopée, elle, ne dépend pas de ce découpage.

import { hauteurSursolTuile, TAILLE_TUILE } from "../atelier/relief-dem";
import { classesCosiaTuile, CLASSES_COSIA } from "./cosia";

const C = 20037508.342789244;
export const H_CANOPEE = 3;
const H_SOMMET = 4;
const VEGETAL = new Set(["feuillu", "conifere", "broussaille"].map((id) => CLASSES_COSIA.findIndex((c) => c.id === id)));

/** Classes de hauteur de la canopée (m) et leurs teintes (rampe verte, du clair au foncé). */
export const CLASSES_HAUTEUR = [
  { min: 3, max: 8, titre: "3 – 8 m", couleur: "#c5e1a5" },
  { min: 8, max: 15, titre: "8 – 15 m", couleur: "#8bc34a" },
  { min: 15, max: 25, titre: "15 – 25 m", couleur: "#4e9a2f" },
  { min: 25, max: Infinity, titre: "25 m et plus", couleur: "#1f6b24" },
] as const;

export interface ArbreLidar {
  lat: number;
  lon: number;
  /** Hauteur du sommet (m). */
  hauteur: number;
  /** Diamètre du houppier (m), d'après la surface de canopée rattachée. */
  couronne: number;
}

export interface CanopeeLidar {
  rayonM: number;
  /** Taille d'un pixel analysé (m au sol). */
  pixelM: number;
  /** Part du cercle où LiDAR et CoSIA sont disponibles (%). */
  couverturePct: number;
  /** Canopée (végétation ≥ 3 m) rapportée à la part couverte du cercle (%). */
  canopeePct: number;
  canopeeM2: number;
  /** Hauteurs de la canopée (m) : moyenne, 90e centile, maximum. */
  hMoy: number;
  hP90: number;
  hMax: number;
  /** Part de la canopée par classe de hauteur (%), dans l'ordre de CLASSES_HAUTEUR. */
  partsHauteur: number[];
  /** Volume du houppier approché (somme hauteur × surface, m³). */
  volumeM3: number;
  arbres: ArbreLidar[];
  /** Arbres détectés pour 1 ha de cercle couvert. */
  densiteHa: number;
  millesimeCosia: string;
  /** Image de la canopée (RGBA, teinte selon la hauteur) et son emprise lon/lat [ouest, sud, est, nord]. */
  image: { largeur: number; hauteur: number; rgba: Uint8ClampedArray; emprise: [number, number, number, number] };
}

const versMerc = (lon: number, lat: number) => [(lon * C) / 180, (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * C) / Math.PI];
const depuisMerc = (x: number, y: number): [number, number] => [(x / C) * 180, (Math.atan(Math.exp((y / C) * Math.PI)) * 360) / Math.PI - 90];

export async function analyserCanopee(lat: number, lon: number, rayonM: number): Promise<CanopeeLidar> {
  const z = rayonM <= 200 ? 18 : rayonM <= 500 ? 17 : 16;
  const k = 1 / Math.cos((lat * Math.PI) / 180); // mètres Mercator par mètre au sol
  const t = (2 * C) / 2 ** z;
  const pxMerc = t / TAILLE_TUILE;
  const pixelM = pxMerc / k;
  const [cx, cy] = versMerc(lon, lat);
  const d = rayonM * k;
  const x0 = Math.floor((cx - d + C) / t), x1 = Math.floor((cx + d + C) / t);
  const y0 = Math.floor((C - (cy + d)) / t), y1 = Math.floor((C - (cy - d)) / t);
  const nx = x1 - x0 + 1, ny = y1 - y0 + 1;
  const W = nx * TAILLE_TUILE, H = ny * TAILLE_TUILE;
  const h = new Float32Array(W * H).fill(NaN);
  const veg = new Uint8Array(W * H).fill(255); // 255 : inconnu ; 1 végétal ; 0 autre
  let millesime = "";

  const taches: (() => Promise<void>)[] = [];
  let refus = 0;
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++)
      taches.push(async () => {
        const [mnh, cos] = await Promise.all([hauteurSursolTuile(z, tx, ty).catch(() => null), classesCosiaTuile(z, tx, ty).catch(() => null)]);
        if (!mnh || !cos) refus++;
        if (cos && !millesime) millesime = cos.millesime;
        const ox = (tx - x0) * TAILLE_TUILE, oy = (ty - y0) * TAILLE_TUILE;
        for (let j = 0; j < TAILLE_TUILE; j++)
          for (let i = 0; i < TAILLE_TUILE; i++) {
            const kk = j * TAILLE_TUILE + i, g = (oy + j) * W + ox + i;
            if (mnh) {
              const v = mnh[kk];
              if (Number.isFinite(v) && v > -50 && v < 80) h[g] = Math.max(0, v);
            }
            if (cos && cos.classes[kk] !== 255) veg[g] = VEGETAL.has(cos.classes[kk]) ? 1 : 0;
          }
      });
  let suivant = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (suivant < taches.length) await taches[suivant++]();
  }));
  if (refus === taches.length) throw new Error("LiDAR HD ou CoSIA indisponible ici");

  // Grille → Mercator : coin nord-ouest.
  const gx0 = -C + x0 * t, gy0 = C - y0 * t;
  const pcx = (cx - gx0) / pxMerc, pcy = (gy0 - cy) / pxMerc, rPx = d / pxMerc;
  const dansCercle = (i: number, j: number) => (i + 0.5 - pcx) ** 2 + (j + 0.5 - pcy) ** 2 <= rPx * rPx;

  // Masque de canopée et indicateurs.
  const can = new Uint8Array(W * H);
  let couverts = 0, cercle = 0, nCan = 0, sommeH = 0;
  const hist = new Uint32Array(81);
  const parts = CLASSES_HAUTEUR.map(() => 0);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      if (!dansCercle(i, j)) continue;
      cercle++;
      const g = j * W + i;
      if (Number.isNaN(h[g]) || veg[g] === 255) continue;
      couverts++;
      if (veg[g] === 1 && h[g] >= H_CANOPEE) {
        can[g] = 1;
        nCan++;
        sommeH += h[g];
        hist[Math.min(80, Math.floor(h[g]))]++;
        parts[CLASSES_HAUTEUR.findIndex((c) => h[g] >= c.min && h[g] < c.max)]++;
      }
    }
  if (couverts < cercle * 0.05) throw new Error("LiDAR HD pas encore publié ici");
  let cumul = 0, hP90 = 0;
  for (let v = 0; v <= 80; v++) {
    cumul += hist[v];
    if (cumul >= nCan * 0.9) {
      hP90 = v + 0.5;
      break;
    }
  }
  let hMax = 0;
  for (let g = 0; g < can.length; g++) if (can[g] && h[g] > hMax) hMax = h[g];

  // Sommets : hauteur lissée (3 × 3), maximum strict dans une fenêtre variable.
  const hs = new Float32Array(W * H);
  for (let j = 1; j < H - 1; j++)
    for (let i = 1; i < W - 1; i++) {
      const g = j * W + i;
      if (!can[g]) continue;
      let s = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const gg = g + dj * W + di;
          if (can[gg]) {
            s += h[gg];
            n++;
          }
        }
      hs[g] = s / n;
    }
  const sommets: number[] = [];
  for (let j = 1; j < H - 1; j++)
    for (let i = 1; i < W - 1; i++) {
      const g = j * W + i;
      const v = hs[g];
      if (!can[g] || v < H_SOMMET || !dansCercle(i, j)) continue;
      const rf = Math.max(1, Math.round((2.51503 + 0.00901 * v * v) / 2 / pixelM));
      let max = true;
      for (let dj = -rf; dj <= rf && max; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= H) continue;
        for (let di = -rf; di <= rf; di++) {
          if (di * di + dj * dj > rf * rf || (di === 0 && dj === 0)) continue;
          const ii = i + di;
          if (ii < 0 || ii >= W) continue;
          const w = hs[jj * W + ii];
          // Égalité : on garde le premier dans l'ordre de lecture.
          if (w > v || (w === v && jj * W + ii < g)) {
            max = false;
            break;
          }
        }
      }
      if (max) sommets.push(g);
    }

  // Houppiers : croissance simultanée depuis les sommets (8 voisins), tant que
  // le pixel est de la canopée, au moins à 40 % de la hauteur du sommet, et à
  // moins de 0,35 h + 1 m du sommet.
  const proprio = new Int32Array(W * H).fill(-1);
  const aire = new Uint32Array(sommets.length);
  let file: number[] = [];
  sommets.forEach((g, s) => {
    proprio[g] = s;
    aire[s] = 1;
    file.push(g);
  });
  const portee = sommets.map((g) => ((0.35 * hs[g] + 1) / pixelM) ** 2);
  while (file.length) {
    const suite: number[] = [];
    for (const g of file) {
      const s = proprio[g], gs = sommets[s];
      const i = g % W, j = (g - i) / W, is = gs % W, js = (gs - is) / W;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
        const gg = jj * W + ii;
        if (proprio[gg] !== -1 || !can[gg] || h[gg] < 0.4 * hs[gs]) continue;
        if ((ii - is) ** 2 + (jj - js) ** 2 > portee[s]) continue;
        proprio[gg] = s;
        aire[s]++;
        suite.push(gg);
      }
    }
    file = suite;
  }
  const aPx = pixelM * pixelM;
  const arbres: ArbreLidar[] = sommets.map((g, s) => {
    const i = g % W, j = (g - i) / W;
    const [lo, la] = depuisMerc(gx0 + (i + 0.5) * pxMerc, gy0 - (j + 0.5) * pxMerc);
    return { lat: la, lon: lo, hauteur: Math.round(hs[g] * 10) / 10, couronne: Math.round(Math.max(1.5, 2 * Math.sqrt((aire[s] * aPx) / Math.PI)) * 10) / 10 };
  });

  // Image de la canopée dans le cercle, teinte par classe de hauteur.
  const rgba = new Uint8ClampedArray(W * H * 4);
  const teintes = CLASSES_HAUTEUR.map((c) => [1, 3, 5].map((o) => parseInt(c.couleur.slice(o, o + 2), 16)));
  for (let g = 0; g < can.length; g++) {
    if (!can[g]) continue;
    const i = g % W, j = (g - i) / W;
    if (!dansCercle(i, j)) continue;
    const c = teintes[CLASSES_HAUTEUR.findIndex((x) => h[g] >= x.min && h[g] < x.max)];
    rgba.set([c[0], c[1], c[2], 235], g * 4);
  }
  const [ouest, nord] = depuisMerc(gx0, gy0);
  const [est, sud] = depuisMerc(gx0 + W * pxMerc, gy0 - H * pxMerc);

  const res: CanopeeLidar = {
    rayonM,
    pixelM,
    couverturePct: Math.round((couverts / cercle) * 1000) / 10,
    canopeePct: Math.round((nCan / couverts) * 1000) / 10,
    canopeeM2: Math.round(nCan * aPx),
    hMoy: nCan ? Math.round((sommeH / nCan) * 10) / 10 : 0,
    hP90,
    hMax: Math.round(hMax * 10) / 10,
    partsHauteur: parts.map((p) => (nCan ? Math.round((p / nCan) * 1000) / 10 : 0)),
    volumeM3: Math.round(sommeH * aPx),
    arbres,
    densiteHa: 0,
    millesimeCosia: millesime,
    image: { largeur: W, hauteur: H, rgba, emprise: [ouest, sud, est, nord] },
  };
  res.densiteHa = densite(res);
  return res;
}

/** Densité d'arbres détectés pour 1 ha couvert. */
export function densite(c: CanopeeLidar): number {
  const ha = (Math.PI * c.rayonM ** 2 * (c.couverturePct / 100)) / 10_000;
  return ha > 0 ? Math.round((c.arbres.length / ha) * 10) / 10 : 0;
}
