// Courbes de niveau autour du site, calculées dans le navigateur à partir des
// altitudes du RGE ALTI® (les mêmes tuiles que le relief 3D, zoom 15 : un
// point tous les 3 à 4 m environ en France métropolitaine) ou du LiDAR HD
// (MNT 50 cm, complété par le RGE ALTI hors couverture).
//
// Méthode : grille d'altitudes assemblée, lissée (deux passes de moyenne
// 3 × 3, pour gommer le bruit au mètre près sans déplacer les formes),
// puis « carrés marchants » pour chaque cote, segments chaînés en lignes.
// Équidistance choisie, ou automatique (une vingtaine de courbes au plus
// sur l'emprise). Une courbe sur cinq est maîtresse (plus épaisse, cotée).

import { altitudesMixtes, TAILLE_TUILE, type SourceAlt } from "./relief-dem";

// RGE ALTI : zoom 15 (≈ 3,5 m par point). LiDAR HD : plus fin quand l'emprise
// le permet (zoom 17 ≈ 0,9 m, 16 ≈ 1,7 m), avec un lissage plus appuyé contre le
// bruit au décimètre (murets, bordures, talus de voirie).
function zoomPour(source: SourceAlt, demiCoteM: number): number {
  if (source === "rgealti") return 15;
  return demiCoteM <= 500 ? 17 : demiCoteM <= 1000 ? 16 : 15;
}
const C = 20037508.342789244;
export const EQUIDISTANCES = [0.5, 1, 2, 5, 10, 20, 25, 50, 100];

type P = [number, number];

function versMerc(lon: number, lat: number): P {
  return [(lon * C) / 180, (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * C) / Math.PI];
}
function depuisMerc(x: number, y: number): P {
  return [(x / C) * 180, (Math.atan(Math.exp((y / C) * Math.PI)) * 360) / Math.PI - 90];
}

export interface Courbes {
  geojson: GeoJSON.FeatureCollection;
  equidistance: number;
  min: number;
  max: number;
  /** Tuiles d'altitudes non obtenues (courbes incomplètes). */
  manquantes: number;
  /** Part de l'emprise couverte par le LiDAR HD (0-1) ; 0 avec le RGE ALTI. */
  partLidar: number;
  /** Taille d'un point de la grille (m au sol). */
  pasM: number;
}

/** Équidistance automatique : la plus petite donnant au plus ~20 courbes. */
export function equidistanceAuto(min: number, max: number): number {
  const amplitude = Math.max(0.1, max - min);
  return EQUIDISTANCES.find((e) => amplitude / e <= 20) ?? 100;
}

