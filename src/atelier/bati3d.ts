// Bâti en volume mesuré par le LiDAR HD : à l'intérieur de chaque emprise
// BD TOPO, le dessus suit la hauteur du sursol mesurée (MNH, 50 cm) : pentes
// et faîtages des toits, décrochés, attiques, édicules. Dessiné par three.js
// dans une couche MapLibre, comme les arbres et la canopée.
//
// Construction (grille du MNH, ≈ 0,4 à 0,9 m selon le rayon) :
//  - chaque pixel dont le centre tombe dans une emprise lui est rattaché
//    (contours BD TOPO saisis « à la gouttière » : contour du toit) ;
//  - pixels écartés (retours du 23/11, houppiers qui surplombent les toits) :
//    végétation selon CoSIA, pixels plus hauts que le faîtage BD TOPO + 1,5 m,
//    pixels de bord où le laser mêle toit et sol ; ils prennent la hauteur de
//    leurs voisins mesurés ;
//  - lissage médian 3 × 3 dans l'emprise (bruit des toits complexes) ;
//  - toit : surface continue passant par les coins des pixels (moyenne des
//    pixels voisins du même bâtiment) ;
//  - murs verticaux au bord de l'emprise, du sol au toit, et entre deux
//    bâtiments mitoyens, du toit le plus bas au plus haut.
// Un bâtiment trop peu couvert par le LiDAR (moins de 30 % des pixels) est
// extrudé à sa hauteur BD TOPO, toit plat. Végétation qui surplombe un toit :
// comptée dans sa hauteur (le LiDAR ne voit que le dessus).

import * as THREE from "three";
import maplibregl from "maplibre-gl";
import type { GrilleSursol } from "../core/sursol-lidar";

const C = 20037508.342789244;
/** Pixels de bâti au plus : au-delà, la grille est agrégée (2 × 2, 3 × 3…). */
const MAX_CELLULES = 400_000;
const PART_MIN_MESUREE = 0.3;

export interface BatimentPourVolume {
  /** Contour extérieur, [lon, lat]. */
  ring: [number, number][];
  /** Hauteur de repli (BD TOPO, ou valeur par défaut) quand le LiDAR manque. */
  hRepli: number;
  /** Faîtage BD TOPO au-dessus du sol (m) : plafond de plausibilité des mesures. */
  faitage?: number;
  couleur: number;
}

export interface BilanBati3D {
  batiments: number;
  mesures: number;
  pixelM: number;
  /** Pans de toit reconstruits (mode « pans plans »). */
  pans?: number;
}

/** « brut » : le dessus suit chaque pixel du LiDAR ; « plans » : toits reconstruits en pans plans. */
export type ModeBati3D = "brut" | "plans";

export interface CoucheBati3D extends maplibregl.CustomLayerInterface {
  setBati(grille: GrilleSursol | null, batiments: BatimentPourVolume[], lat0: number, lon0: number): BilanBati3D;
  setMode(m: ModeBati3D): BilanBati3D;
  /** Change les couleurs sans relire le LiDAR. */
  setCouleurs(couleurs: number[]): void;
  setSol(sol: ((lon: number, lat: number) => number | null) | null): void;
  setOpacite(o: number): void;
  setSoleil(s: { azimut: number; hauteur: number; couleur: number; intensite: number } | null): void;
}

const versMerc = (lon: number, lat: number): [number, number] => [(lon * C) / 180, (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * C) / Math.PI];

/** Pan de toit : plan h = h + a (x − cx) + b (z − cz), en mètres locaux. */
interface Pan {
  k: number;
  cx: number;
  cz: number;
  h: number;
  a: number;
  b: number;
  hmin: number;
  hmax: number;
}

/**
 * Découpe le toit de chaque bâtiment en pans plans (version simplifiée de la
 * méthode du 3D BAG, TU Delft) :
 *  1. plan local de chaque pixel (moindres carrés sur 5 × 5 pixels du bâtiment) ;
 *  2. croissance de régions depuis les pixels les plus plans : un voisin
 *     rejoint le pan s'il en est à moins de 35 cm et si sa pente locale est
 *     proche (moins de 12°) ; le plan du pan est recalculé à mesure ;
 *  3. pans de moins de 2,5 m² dissous dans le pan voisin qui les explique le mieux ;
 *  4. plan final de chaque pan ; pente sous 4° : toit plat ; au-delà de 65° : plat aussi
 *     (bord ou mur mal mesuré).
 */
