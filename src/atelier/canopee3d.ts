// Canopée en volume : la surface mesurée par le LiDAR HD (dessus des
// houppiers, végétation ≥ 3 m, maille d'environ 1 m), dessinée telle quelle
// en 3D (three.js dans une couche MapLibre). Contrairement aux arbres
// individuels, elle rend fidèlement les masses boisées aux houppiers
// jointifs : pinèdes, bosquets, ripisylves.
//
// Volume : dessus mesuré, bords arrondis jusqu'à la base du houppier (≈ 45 %
// de la hauteur, estimée : le LiDAR aérien voit le dessus, pas le dessous),
// dessous plat à cette base. Teinte selon la hauteur, éclairage du soleil
// comme les arbres.

import * as THREE from "three";
import maplibregl from "maplibre-gl";
import type { CanopeeLidar } from "../core/canopee-lidar";

const MAX_SOMMETS = 320_000;
/** Rampe de verts (hauteur en m → couleur), plus sombre que la légende 2D pour le volume éclairé. */
const RAMPE: [number, THREE.Color][] = [
  [3, new THREE.Color(0x8fb86a)],
  [8, new THREE.Color(0x5f9a45)],
  [15, new THREE.Color(0x3d7a32)],
  [25, new THREE.Color(0x245a26)],
];
function teinte(h: number, c: THREE.Color): THREE.Color {
  if (h <= RAMPE[0][0]) return c.copy(RAMPE[0][1]);
  for (let k = 1; k < RAMPE.length; k++)
    if (h <= RAMPE[k][0]) return c.copy(RAMPE[k - 1][1]).lerp(RAMPE[k][1], (h - RAMPE[k - 1][0]) / (RAMPE[k][0] - RAMPE[k - 1][0]));
  return c.copy(RAMPE[RAMPE.length - 1][1]);
}

export interface CoucheCanopee3D extends maplibregl.CustomLayerInterface {
  setCanopee(c: CanopeeLidar["surface"] | null, lat0: number, lon0: number): void;
  setSol(sol: ((lon: number, lat: number) => number | null) | null): void;
  setOpacite(o: number): void;
  setSoleil(s: { azimut: number; hauteur: number; couleur: number; intensite: number } | null): void;
}

