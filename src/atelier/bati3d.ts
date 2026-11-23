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
}

export interface CoucheBati3D extends maplibregl.CustomLayerInterface {
  setBati(grille: GrilleSursol | null, batiments: BatimentPourVolume[], lat0: number, lon0: number): BilanBati3D;
  /** Change les couleurs sans relire le LiDAR. */
  setCouleurs(couleurs: number[]): void;
  setSol(sol: ((lon: number, lat: number) => number | null) | null): void;
  setOpacite(o: number): void;
  setSoleil(s: { azimut: number; hauteur: number; couleur: number; intensite: number } | null): void;
}

const versMerc = (lon: number, lat: number): [number, number] => [(lon * C) / 180, (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * C) / Math.PI];

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
    // Sommets du toit : un par coin et par bâtiment.
    const vIdx = new Int32Array((W + 1) * (H + 1)).fill(-1), vProp = new Int32Array((W + 1) * (H + 1)).fill(-1);
    const vAutres = new Map<number, number>();
    const hauteurCoin = (ci: number, cj: number, k: number) => {
      let t = 0, n = 0;
      for (const [i, j] of [[ci - 1, cj - 1], [ci, cj - 1], [ci - 1, cj], [ci, cj]]) {
        if (i < 0 || j < 0 || i >= W || j >= H) continue;
        const c = j * W + i;
        if (idg[c] === k) {
          t += hc[c];
          n++;
        }
      }
      return n ? t / n : bats[k].hRepli;
    };
    const sommet = (ci: number, cj: number, k: number): number => {
      const c = cj * (W + 1) + ci;
      if (vProp[c] === k) return vIdx[c];
      const cle = c * 1_000_000 + k;
      if (vProp[c] !== -1) {
        const v = vAutres.get(cle);
        if (v !== undefined) return v;
      }
      const v = pos.length / 3;
      pos.push(xCol[ci], solToit[k] + hauteurCoin(ci, cj, k), zRow[cj]);
      const co = couleurs[k];
      col.push(co.r, co.g, co.b);
      if (vProp[c] === -1) {
        vProp[c] = k;
        vIdx[c] = v;
      } else vAutres.set(cle, v);
      return v;
    };
    const ombreMur = 0.86;
    const mur = (ci0: number, cj0: number, ci1: number, cj1: number, k: number, m: number) => {
      const ha = pos[sommet(ci0, cj0, k) * 3 + 1], hb = pos[sommet(ci1, cj1, k) * 3 + 1];
      let ba: number, bb: number;
      if (m < 0) ba = bb = solPied[k];
      else {
        ba = pos[sommet(ci0, cj0, m) * 3 + 1];
        bb = pos[sommet(ci1, cj1, m) * 3 + 1];
      }
      if (ha <= ba + 0.05 && hb <= bb + 0.05) return;
      ba = Math.min(ba, ha);
      bb = Math.min(bb, hb);
      const v = pos.length / 3;
      pos.push(xCol[ci0], ba, zRow[cj0], xCol[ci1], bb, zRow[cj1], xCol[ci1], hb, zRow[cj1], xCol[ci0], ha, zRow[cj0]);
      const co = couleurs[k];
      for (let n = 0; n < 4; n++) col.push(co.r * ombreMur, co.g * ombreMur, co.b * ombreMur);
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    };
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const k = idg[j * W + i];
        if (k < 0) continue;
        const a = sommet(i, j, k), b = sommet(i + 1, j, k), c = sommet(i, j + 1, k), d = sommet(i + 1, j + 1, k);
        idx.push(a, c, b, b, c, d);
        const voisin = (ii: number, jj: number) => (ii < 0 || jj < 0 || ii >= W || jj >= H ? -1 : idg[jj * W + ii]);
        const g0 = voisin(i - 1, j), g1 = voisin(i + 1, j), g2 = voisin(i, j - 1), g3 = voisin(i, j + 1);
        if (g0 !== k) mur(i, j, i, j + 1, k, g0);
        if (g1 !== k) mur(i + 1, j, i + 1, j + 1, k, g1);
        if (g2 !== k) mur(i, j, i + 1, j, k, g2);
        if (g3 !== k) mur(i, j + 1, i + 1, j + 1, k, g3);
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