function segmenterPans(
  W: number,
  H: number,
  idg: Int32Array,
  hc: Float32Array,
  cellules: number[][],
  xCol: Float64Array,
  zRow: Float64Array,
  pixelM: number,
): { idr: Int32Array; pans: Pan[]; nbPans: number } {
  const xc = (c: number) => (xCol[c % W] + xCol[(c % W) + 1]) / 2;
  const zc = (c: number) => {
    const j = Math.floor(c / W);
    return (zRow[j] + zRow[j + 1]) / 2;
  };
  const idr = new Int32Array(W * H).fill(-1);
  const pans: Pan[] = [];
  let nbPans = 0;
  const TOL_H = 0.35;
  const COS_MAX = Math.cos((12 * Math.PI) / 180);
  const minCellules = Math.max(3, Math.round(4 / (pixelM * pixelM)));
  /** Écart quadratique moyen toléré quand on fusionne deux pans (bruit du LiDAR sur des tuiles). */
  const RMS_FUSION = 0.18;
  const COS_FUSION = Math.cos((10 * Math.PI) / 180);
  const TAN_PLAT = Math.tan((4 * Math.PI) / 180), TAN_MUR = Math.tan((65 * Math.PI) / 180);

  /** Plan par moindres carrés (centré) sur une liste de pixels. */
  const ajuster = (cs: number[]): { cx: number; cz: number; h: number; a: number; b: number; rms: number } => {
    let sx = 0, sz = 0, sh = 0;
    for (const c of cs) {
      sx += xc(c);
      sz += zc(c);
      sh += hc[c];
    }
    const n = cs.length, cx = sx / n, cz = sz / n, h = sh / n;
    let xx = 0, xz = 0, zz = 0, xh = 0, zh = 0;
    for (const c of cs) {
      const dx = xc(c) - cx, dz = zc(c) - cz, dh = hc[c] - h;
      xx += dx * dx;
      xz += dx * dz;
      zz += dz * dz;
      xh += dx * dh;
      zh += dz * dh;
    }
    const det = xx * zz - xz * xz;
    let a = 0, b = 0;
    if (n >= 4 && Math.abs(det) > 1e-9) {
      a = (xh * zz - zh * xz) / det;
      b = (zh * xx - xh * xz) / det;
    }
    let e = 0;
    for (const c of cs) e += (hc[c] - (h + a * (xc(c) - cx) + b * (zc(c) - cz))) ** 2;
    return { cx, cz, h, a, b, rms: Math.sqrt(e / n) };
  };
  const cosNormales = (a1: number, b1: number, a2: number, b2: number) =>
    (a1 * a2 + b1 * b2 + 1) / Math.sqrt((a1 * a1 + b1 * b1 + 1) * (a2 * a2 + b2 * b2 + 1));

  cellules.forEach((cs, k) => {
    if (!cs.length) return;
    // 1. Plans locaux.
    const local = new Map<number, { a: number; b: number; rms: number }>();
    for (const c of cs) {
      const i = c % W, j = (c - i) / W;
      const v: number[] = [];
      for (let dj = -2; dj <= 2; dj++)
        for (let di = -2; di <= 2; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
          const cc = jj * W + ii;
          if (idg[cc] === k) v.push(cc);
        }
      const p = v.length >= 6 ? ajuster(v) : { a: 0, b: 0, rms: 9 };
      local.set(c, { a: p.a, b: p.b, rms: p.rms });
    }
    // 2. Croissance de régions.
    const debut = pans.length;
    const membres: number[][] = [];
    const graines = [...cs].sort((p, q) => local.get(p)!.rms - local.get(q)!.rms);
    for (const s0 of graines) {
      if (idr[s0] !== -1) continue;
      const r = pans.length;
      const l0 = local.get(s0)!;
      let plan = { cx: xc(s0), cz: zc(s0), h: hc[s0], a: l0.a, b: l0.b };
      const m: number[] = [s0];
      idr[s0] = r;
      let prochainAjustement = 8;
      for (let q = 0; q < m.length; q++) {
        const c = m[q], i = c % W, j = (c - i) / W;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
          const cc = jj * W + ii;
          if (idg[cc] !== k || idr[cc] !== -1) continue;
          const lc = local.get(cc)!;
          const ecart = Math.abs(hc[cc] - (plan.h + plan.a * (xc(cc) - plan.cx) + plan.b * (zc(cc) - plan.cz)));
          if (ecart > TOL_H || cosNormales(lc.a, lc.b, plan.a, plan.b) < COS_MAX) continue;
          idr[cc] = r;
          m.push(cc);
          if (m.length >= prochainAjustement) {
            plan = ajuster(m);
            prochainAjustement *= 2;
          }
        }
      }
      pans.push({ k, ...plan, hmin: 0, hmax: 0 });
      membres.push(m);
    }
    // 3. Petits pans dissous dans le voisin qui les explique le mieux.
    const petit = (r: number) => membres[r - debut].length < minCellules;
    let orphelins: number[] = [];
    for (let r = debut; r < pans.length; r++) if (petit(r)) for (const c of membres[r - debut]) {
      idr[c] = -2;
      orphelins.push(c);
    }
    for (let tour = 0; tour < 50 && orphelins.length; tour++) {
      const reste: number[] = [];
      const pris: [number, number][] = [];
      for (const c of orphelins) {
        const i = c % W, j = (c - i) / W;
        let best = -1, be = Infinity;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
          const r = idr[jj * W + ii];
          if (r < debut || idg[jj * W + ii] !== k) continue;
          const q = pans[r];
          const e = Math.abs(hc[c] - (q.h + q.a * (xc(c) - q.cx) + q.b * (zc(c) - q.cz)));
          if (e < be) {
            be = e;
            best = r;
          }
        }
        if (best >= 0) pris.push([c, best]);
        else reste.push(c);
      }
      if (!pris.length) break;
      for (const [c, r] of pris) idr[c] = r;
      orphelins = reste;
    }
    // Bâtiment sans grand pan (très petit) : un seul pan.
    if (orphelins.length) {
      const r = membres.findIndex((_, n) => !petit(debut + n));
      for (const c of orphelins) idr[c] = r >= 0 ? debut + r : debut;
    }
    // 3 bis. Fusion des pans voisins qui tiennent dans un même plan (moments
    // cumulés : le plan de l'union se calcule sans repasser sur les pixels).
    // Retours du 23/11 : toits de tuiles découpés en gradins.
    type Mom = { n: number; x: number; z: number; h: number; xx: number; xz: number; zz: number; xh: number; zh: number; hh: number };
    const ox = xc(cs[0]), oz = zc(cs[0]);
    const mom = new Map<number, Mom>();
    for (const c of cs) {
      const r = idr[c];
      let m = mom.get(r);
      if (!m) mom.set(r, (m = { n: 0, x: 0, z: 0, h: 0, xx: 0, xz: 0, zz: 0, xh: 0, zh: 0, hh: 0 }));
      const x = xc(c) - ox, z = zc(c) - oz, h = hc[c];
      m.n++; m.x += x; m.z += z; m.h += h; m.xx += x * x; m.xz += x * z; m.zz += z * z; m.xh += x * h; m.zh += z * h; m.hh += h * h;
    }
    const plan = (m: Mom) => {
      const mx = m.x / m.n, mz = m.z / m.n, mh = m.h / m.n;
      const cxx = m.xx / m.n - mx * mx, cxz = m.xz / m.n - mx * mz, czz = m.zz / m.n - mz * mz;
      const cxh = m.xh / m.n - mx * mh, czh = m.zh / m.n - mz * mh, chh = m.hh / m.n - mh * mh;
      const det = cxx * czz - cxz * cxz;
      let a = 0, b = 0;
      if (m.n >= 4 && det > 1e-9) {
        a = (cxh * czz - czh * cxz) / det;
        b = (czh * cxx - cxh * cxz) / det;
      }
      return { a, b, rms: Math.sqrt(Math.max(0, chh - a * cxh - b * czh)) };
    };
    const somme = (p: Mom, q: Mom): Mom => ({ n: p.n + q.n, x: p.x + q.x, z: p.z + q.z, h: p.h + q.h, xx: p.xx + q.xx, xz: p.xz + q.xz, zz: p.zz + q.zz, xh: p.xh + q.xh, zh: p.zh + q.zh, hh: p.hh + q.hh });
    for (let tour = 0; tour < 30; tour++) {
      const paires = new Set<number>();
      for (const c of cs) {
        const i = c % W;
        for (const cc of [i + 1 < W ? c + 1 : -1, c + W < W * H ? c + W : -1]) {
          if (cc < 0 || idg[cc] !== k || idr[cc] === idr[c]) continue;
          const r1 = Math.min(idr[c], idr[cc]), r2 = Math.max(idr[c], idr[cc]);
          paires.add(r1 * 1_000_000 + r2);
        }
      }
      const candidats: [number, number, number][] = [];
      for (const cle of paires) {
        const r1 = Math.floor(cle / 1_000_000), r2 = cle % 1_000_000;
        const m1 = mom.get(r1)!, m2 = mom.get(r2)!;
        const p1 = plan(m1), p2 = plan(m2);
        if (cosNormales(p1.a, p1.b, p2.a, p2.b) < COS_FUSION) continue;
        const u = plan(somme(m1, m2));
        if (u.rms < RMS_FUSION) candidats.push([u.rms, r1, r2]);
      }
      if (!candidats.length) break;
      candidats.sort((p, q) => p[0] - q[0]);
      const pris = new Set<number>();
      const vers = new Map<number, number>();
      for (const [, r1, r2] of candidats) {
        if (pris.has(r1) || pris.has(r2)) continue;
        pris.add(r1);
        pris.add(r2);
        vers.set(r2, r1);
        mom.set(r1, somme(mom.get(r1)!, mom.get(r2)!));
        mom.delete(r2);
      }
      for (const c of cs) {
        const r = vers.get(idr[c]);
        if (r !== undefined) idr[c] = r;
      }
    }
    // 3 ter. Limites des pans régularisées : un pixel entouré (5 voisins sur 8 au
    // moins) d'un autre pan qui l'explique aussi bien rejoint ce pan.
    for (let passe = 0; passe < 2; passe++) {
      const change: [number, number][] = [];
      for (const c of cs) {
        const i = c % W, j = (c - i) / W;
        const compte = new Map<number, number>();
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
            const cc = jj * W + ii;
            if (idg[cc] === k && idr[cc] !== idr[c]) compte.set(idr[cc], (compte.get(idr[cc]) ?? 0) + 1);
          }
        for (const [r, n] of compte)
          if (n >= 5) {
            const m = mom.get(r)!, p = plan(m);
            const hx = m.h / m.n + p.a * (xc(c) - ox - m.x / m.n) + p.b * (zc(c) - oz - m.z / m.n);
            if (Math.abs(hc[c] - hx) < 0.5) change.push([c, r]);
            break;
          }
      }
      for (const [c, r] of change) idr[c] = r;
    }
    // 4. Plans finaux.
    const finaux = new Map<number, number[]>();
    for (const c of cs) {
      const r = idr[c];
      if (!finaux.has(r)) finaux.set(r, []);
      finaux.get(r)!.push(c);
    }
    nbPans += finaux.size;
    for (const [r, m] of finaux) {
      const p = ajuster(m);
      const pente = Math.hypot(p.a, p.b);
      let hmin = Infinity, hmax = -Infinity;
      for (const c of m) {
        hmin = Math.min(hmin, hc[c]);
        hmax = Math.max(hmax, hc[c]);
      }
      if (pente < TAN_PLAT || pente > TAN_MUR) pans[r] = { k, cx: p.cx, cz: p.cz, h: p.h, a: 0, b: 0, hmin, hmax };
      else pans[r] = { k, cx: p.cx, cz: p.cz, h: p.h, a: p.a, b: p.b, hmin, hmax };
    }
  });
  return { idr, pans, nbPans };
}