export async function calculerCourbes(lat: number, lon: number, demiCoteM: number, equidistance: number | "auto", source: SourceAlt = "rgealti"): Promise<Courbes> {
  const ZOOM = zoomPour(source, demiCoteM);
  const [cx, cy] = versMerc(lon, lat);
  // Mètres Mercator par mètre au sol à cette latitude.
  const k = 1 / Math.cos((lat * Math.PI) / 180);
  const d = demiCoteM * k;
  const t = (2 * C) / 2 ** ZOOM;
  const x0 = Math.floor((cx - d + C) / t), x1 = Math.floor((cx + d + C) / t);
  const y0 = Math.floor((C - (cy + d)) / t), y1 = Math.floor((C - (cy - d)) / t);
  const nTx = x1 - x0 + 1, nTy = y1 - y0 + 1;
  const W = nTx * TAILLE_TUILE, H = nTy * TAILLE_TUILE;
  let z = new Float32Array(W * H);

  z.fill(NaN);
  let manquantes = 0;
  let lidar = 0;
  const tuiles: Promise<void>[] = [];
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++)
      tuiles.push(
        altitudesMixtes(ZOOM, tx, ty, source).then(({ alt: a, lidar: l }) => {
          lidar += l;
          const ox = (tx - x0) * TAILLE_TUILE, oy = (ty - y0) * TAILLE_TUILE;
          for (let j = 0; j < TAILLE_TUILE; j++)
            for (let i = 0; i < TAILLE_TUILE; i++) {
              const v = a[j * TAILLE_TUILE + i];
              z[(oy + j) * W + ox + i] = Number.isFinite(v) && v > -1000 && v < 9000 ? v : NaN;
            }
        }, () => {
          manquantes++; // une tuile refusée : on trace le reste plutôt que rien
        }),
      );
  await Promise.all(tuiles);
  if (manquantes === tuiles.length) throw new Error("Altitudes IGN indisponibles");

  // Lissage : deux passes de moyenne 3 × 3 (les valeurs manquantes sont ignorées).
  const passes = ZOOM >= 17 ? 4 : ZOOM === 16 ? 3 : 2;
  const partLidar = lidar / tuiles.length;
  const pasM = (2 * C) / 2 ** ZOOM / TAILLE_TUILE / k;
  for (let passe = 0; passe < passes; passe++) {
    const s = new Float32Array(W * H);
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        let somme = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
            const v = z[jj * W + ii];
            if (!Number.isNaN(v)) {
              somme += v;
              n++;
            }
          }
        s[j * W + i] = n ? somme / n : NaN;
      }
    z = s;
  }

  // Emprise utile (carré autour du site) en indices de grille.
  const pxM = t / TAILLE_TUILE; // mètres Mercator par pixel
  const gx0 = -C + x0 * t, gy0 = C - y0 * t; // coin nord-ouest de la grille
  const iMin = Math.max(0, Math.floor((cx - d - gx0) / pxM)), iMax = Math.min(W - 1, Math.ceil((cx + d - gx0) / pxM));
  const jMin = Math.max(0, Math.floor((gy0 - (cy + d)) / pxM)), jMax = Math.min(H - 1, Math.ceil((gy0 - (cy - d)) / pxM));

  let min = Infinity, max = -Infinity;
  for (let j = jMin; j <= jMax; j++)
    for (let i = iMin; i <= iMax; i++) {
      const v = z[j * W + i];
      if (Number.isNaN(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  if (!Number.isFinite(min)) return { geojson: { type: "FeatureCollection", features: [] }, equidistance: 0, min: 0, max: 0, manquantes, partLidar, pasM };
  const eq = equidistance === "auto" ? equidistanceAuto(min, max) : equidistance;

  // Point d'une arête : centre de pixel (i + 0,5, j + 0,5) en Mercator, puis lon/lat.
  const versLL = (i: number, j: number): P => depuisMerc(gx0 + (i + 0.5) * pxM, gy0 - (j + 0.5) * pxM);
  const features: GeoJSON.Feature[] = [];
  const premiere = Math.ceil(min / eq) * eq;
  for (let niveau = premiere; niveau <= max; niveau += eq) {
    const h = Math.round(niveau * 100) / 100;
    for (const ligne of isolignes(z, W, iMin, iMax, jMin, jMax, h)) {
      if (ligne.length < 4) continue; // bribes de bruit
      const maitresse = Math.abs(Math.round(h / (eq * 5)) * eq * 5 - h) < 1e-6;
      features.push({
        type: "Feature",
        properties: { z: h, maitresse, label: `${Number.isInteger(h) ? h : h.toLocaleString("fr-FR")} m` },
        geometry: { type: "LineString", coordinates: ligne.map(([i, j]) => versLL(i, j)) },
      });
    }
  }
  return { geojson: { type: "FeatureCollection", features }, equidistance: eq, min, max, manquantes, partLidar, pasM };
}

/** Carrés marchants : lignes de cote h, en coordonnées de grille (i, j). */
function isolignes(z: Float32Array, W: number, i0: number, i1: number, j0: number, j1: number, h: number): P[][] {
  // Arêtes identifiées par un entier : horizontale (i,j)→(i+1,j) = 2·(j·W+i), verticale (i,j)→(i,j+1) = 2·(j·W+i)+1.
  const pointArete = new Map<number, P>();
  const voisins = new Map<number, number[]>();
  const relier = (a: number, b: number) => {
    (voisins.get(a) ?? voisins.set(a, []).get(a)!).push(b);
    (voisins.get(b) ?? voisins.set(b, []).get(b)!).push(a);
  };
  const arete = (ia: number, ja: number, ib: number, jb: number): number => {
    const horiz = ja === jb;
    const id = 2 * (ja * W + ia) + (horiz ? 0 : 1);
    if (!pointArete.has(id)) {
      const va = z[ja * W + ia], vb = z[jb * W + ib];
      const f = (h - va) / (vb - va);
      pointArete.set(id, [ia + (ib - ia) * f, ja + (jb - ja) * f]);
    }
    return id;
  };
  for (let j = j0; j < j1; j++)
    for (let i = i0; i < i1; i++) {
      const a = z[j * W + i], b = z[j * W + i + 1], c = z[(j + 1) * W + i + 1], dd = z[(j + 1) * W + i];
      if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(dd)) continue;
      const cas = (a >= h ? 8 : 0) | (b >= h ? 4 : 0) | (c >= h ? 2 : 0) | (dd >= h ? 1 : 0);
      if (cas === 0 || cas === 15) continue;
      const haut = () => arete(i, j, i + 1, j);
      const droite = () => arete(i + 1, j, i + 1, j + 1);
      const bas = () => arete(i, j + 1, i + 1, j + 1);
      const gauche = () => arete(i, j, i, j + 1);
      switch (cas) {
        case 1: case 14: relier(gauche(), bas()); break;
        case 2: case 13: relier(bas(), droite()); break;
        case 3: case 12: relier(gauche(), droite()); break;
        case 4: case 11: relier(haut(), droite()); break;
        case 6: case 9: relier(haut(), bas()); break;
        case 7: case 8: relier(gauche(), haut()); break;
        case 5: case 10: {
          // Col : on tranche avec la moyenne des quatre coins.
          const centre = (a + b + c + dd) / 4 >= h;
          if ((cas === 5) === centre) {
            relier(gauche(), haut());
            relier(bas(), droite());
          } else {
            relier(gauche(), bas());
            relier(haut(), droite());
          }
          break;
        }
      }
    }
  // Chaînage des segments en lignes.
  const vu = new Set<number>();
  const lignes: P[][] = [];
  const parcourir = (depart: number) => {
    const ligne: P[] = [pointArete.get(depart)!];
    vu.add(depart);
    let courant = depart;
    for (;;) {
      const suivant = (voisins.get(courant) ?? []).find((v) => !vu.has(v));
      if (suivant === undefined) break;
      vu.add(suivant);
      ligne.push(pointArete.get(suivant)!);
      courant = suivant;
    }
    return ligne;
  };
  // D'abord les extrémités (lignes ouvertes), puis les boucles.
  for (const [id, v] of voisins) if (v.length === 1 && !vu.has(id)) lignes.push(parcourir(id));
  for (const id of voisins.keys())
    if (!vu.has(id)) {
      const l = parcourir(id);
      l.push(l[0]);
      lignes.push(l);
    }
  return lignes;
}
