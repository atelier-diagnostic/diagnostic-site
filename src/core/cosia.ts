// Couverture du sol mesurée dans le périmètre, à partir de CoSIA (IGN,
// « Couverture du Sol par Intelligence Artificielle », déduite des photos
// aériennes, ~20 cm de résolution d'origine).
//
// Méthode : les tuiles WMTS de CoSIA (Géoplateforme, sans clé, CORS ouvert)
// sont des aplats d'une couleur par classe ; chaque pixel est rattaché à la
// couleur de légende (à un léger écart près) ; les pixels de bord, mélangés
// par l'anti-crénelage, ne sont pas classés (sinon bâtiment + voirie
// ressemble à « vigne ») : les parts sont calculées sur les pixels classés. Pixels comptés dans le
// cercle du périmètre, au zoom 18 (≈ 0,45 m par pixel en France
// métropolitaine), 17 au-delà de 400 m, 16 au-delà de 1 000 m.
// Millésime 2021-2023, repli sur 2017-2020 si la zone n'est pas couverte.

import type { MultiPolygone } from "./perimetre";
import { IGN_WMTS } from "../api/endpoints";

export type ClasseCosia =
  | "batiment" | "permeable" | "impermeable" | "piscine" | "solnu" | "eau" | "neige"
  | "conifere" | "feuillu" | "broussaille" | "vigne" | "pelouse" | "culture" | "labour" | "serre" | "coupe" | "autre";

/** Couleurs de la légende officielle CoSIA (lues sur l'image de légende de l'IGN le 17/11/2026). */
export const CLASSES_COSIA: { id: ClasseCosia; titre: string; couleur: string }[] = [
  { id: "batiment", titre: "Bâtiment", couleur: "#ce7079" },
  { id: "impermeable", titre: "Zone imperméable", couleur: "#a6aab7" },
  { id: "piscine", titre: "Piscine", couleur: "#62d0ff" },
  { id: "serre", titre: "Serre", couleur: "#b9e2d4" },
  { id: "permeable", titre: "Zone perméable", couleur: "#987752" },
  { id: "solnu", titre: "Sol nu", couleur: "#bbb096" },
  { id: "labour", titre: "Terre labourée", couleur: "#d0a349" },
  { id: "coupe", titre: "Coupe", couleur: "#df8b52" },
  { id: "pelouse", titre: "Pelouse", couleur: "#8cd76a" },
  { id: "culture", titre: "Culture", couleur: "#decf55" },
  { id: "vigne", titre: "Vigne", couleur: "#b08290" },
  { id: "broussaille", titre: "Broussaille", couleur: "#b5c335" },
  { id: "feuillu", titre: "Feuillu", couleur: "#4c9129" },
  { id: "conifere", titre: "Conifère", couleur: "#126421" },
  { id: "eau", titre: "Surface en eau", couleur: "#3375a1" },
  { id: "neige", titre: "Neige", couleur: "#e9effe" },
  { id: "autre", titre: "Autre", couleur: "#222222" },
];

const MILLESIMES = ["2021-2023", "2017-2020"] as const;
/** Écart de couleur maximal (distance² RVB) pour rattacher un pixel à une classe. */
const MELANGE_MAX = 3 * 12 * 12;
const RGB = CLASSES_COSIA.map((c) => [1, 3, 5].map((o) => parseInt(c.couleur.slice(o, o + 2), 16)));

export interface CosiaResultat {
  millesime: string;
  /** Surface par classe (m²) dans le cercle (ou le contour). */
  surfaces: Record<ClasseCosia, number>;
  /** Surface classée (m²) ; la part non couverte par CoSIA est exclue. */
  totalM2: number;
  /** Part du cercle couverte par CoSIA (%). */
  couverturePct: number;
  /** Taille d'un pixel analysé (m). */
  pixelM: number;
}

function tuileXY(lat: number, lon: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  return [x, y];
}