export function creerCoucheCanopee3D(id: string): CoucheCanopee3D {
  let map: maplibregl.Map | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const ciel = new THREE.HemisphereLight(0xdce8f2, 0x4a4436, 1.0);
  const soleil = new THREE.DirectionalLight(0xfff4e0, 1.25);
  soleil.position.set(-60, 120, 80);
  scene.add(ciel, soleil);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true, side: THREE.DoubleSide });
  let mesh: THREE.Mesh | null = null;
  let donnees: { s: CanopeeLidar["surface"]; lat0: number; lon0: number } | null = null;
  let sol: ((lon: number, lat: number) => number | null) | null = null;
  let origine = maplibregl.MercatorCoordinate.fromLngLat([0, 0], 0);
  let echelle = 1;

  function construire(): void {
    if (mesh) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mesh = null;
    }
    if (!donnees) return;
    const { s, lat0, lon0 } = donnees;
    origine = maplibregl.MercatorCoordinate.fromLngLat([lon0, lat0], 0);
    echelle = origine.meterInMercatorCoordinateUnits();
    const mLat = 110_540, mLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
    // Sous-échantillonnage si la grille est trop grande.
    const pas = Math.max(1, Math.ceil(Math.sqrt((s.largeur * s.hauteur) / MAX_SOMMETS)));
    const W = Math.ceil(s.largeur / pas), H = Math.ceil(s.hauteur / pas);
    const hh = new Float32Array(W * H);
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        let m = 0;
        for (let dj = 0; dj < pas; dj++)
          for (let di = 0; di < pas; di++) {
            const jj = j * pas + dj, ii = i * pas + di;
            if (jj < s.hauteur && ii < s.largeur && s.h[jj * s.largeur + ii] > m) m = s.h[jj * s.largeur + ii];
          }
        hh[j * W + i] = m;
      }
    // Lissage léger du dessus (moyenne des voisins de canopée) : moins de bruit au décimètre.
    const lis = new Float32Array(W * H);
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const g = j * W + i;
        if (!hh[g]) continue;
        let t = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
            const v = hh[jj * W + ii];
            if (v) {
              t += v;
              n++;
            }
          }
        lis[g] = t / n;
      }
    // Retours du 20/11 : canopée trop étroite. Le masque « végétation ≥ 3 m »
    // rogne les franges des houppiers ; on l'élargit d'environ 1 m (une maille
    // au moins), à 85 % de la hauteur voisine, avant d'arrondir les bords.
    const elargir = Math.max(1, Math.round(1 / (s.pasM * pas)));
    for (let passe = 0; passe < elargir; passe++) {
      const src = lis.slice();
      for (let j = 0; j < H; j++)
        for (let i = 0; i < W; i++) {
          const g = j * W + i;
          if (src[g]) continue;
          let m = 0;
          for (let dj = -1; dj <= 1; dj++)
            for (let di = -1; di <= 1; di++) {
              const ii = i + di, jj = j + dj;
              if (ii >= 0 && jj >= 0 && ii < W && jj < H && src[jj * W + ii] > m) m = src[jj * W + ii];
            }
          if (m) lis[g] = m * 0.85;
        }
    }
    const lonDe = (i: number) => s.ouest + (i * pas + pas / 2) * s.pasLon;
    const latDe = (j: number) => s.nord - (j * pas + pas / 2) * s.pasLat;
    // Sol : lu sur une grille lâche (tous les 8 points) puis interpolé.
    const G = 8, gw = Math.ceil(W / G) + 1, gh = Math.ceil(H / G) + 1;
    const solG = new Float32Array(gw * gh);
    if (sol) for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) solG[j * gw + i] = sol(lonDe(Math.min(W - 1, i * G)), latDe(Math.min(H - 1, j * G))) ?? 0;
    const solEn = (i: number, j: number) => {
      if (!sol) return 0;
      const fi = i / G, fj = j / G, i0 = Math.floor(fi), j0 = Math.floor(fj), ti = fi - i0, tj = fj - j0;
      const a = solG[j0 * gw + i0], b = solG[j0 * gw + Math.min(gw - 1, i0 + 1)];
      const c = solG[Math.min(gh - 1, j0 + 1) * gw + i0], d = solG[Math.min(gh - 1, j0 + 1) * gw + Math.min(gw - 1, i0 + 1)];
      return (a * (1 - ti) + b * ti) * (1 - tj) + (c * (1 - ti) + d * ti) * tj;
    };
    // Distance au bord de la canopée (en mailles, chanfrein 3-4) : les bords
    // s'arrondissent jusqu'à la base du houppier au lieu de tomber à pic.
    const INF = 1e9;
    const dist = new Float32Array(W * H);
    for (let g = 0; g < W * H; g++) dist[g] = lis[g] ? INF : 0;
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const g = j * W + i;
        if (!dist[g]) continue;
        if (i > 0) dist[g] = Math.min(dist[g], dist[g - 1] + 1);
        if (j > 0) dist[g] = Math.min(dist[g], dist[g - W] + 1);
        if (i > 0 && j > 0) dist[g] = Math.min(dist[g], dist[g - W - 1] + 1.414);
        if (i < W - 1 && j > 0) dist[g] = Math.min(dist[g], dist[g - W + 1] + 1.414);
      }
    for (let j = H - 1; j >= 0; j--)
      for (let i = W - 1; i >= 0; i--) {
        const g = j * W + i;
        if (!dist[g]) continue;
        if (i < W - 1) dist[g] = Math.min(dist[g], dist[g + 1] + 1);
        if (j < H - 1) dist[g] = Math.min(dist[g], dist[g + W] + 1);
        if (i < W - 1 && j < H - 1) dist[g] = Math.min(dist[g], dist[g + W + 1] + 1.414);
        if (i > 0 && j < H - 1) dist[g] = Math.min(dist[g], dist[g + W - 1] + 1.414);
      }
    const pasM = s.pasM * pas;
    /** Base du houppier : ~45 % de la hauteur (le dessous de la masse reste au-dessus des troncs). */
    const BASE = 0.45;
    // Sommets : dessus (arrondi au bord), dessous (base du houppier), et un
    // anneau au bord, commun aux deux, à hauteur de base.
    const iDessus = new Int32Array(W * H).fill(-1), iDessous = new Int32Array(W * H).fill(-1);
    const pos: number[] = [], col: number[] = [];
    const c = new THREE.Color();
    const sombre = new THREE.Color(0x2c4a26);
    const baseAnneau = (i: number, j: number) => {
      let t = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii >= 0 && jj >= 0 && ii < W && jj < H && lis[jj * W + ii]) {
            t += lis[jj * W + ii] * BASE;
            n++;
          }
        }
      return n ? t / n : 0;
    };
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const g = j * W + i, v = lis[g];
        const x = (lonDe(i) - lon0) * mLon, z = -(latDe(j) - lat0) * mLat, y0 = solEn(i, j);
        if (v) {
          const hb = v * BASE;
          const rayonArrondi = Math.max(1, 0.15 * v) / pasM;
          const e = Math.min(1, dist[g] / rayonArrondi);
          const yt = hb + (v - hb) * Math.sqrt(1 - (1 - e) * (1 - e));
          iDessus[g] = pos.length / 3;
          pos.push(x, y0 + yt, z);
          teinte(v, c);
          col.push(c.r, c.g, c.b);
          iDessous[g] = pos.length / 3;
          pos.push(x, y0 + hb, z);
          col.push(sombre.r, sombre.g, sombre.b);
        } else {
          const hb = baseAnneau(i, j);
          if (!hb) continue;
          iDessus[g] = iDessous[g] = pos.length / 3;
          pos.push(x, y0 + hb, z);
          teinte(hb / BASE, c);
          col.push(c.r, c.g, c.b);
        }
      }
    const idx: number[] = [];
    for (let j = 0; j < H - 1; j++)
      for (let i = 0; i < W - 1; i++) {
        const a = j * W + i, b = a + 1, d = a + W, e = d + 1;
        if (!(lis[a] || lis[b] || lis[d] || lis[e])) continue;
        if (iDessus[a] < 0 || iDessus[b] < 0 || iDessus[d] < 0 || iDessus[e] < 0) continue;
        idx.push(iDessus[a], iDessus[d], iDessus[b], iDessus[b], iDessus[d], iDessus[e]);
        idx.push(iDessous[a], iDessous[b], iDessous[d], iDessous[b], iDessous[e], iDessous[d]);
      }
    if (!idx.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
  }

  const couche: CoucheCanopee3D = {
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
    setCanopee(s, lat0, lon0) {
      donnees = s ? { s, lat0, lon0 } : null;
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
        soleil.intensity = 1.25;
        ciel.intensity = 1.0;
      } else if (s.hauteur <= 0) {
        soleil.intensity = 0;
        ciel.intensity = 0.35;
      } else {
        const az = (s.azimut * Math.PI) / 180, el = (s.hauteur * Math.PI) / 180;
        soleil.position.set(Math.sin(az) * Math.cos(el) * 100, Math.sin(el) * 100, -Math.cos(az) * Math.cos(el) * 100);
        soleil.color.setHex(s.couleur);
        soleil.intensity = 0.6 + 1.0 * s.intensite;
        ciel.intensity = 0.55 + 0.45 * s.intensite;
      }
      map?.triggerRepaint();
    },
  };
  return couche;
}