export function creerCoucheBati3D(id: string): CoucheBati3D {
  let map: maplibregl.Map | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const ciel = new THREE.HemisphereLight(0xf2f0ea, 0x6a6458, 1.05);
  const soleil = new THREE.DirectionalLight(0xfff4e0, 1.2);
  soleil.position.set(-60, 120, 80);
  scene.add(ciel, soleil);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true, side: THREE.DoubleSide });
  let mesh: THREE.Mesh | null = null;
  let donnees: { g: GrilleSursol; bats: BatimentPourVolume[]; lat0: number; lon0: number } | null = null;
  let sol: ((lon: number, lat: number) => number | null) | null = null;
  let origine = maplibregl.MercatorCoordinate.fromLngLat([0, 0], 0);
  let echelle = 1;
  let bilan: BilanBati3D = { batiments: 0, mesures: 0, pixelM: 0 };
  let mode: ModeBati3D = "brut";

  function construire(): void {
    if (mesh) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mesh = null;
    }
    if (!donnees) return;
    const { g, bats, lat0, lon0 } = donnees;
    origine = maplibregl.MercatorCoordinate.fromLngLat([lon0, lat0], 0);
    echelle = origine.meterInMercatorCoordinateUnits();
    const mLat = 110_540, mLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);

    // Emprises en mètres Mercator, et surface totale pour choisir l'agrégation.
    const anneaux = bats.map((b) => b.ring.map(([lo, la]) => versMerc(lo, la)));
    let aire = 0;
    for (const r of anneaux) {
      let s = 0;
      for (let k = 0; k < r.length; k++) {
        const [x1, y1] = r[k], [x2, y2] = r[(k + 1) % r.length];
        s += x1 * y2 - x2 * y1;
      }
      aire += Math.abs(s) / 2;
    }
    const f = Math.max(1, Math.ceil(Math.sqrt(aire / (g.pxMerc * g.pxMerc) / MAX_CELLULES)));
    const px = g.pxMerc * f;
    const W = Math.ceil(g.largeur / f), H = Math.ceil(g.hauteur / f);

    // Hauteurs agrégées (moyenne des pixels mesurés hors végétation CoSIA).
    const hg = new Float32Array(W * H).fill(NaN);
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        let t = 0, n = 0;
        for (let dj = 0; dj < f; dj++)
          for (let di = 0; di < f; di++) {
            const jj = j * f + dj, ii = i * f + di;
            if (jj >= g.hauteur || ii >= g.largeur) continue;
            const gg = jj * g.largeur + ii;
            const v = g.h[gg];
            if (g.veg[gg]) continue;
            if (Number.isFinite(v)) {
              t += v;
              n++;
            }
          }
        if (n) hg[j * W + i] = t / n;
      }

    // Rattachement des pixels aux bâtiments (centre du pixel dans l'emprise).
    const idg = new Int32Array(W * H).fill(-1);
    anneaux.forEach((r, k) => {
      const pts = r.map(([x, y]) => [(x - g.x0) / px, (g.y0 - y) / px]);
      let jmin = Infinity, jmax = -Infinity;
      for (const [, y] of pts) {
        jmin = Math.min(jmin, y);
        jmax = Math.max(jmax, y);
      }
      for (let j = Math.max(0, Math.floor(jmin)); j <= Math.min(H - 1, Math.ceil(jmax)); j++) {
        const yc = j + 0.5;
        const xs: number[] = [];
        for (let a = 0; a < pts.length; a++) {
          const [xa, ya] = pts[a], [xb, yb] = pts[(a + 1) % pts.length];
          if ((ya <= yc && yb > yc) || (yb <= yc && ya > yc)) xs.push(xa + ((yc - ya) / (yb - ya)) * (xb - xa));
        }
        xs.sort((p, q) => p - q);
        for (let s = 0; s + 1 < xs.length; s += 2)
          for (let i = Math.max(0, Math.ceil(xs[s] - 0.5)); i <= Math.min(W - 1, Math.floor(xs[s + 1] - 0.5)); i++) idg[j * W + i] = k;
      }
    });

    // Hauteur retenue par pixel : LiDAR, ou médiane du bâtiment (bords mêlés, trous).
    const cellules: number[][] = bats.map(() => []);
    for (let c = 0; c < W * H; c++) if (idg[c] >= 0) cellules[idg[c]].push(c);
    const hc = new Float32Array(W * H);
    let mesures = 0;
    cellules.forEach((cs, k) => {
      if (!cs.length) return;
      // Plafond : faîtage BD TOPO + 1,5 m (au-delà : arbre, antenne, grue).
      const plafond = bats[k].faitage !== undefined ? bats[k].faitage! + 1.5 : Infinity;
      for (const c of cs) if (hg[c] > plafond) hg[c] = NaN;
      const vals = cs.map((c) => hg[c]).filter((v) => Number.isFinite(v) && v > 0.5).sort((a, b) => a - b);
      if (vals.length < PART_MIN_MESUREE * cs.length) {
        for (const c of cs) hc[c] = bats[k].hRepli;
        return;
      }
      mesures++;
      const med = vals[Math.floor(vals.length / 2)];
      const p90 = vals[Math.floor(vals.length * 0.9)];
      const seuil = Math.max(2, 0.35 * p90);
      // Pixels de bord (toit et sol mêlés) ou sans mesure : hauteur des voisins
      // mesurés du même bâtiment, de proche en proche (l'égout d'un toit en
      // pente garde sa hauteur) ; la médiane seulement en dernier recours.
      let manque: number[] = [];
      for (const c of cs) {
        const v = hg[c];
        if (Number.isFinite(v) && v >= seuil) hc[c] = v;
        else {
          hc[c] = NaN;
          manque.push(c);
        }
      }
      for (let passe = 0; passe < 4 && manque.length; passe++) {
        const pris: [number, number][] = [];
        const reste: number[] = [];
        for (const c of manque) {
          const i = c % W, j = (c - i) / W;
          let t = 0, n = 0;
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
            const cc = jj * W + ii;
            if (idg[cc] === k && Number.isFinite(hc[cc])) {
              t += hc[cc];
              n++;
            }
          }
          if (n) pris.push([c, t / n]);
          else reste.push(c);
        }
        for (const [c, v] of pris) hc[c] = v;
        manque = reste;
      }
      for (const c of manque) hc[c] = med;
      // Lissage médian 3 × 3 restreint au bâtiment : enlève le bruit sans arrondir les faîtages.
      const lisse = new Map<number, number>();
      for (const c of cs) {
        const i = c % W, j = (c - i) / W;
        const v: number[] = [];
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
            const cc = jj * W + ii;
            if (idg[cc] === k) v.push(hc[cc]);
          }
        v.sort((a, b) => a - b);
        lisse.set(c, v[Math.floor(v.length / 2)]);
      }
      for (const [c, v] of lisse) hc[c] = v;
    });
    bilan = { batiments: cellules.filter((cs) => cs.length).length, mesures, pixelM: g.pixelM * f };

    // Coordonnées locales des coins de pixels.
    const xCol = new Float64Array(W + 1), zRow = new Float64Array(H + 1);
    for (let i = 0; i <= W; i++) xCol[i] = (((g.x0 + i * px) / C) * 180 - lon0) * mLon;
    for (let j = 0; j <= H; j++) zRow[j] = -(((Math.atan(Math.exp(((g.y0 - j * px) / C) * Math.PI)) * 360) / Math.PI - 90) - lat0) * mLat;

    // Unités du maillage : le bâtiment entier (LiDAR brut) ou chacun de ses pans (pans plans).
    let idm: Int32Array = idg;
    let batDe = (u: number) => u;
    let hauteurPlan: ((u: number, x: number, z: number) => number) | null = null;
    if (mode === "plans") {
      const seg = segmenterPans(W, H, idg, hc, cellules, xCol, zRow, g.pixelM * f);
      idm = seg.idr;
      batDe = (u) => seg.pans[u].k;
      hauteurPlan = (u, x, z) => {
        const q = seg.pans[u];
        return Math.max(q.hmin - 0.3, Math.min(q.hmax + 0.3, q.h + q.a * (x - q.cx) + q.b * (z - q.cz)));
      };
      bilan.pans = seg.nbPans;
    }

    // Sol de chaque bâtiment : sous le centre pour le toit, le plus bas des coins pour le pied des murs.
    const solToit = new Float32Array(bats.length), solPied = new Float32Array(bats.length);
    const lireSol = sol;
    if (lireSol)
      bats.forEach((b, k) => {
        if (!cellules[k].length) return;
        let lo0 = Infinity, lo1 = -Infinity, la0 = Infinity, la1 = -Infinity;
        for (const [lo, la] of b.ring) {
          lo0 = Math.min(lo0, lo);
          lo1 = Math.max(lo1, lo);
          la0 = Math.min(la0, la);
          la1 = Math.max(la1, la);
        }
        const centre = lireSol((lo0 + lo1) / 2, (la0 + la1) / 2) ?? 0;
        const coins = [lireSol(lo0, la0), lireSol(lo1, la0), lireSol(lo0, la1), lireSol(lo1, la1)].map((v) => v ?? centre);
        solToit[k] = centre;
        solPied[k] = Math.min(centre, ...coins) - 0.3;
      });

    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    const couleurs = bats.map((b) => new THREE.Color(b.couleur));
    // Sommets du toit : un par coin et par unité (bâtiment ou pan).
    const vIdx = new Int32Array((W + 1) * (H + 1)).fill(-1), vProp = new Int32Array((W + 1) * (H + 1)).fill(-1);
    const vAutres = new Map<number, number>();
    const hauteurCoin = (ci: number, cj: number, u: number) => {
      let t = 0, n = 0;
      for (const [i, j] of [[ci - 1, cj - 1], [ci, cj - 1], [ci - 1, cj], [ci, cj]]) {
        if (i < 0 || j < 0 || i >= W || j >= H) continue;
        const c = j * W + i;
        if (idm[c] === u) {
          t += hc[c];
          n++;
        }
      }
      return n ? t / n : bats[batDe(u)].hRepli;
    };
    // Contours en mètres locaux : les sommets du bord sont recalés sur le
    // contour BD TOPO (retours du 23/11 : façades en biais en escalier).
    const contours = bats.map((b) => b.ring.map(([lo, la]) => [(lo - lon0) * mLon, -(la - lat0) * mLat] as [number, number]));
    const auBord = (ci: number, cj: number, k: number) => {
      for (const [i, j] of [[ci - 1, cj - 1], [ci, cj - 1], [ci - 1, cj], [ci, cj]])
        if (i < 0 || j < 0 || i >= W || j >= H || idg[j * W + i] !== k) return true;
      return false;
    };
    const recaler = (x: number, z: number, k: number): [number, number] => {
      const r = contours[k];
      let bx = x, bz = z, bd = Infinity;
      for (let a = 0; a < r.length; a++) {
        const [x1, z1] = r[a], [x2, z2] = r[(a + 1) % r.length];
        const dx = x2 - x1, dz = z2 - z1, l2 = dx * dx + dz * dz;
        const t = l2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / l2)) : 0;
        const px = x1 + t * dx, pz = z1 + t * dz, d = (px - x) ** 2 + (pz - z) ** 2;
        if (d < bd) {
          bd = d;
          bx = px;
          bz = pz;
        }
      }
      return [bx, bz];
    };
    const sommet = (ci: number, cj: number, u: number): number => {
      const c = cj * (W + 1) + ci;
      if (vProp[c] === u) return vIdx[c];
      const cle = c * 1_000_000 + u;
      if (vProp[c] !== -1) {
        const v = vAutres.get(cle);
        if (v !== undefined) return v;
      }
      const k = batDe(u);
      const v = pos.length / 3;
      const [x, z] = auBord(ci, cj, k) ? recaler(xCol[ci], zRow[cj], k) : [xCol[ci], zRow[cj]];
      pos.push(x, solToit[k] + (hauteurPlan ? hauteurPlan(u, x, z) : hauteurCoin(ci, cj, u)), z);
      const co = couleurs[k];
      col.push(co.r, co.g, co.b);
      if (vProp[c] === -1) {
        vProp[c] = u;
        vIdx[c] = v;
      } else vAutres.set(cle, v);
      return v;
    };
    const ombreMur = 0.86;
    // Entre deux pans d'un même bâtiment, une marche sous 15 cm est un raccord de faîtage, pas un mur.
    const marcheMin = mode === "plans" ? 0.15 : 0.05;
    const mur = (ci0: number, cj0: number, ci1: number, cj1: number, u: number, m: number) => {
      const sa = sommet(ci0, cj0, u), sb = sommet(ci1, cj1, u);
      const ha = pos[sa * 3 + 1], hb = pos[sb * 3 + 1];
      const xa = pos[sa * 3], za = pos[sa * 3 + 2], xb = pos[sb * 3], zb = pos[sb * 3 + 2];
      // Segment réduit à un point par le recalage (marche d'escalier absorbée) : pas de mur.
      if ((xa - xb) ** 2 + (za - zb) ** 2 < 1e-4) return;
      const k = batDe(u);
      let ba: number, bb: number;
      if (m < 0) ba = bb = solPied[k];
      else {
        ba = pos[sommet(ci0, cj0, m) * 3 + 1];
        bb = pos[sommet(ci1, cj1, m) * 3 + 1];
      }
      const seuil = m >= 0 && batDe(m) === k ? marcheMin : 0.05;
      if (ha <= ba + seuil && hb <= bb + seuil) return;
      ba = Math.min(ba, ha);
      bb = Math.min(bb, hb);
      const v = pos.length / 3;
      pos.push(xa, ba, za, xb, bb, zb, xb, hb, zb, xa, ha, za);
      const co = couleurs[k];
      for (let n = 0; n < 4; n++) col.push(co.r * ombreMur, co.g * ombreMur, co.b * ombreMur);
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    };
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const u = idm[j * W + i];
        if (u < 0) continue;
        const a = sommet(i, j, u), b = sommet(i + 1, j, u), c = sommet(i, j + 1, u), d = sommet(i + 1, j + 1, u);
        idx.push(a, c, b, b, c, d);
        const voisin = (ii: number, jj: number) => (ii < 0 || jj < 0 || ii >= W || jj >= H ? -1 : idm[jj * W + ii]);
        const g0 = voisin(i - 1, j), g1 = voisin(i + 1, j), g2 = voisin(i, j - 1), g3 = voisin(i, j + 1);
        if (g0 !== u) mur(i, j, i, j + 1, u, g0);
        if (g1 !== u) mur(i + 1, j, i + 1, j + 1, u, g1);
        if (g2 !== u) mur(i, j, i + 1, j, u, g2);
        if (g3 !== u) mur(i, j + 1, i + 1, j + 1, u, g3);
      }
    if (!idx.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
  }

  const couche: CoucheBati3D = {
    id,
    type: "custom",
    renderingMode: "3d",
    onAdd(m, gl) {
      map = m;
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl as WebGLRenderingContext, antialias: true });
      renderer.autoClear = false;
      construire(); // ré-ajout après une perte du contexte WebGL
    },
    render(_gl, args) {
      if (!renderer || !mesh) return;
      const modele = new THREE.Matrix4()
        .makeTranslation(origine.x, origine.y, origine.z)
        .scale(new THREE.Vector3(echelle, -echelle, echelle))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      camera.projectionMatrix = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]).multiply(modele);
      renderer.resetState();
      // Fenêtre de rendu recalée sur la toile à chaque image : three.js retient
      // la taille de la toile à sa création, fausse après un redimensionnement
      // ou un changement de résolution (export de la vue 3D).
      const glc = renderer.getContext();
      renderer.setViewport(0, 0, glc.drawingBufferWidth, glc.drawingBufferHeight);
      renderer.render(scene, camera);
    },
    onRemove() {
      mesh?.geometry.dispose();
      renderer?.dispose();
      renderer = null;
    },
    setBati(grille, batiments, lat0, lon0) {
      donnees = grille ? { g: grille, bats: batiments, lat0, lon0 } : null;
      construire();
      map?.triggerRepaint();
      return bilan;
    },
    setMode(m) {
      if (m !== mode) {
        mode = m;
        construire();
        map?.triggerRepaint();
      }
      return bilan;
    },
    setCouleurs(couleurs) {
      if (!donnees) return;
      donnees.bats = donnees.bats.map((b, k) => ({ ...b, couleur: couleurs[k] ?? b.couleur }));
      construire();
      map?.triggerRepaint();
    },
    setSol(f) {
      sol = f;
      construire();
      map?.triggerRepaint();
    },
    setOpacite(o) {
      mat.opacity = o;
      mat.transparent = o < 0.99;
      mat.depthWrite = o >= 0.99;
      mat.needsUpdate = true;
      map?.triggerRepaint();
    },
    setSoleil(s) {
      if (!s) {
        soleil.position.set(-60, 120, 80);
        soleil.color.setHex(0xfff4e0);
        soleil.intensity = 1.2;
        ciel.intensity = 1.05;
      } else if (s.hauteur <= 0) {
        soleil.intensity = 0;
        ciel.intensity = 0.4;
      } else {
        const az = (s.azimut * Math.PI) / 180, el = (s.hauteur * Math.PI) / 180;
        soleil.position.set(Math.sin(az) * Math.cos(el) * 100, Math.sin(el) * 100, -Math.cos(az) * Math.cos(el) * 100);
        soleil.color.setHex(s.couleur);
        soleil.intensity = 0.6 + 1.0 * s.intensite;
        ciel.intensity = 0.6 + 0.45 * s.intensite;
      }
      map?.triggerRepaint();
    },
  };
  return couche;
}