async function pixels(url: string): Promise<Uint8ClampedArray | null> {
  for (let essai = 0; essai < 3; essai++) {
    try {
      const rep = await fetch(url, { cache: essai ? "reload" : "default" });
      if (rep.status === 404 || rep.status === 204) return null;
      if (!rep.ok) throw new Error(String(rep.status));
      const bmp = await createImageBitmap(await rep.blob());
      const toile = new OffscreenCanvas(256, 256);
      const g = toile.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(bmp, 0, 0);
      return g.getImageData(0, 0, 256, 256).data;
    } catch {
      await new Promise((r) => setTimeout(r, 700 * (essai + 1)));
    }
  }
  throw new Error("CoSIA indisponible");
}

/**
 * Test « dans la zone » en pixels du monde : cercle par défaut, ou contour
 * (multipolygone GeoJSON, trous compris) pour un périmètre de projet.
 */
function testZone(z: number, cx: number, cy: number, rPx: number, contour?: MultiPolygone): (px: number, py: number) => boolean {
  if (!contour) return (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= rPx * rPx;
  const anneaux = contour.flatMap((poly) => poly.map((ring) => ring.map(([lo, la]) => tuileXY(la, lo, z).map((v) => v * 256) as [number, number])));
  return (px, py) => {
    let dedans = false;
    for (const r of anneaux)
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i];
        const [xj, yj] = r[j];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) dedans = !dedans;
      }
    return dedans;
  };
}

async function analyserMillesime(lat: number, lon: number, rayonM: number, millesime: string, contour?: MultiPolygone): Promise<CosiaResultat> {
  const z = rayonM <= 400 ? 18 : rayonM <= 1000 ? 17 : 16;
  const mParPx = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
  const rPx = rayonM / mParPx; // rayon (englobant) en pixels du monde au zoom z
  const [cx, cy] = tuileXY(lat, lon, z).map((v) => v * 256);
  const dansZone = testZone(z, cx, cy, rPx, contour);
  const tx0 = Math.floor((cx - rPx) / 256), tx1 = Math.floor((cx + rPx) / 256);
  const ty0 = Math.floor((cy - rPx) / 256), ty1 = Math.floor((cy + rPx) / 256);
  const layer = `IGNF_COSIA_${millesime}`;

  const comptes = new Array(CLASSES_COSIA.length).fill(0) as number[];
  let dansCercle = 0, classes = 0, melanges = 0;
  const taches: (() => Promise<void>)[] = [];
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++)
      taches.push(async () => {
        const url = IGN_WMTS.replace("{z}", String(z)).replace("{x}", String(tx)).replace("{y}", String(ty)).replace("{layer}", layer).replace("{format}", "image/png");
        const d = await pixels(url);
        for (let j = 0; j < 256; j++) {
          const py = ty * 256 + j + 0.5;
          for (let i = 0; i < 256; i++) {
            const px = tx * 256 + i + 0.5;
            if (!dansZone(px, py)) continue;
            dansCercle++;
            if (!d) continue;
            const o = (j * 256 + i) * 4;
            if (d[o + 3] < 128) continue; // hors couverture
            let best = 0, bd = Infinity;
            for (let k = 0; k < RGB.length; k++) {
              const dr = d[o] - RGB[k][0], dg = d[o + 1] - RGB[k][1], db = d[o + 2] - RGB[k][2];
              const dist = dr * dr + dg * dg + db * db;
              if (dist < bd) {
                bd = dist;
                best = k;
              }
            }
            // Pixel de bord mélangé par l'anti-crénelage (ex. bâtiment + voirie ≈ vigne) : non classé.
            if (bd > MELANGE_MAX) {
              melanges++;
              continue;
            }
            comptes[best]++;
            classes++;
          }
        }
      });
  // Six tuiles à la fois.
  let suivant = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (suivant < taches.length) await taches[suivant++]();
  }));

  const aire = mParPx * mParPx;
  const surfaces = Object.fromEntries(CLASSES_COSIA.map((c, k) => [c.id, comptes[k] * aire])) as Record<ClasseCosia, number>;
  return { millesime, surfaces, totalM2: classes * aire, couverturePct: dansCercle ? ((classes + melanges) / dansCercle) * 100 : 0, pixelM: mParPx };
}

