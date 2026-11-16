// Heures de soleil cumulées au sol sur une journée, dans le périmètre.
//
// Méthode : le sol est découpé en cellules carrées ; pour chaque pas de temps
// (soleil levé), l'ombre de chaque bâtiment (même géométrie que la couche
// « Ombres portées » : prisme droit sur sol plat) est rastérisée sur la
// grille ; une cellule hors de toute ombre reçoit la durée du pas. Les
// cellules sous un bâtiment (toitures) sont exclues.
//
// Limites : sol plat, toits plats, arbres et relief ignorés (le relief est
// dans le module Soleil), ciel clair (pas de nuages).

import { DEFAULT_HEIGHT_M, MAX_SHADOW_M, type ShadowBuilding } from "./shadows";

type XY = [number, number];

export interface PasSoleil {
  azimuthDeg: number;
  elevationDeg: number;
  /** Durée représentée par le pas (h). */
  dureeH: number;
}

export interface CarteEnsoleillement {
  /** Heures de soleil par cellule, ligne par ligne du nord au sud ; NaN sous un bâtiment ou hors périmètre. */
  heures: Float32Array;
  nx: number;
  ny: number;
  /** Taille d'une cellule (m) et demi-côté de la grille (m), centrée sur le site. */
  cellule: number;
  demiCote: number;
  /** Durée du jour (h, soleil levé). */
  jourH: number;
}

const M_PAR_DEG_LAT = 110_540;

/** Remplit les cellules dont le centre est dans le polygone (règle pair-impair). */
function rasteriser(poly: XY[], nx: number, ny: number, c: number, demi: number, marquer: (i: number) => void): void {
  let ymin = Infinity, ymax = -Infinity;
  for (const [, y] of poly) {
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  // Ligne j : centre à y = demi − (j + 0,5)·c (ligne 0 au nord).
  const j0 = Math.max(0, Math.ceil((demi - ymax) / c - 0.5));
  const j1 = Math.min(ny - 1, Math.floor((demi - ymin) / c - 0.5));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const yc = demi - (j + 0.5) * c;
    xs.length = 0;
    for (let k = 0, n = poly.length, l = n - 1; k < n; l = k++) {
      const [xa, ya] = poly[k];
      const [xb, yb] = poly[l];
      if (ya > yc !== yb > yc) xs.push(xa + ((yc - ya) * (xb - xa)) / (yb - ya));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] + demi) / c - 0.5));
      const i1 = Math.min(nx - 1, Math.floor((xs[k + 1] + demi) / c - 0.5));
      for (let i = i0; i <= i1; i++) marquer(j * nx + i);
    }
  }
}

const croix = (o: XY, a: XY, b: XY) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function enveloppe(points: XY[]): XY[] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const bas: XY[] = [];
  for (const p of pts) {
    while (bas.length >= 2 && croix(bas[bas.length - 2], bas[bas.length - 1], p) <= 0) bas.pop();
    bas.push(p);
  }
  const haut: XY[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (haut.length >= 2 && croix(haut[haut.length - 2], haut[haut.length - 1], p) <= 0) haut.pop();
    haut.push(p);
  }
  return bas.slice(0, -1).concat(haut.slice(0, -1));
}
function convexe(p: XY[]): boolean {
  let signe = 0;
  for (let i = 0; i < p.length; i++) {
    const c = croix(p[i], p[(i + 1) % p.length], p[(i + 2) % p.length]);
    if (Math.abs(c) < 1e-9) continue;
    if (signe === 0) signe = Math.sign(c);
    else if (Math.sign(c) !== signe) return false;
  }
  return true;
}

export function calculerEnsoleillement(
  batiments: ShadowBuilding[],
  lat0: number,
  lon0: number,
  rayonM: number,
  pas: PasSoleil[],
  cellule = 2,
): CarteEnsoleillement {
  const mLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const demi = Math.ceil(rayonM / cellule) * cellule;
  const nx = Math.round((2 * demi) / cellule);
  const ny = nx;
  const n = nx * ny;
  const anneaux: { ring: XY[]; h: number }[] = batiments
    .map((b) => {
      let ring = b.ring.map(([lon, lat]) => [(lon - lon0) * mLon, (lat - lat0) * M_PAR_DEG_LAT] as XY);
      const d = ring[ring.length - 1];
      if (ring.length > 1 && d[0] === ring[0][0] && d[1] === ring[0][1]) ring = ring.slice(0, -1);
      return { ring, h: b.heightM ?? DEFAULT_HEIGHT_M };
    })
    .filter((b) => b.ring.length >= 3);

  // Cellules exclues : sous un bâtiment ou hors du cercle du périmètre.
  const exclue = new Uint8Array(n);
  for (const b of anneaux) rasteriser(b.ring, nx, ny, cellule, demi, (i) => (exclue[i] = 1));
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const x = -demi + (i + 0.5) * cellule;
      const y = demi - (j + 0.5) * cellule;
      if (x * x + y * y > rayonM * rayonM) exclue[j * nx + i] = 1;
    }

  const heures = new Float32Array(n);
  const ombre = new Int32Array(n).fill(-1);
  let jourH = 0;
  pas.forEach((p, k) => {
    if (p.elevationDeg <= 0.5) return;
    jourH += p.dureeH;
    const tan = Math.tan((p.elevationDeg * Math.PI) / 180);
    const az = (p.azimuthDeg * Math.PI) / 180;
    const ux = -Math.sin(az);
    const uy = -Math.cos(az);
    const marquer = (i: number) => (ombre[i] = k);
    for (const b of anneaux) {
      const L = Math.min(b.h / tan, MAX_SHADOW_M);
      const dx = ux * L;
      const dy = uy * L;
      const decale = b.ring.map(([x, y]) => [x + dx, y + dy] as XY);
      if (convexe(b.ring)) {
        rasteriser(enveloppe([...b.ring, ...decale]), nx, ny, cellule, demi, marquer);
      } else {
        // Forme concave : emprise décalée et quadrilatères balayés par chaque arête.
        rasteriser(decale, nx, ny, cellule, demi, marquer);
        for (let a = 0; a < b.ring.length; a++) {
          const p0 = b.ring[a];
          const p1 = b.ring[(a + 1) % b.ring.length];
          rasteriser([p0, p1, [p1[0] + dx, p1[1] + dy], [p0[0] + dx, p0[1] + dy]], nx, ny, cellule, demi, marquer);
        }
      }
    }
    for (let i = 0; i < n; i++) if (ombre[i] !== k) heures[i] += p.dureeH;
  });
  for (let i = 0; i < n; i++) if (exclue[i]) heures[i] = NaN;
  return { heures, nx, ny, cellule, demiCote: demi, jourH };
}