/**
 * Classe CoSIA de chaque pixel d'une tuile (indice dans CLASSES_COSIA ; 255 :
 * hors couverture ou pixel de bord non classé). Millésime récent, repli sur le
 * précédent si la tuile n'est pas couverte ; null si aucun ne la couvre.
 */
export async function classesCosiaTuile(z: number, x: number, y: number): Promise<{ classes: Uint8Array; millesime: string } | null> {
  for (const m of MILLESIMES) {
    const url = IGN_WMTS.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)).replace("{layer}", `IGNF_COSIA_${m}`).replace("{format}", "image/png");
    const d = await pixels(url);
    if (!d) continue;
    const classes = new Uint8Array(256 * 256).fill(255);
    let n = 0;
    for (let k = 0; k < classes.length; k++) {
      const o = k * 4;
      if (d[o + 3] < 128) continue;
      let best = 0, bd = Infinity;
      for (let c = 0; c < RGB.length; c++) {
        const dr = d[o] - RGB[c][0], dg = d[o + 1] - RGB[c][1], db = d[o + 2] - RGB[c][2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bd) {
          bd = dist;
          best = c;
        }
      }
      if (bd <= MELANGE_MAX) {
        classes[k] = best;
        n++;
      }
    }
    if (n > 0) return { classes, millesime: m };
  }
  return null;
}

/**
 * Couverture du sol dans un cercle, ou dans un contour (périmètre de projet) :
 * `rayonM` est alors le rayon englobant du contour autour de (lat, lon).
 */
export async function analyserCosia(lat: number, lon: number, rayonM: number, contour?: MultiPolygone): Promise<CosiaResultat> {
  let dernier: CosiaResultat | null = null;
  for (const m of MILLESIMES) {
    const r = await analyserMillesime(lat, lon, rayonM, m, contour);
    if (r.couverturePct >= 80) return r;
    if (!dernier || r.couverturePct > dernier.couverturePct) dernier = r;
  }
  if (!dernier || dernier.couverturePct < 5) throw new Error("Zone non couverte par CoSIA");
  return dernier;
}

// --- Indicateurs dérivés ---------------------------------------------------------------

/** Coefficients du coefficient de biotope par surface (CBS), valeurs usuelles (guides ADEME, PLU). */
export const COEF_CBS: Record<ClasseCosia, number | null> = {
  batiment: 0, impermeable: 0, piscine: 0, serre: 0,
  permeable: 0.5, // surfaces semi-ouvertes (gravier, stabilisé, dalles)
  solnu: 1, labour: 1, coupe: 1, pelouse: 1, culture: 1, vigne: 1, broussaille: 1, feuillu: 1, conifere: 1,
  eau: null, neige: null, autre: null, // hors calcul
};

export interface IndicateursSol {
  /** Surface terrestre retenue (hors eau, neige, autre) (m²). */
  terreM2: number;
  impermeabilisePct: number;
  semiPermeablePct: number;
  pleineTerrePct: number;
  vegetalisePct: number;
  canopeePct: number;
  cbs: number;
}

export function indicateursSol(r: CosiaResultat): IndicateursSol {
  const s = r.surfaces;
  const terre = CLASSES_COSIA.reduce((a, c) => a + (COEF_CBS[c.id] === null ? 0 : s[c.id]), 0);
  const p = (v: number) => (terre > 0 ? Math.round((v / terre) * 1000) / 10 : 0);
  const somme = (ids: ClasseCosia[]) => ids.reduce((a, id) => a + s[id], 0);
  const cbs = terre > 0 ? CLASSES_COSIA.reduce((a, c) => a + (COEF_CBS[c.id] ?? 0) * s[c.id], 0) / terre : 0;
  return {
    terreM2: terre,
    impermeabilisePct: p(somme(["batiment", "impermeable", "piscine", "serre"])),
    semiPermeablePct: p(s.permeable),
    pleineTerrePct: p(somme(["solnu", "labour", "coupe", "pelouse", "culture", "vigne", "broussaille", "feuillu", "conifere"])),
    vegetalisePct: p(somme(["pelouse", "culture", "vigne", "broussaille", "feuillu", "conifere"])),
    canopeePct: p(somme(["feuillu", "conifere"])),
    cbs: Math.round(cbs * 100) / 100,
  };
}
