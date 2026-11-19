// Arbres en volume dans la vue 3D de l'atelier, dessinés par three.js dans
// une couche personnalisée MapLibre (même tampon de profondeur que les
// bâtiments : un arbre derrière un immeuble est bien masqué).
//
// Esthétique reprise de l'héliodon historique : tronc fin, houppier facetté
// (icosaèdre ou dodécaèdre), tailles, rotations et verts variés. La variation
// est déterministe (tirée de la position de l'arbre) : le même arbre garde la
// même forme d'un affichage à l'autre. Les dimensions renseignées dans
// OpenStreetMap (height, diameter_crown) sont utilisées quand elles existent ;
// sinon la taille est générique, comme le dit le panneau.

import * as THREE from "three";
import maplibregl from "maplibre-gl";
import type { ArbreOsm } from "../modules/soleil/fetch";

const VERTS = [0x2d6b28, 0x3a7a30, 0x4a8a38, 0x1d5620, 0x557f34];
/** Verts des pins : plus sombres et plus bleutés. */
const VERTS_PINS = [0x2c5a33, 0x335f2e, 0x284f2c, 0x3b6a3a];
const MAX_ARBRES = 1500;

/** Pseudo-aléa stable dans [0, 1[, tiré des coordonnées. */
function alea(lat: number, lon: number, graine: number): number {
  const x = Math.sin(lat * 12.9898e3 + lon * 78.233e3 + graine * 37.719) * 43758.5453;
  return x - Math.floor(x);
}

/** Gabarit d'un arbre (m) : partagé par le volume 3D et le calcul d'ombre. */
export interface GabaritArbre {
  h: number;
  rayon: number;
  fut: number;
  /** Demi-hauteur et hauteur du centre du houppier. */
  sy: number;
  cy: number;
  resineux: boolean;
  /** Port : houppier rond (feuillus), cône (résineux élancés) ou ombrelle (pins parasols, résineux larges). */
  forme: "rond" | "cone" | "parasol" | "etale";
}
export function gabaritArbre(a: ArbreOsm): GabaritArbre {
  if (a.mesure && a.hauteur && a.couronne) return gabaritMesure(a.hauteur, a.couronne / 2, !!a.resineux);
  const r1 = alea(a.lat, a.lon, 1);
  const r2 = alea(a.lat, a.lon, 2);
  // Proportions d'un arbre urbain adulte (retours du 13/11) : fût court,
  // houppier large qui occupe l'essentiel de la hauteur.
  const h = Math.max(4, Math.min(32, a.hauteur ?? 8 + r1 * 8));
  const rayon = Math.max(1.5, Math.min(11, (a.couronne ?? 6 + r2 * 5) / 2));
  const resineux = !!a.resineux;
  const fut = resineux ? h * 0.15 : h * 0.28;
  // Le houppier remplit l'arbre du haut du fût au sommet, en restant
  // à peu près rond (ni galette, ni fuseau).
  const sy = resineux ? (h - fut) / 2.2 : Math.max(rayon * 0.75, Math.min(rayon * 1.15, (h - fut) / 2));
  const cy = resineux ? fut + 1.1 * sy : Math.max(fut + sy * 0.8, h - sy);
  return { h, rayon, fut, sy, cy, resineux, forme: resineux ? "cone" : "rond" };
}

/**
 * Port d'un arbre mesuré (LiDAR) : on respecte la hauteur et l'emprise du
 * houppier réelles, sans le ramener à une boule. L'essence n'est pas connue :
 * le port se déduit des proportions mesurées (retours du 19/11, Bormes-les-Mimosas).
 *  - résineux très large (houppier ≥ 0,8 × hauteur) : ombrelle du pin parasol,
 *    fût haut et houppier plat ;
 *  - résineux large (0,5 à 0,8) : port étalé du pin d'Alep, houppier plus
 *    épais et irrégulier, un peu incliné ;
 *  - résineux élancé : cône ;
 *  - feuillu : houppier ellipsoïdal, aplati quand il est plus large que haut.
 */
function gabaritMesure(hm: number, rayonM: number, resineux: boolean): GabaritArbre {
  const h = Math.max(3, Math.min(45, hm));
  const rayon = Math.max(1, Math.min(16, rayonM));
  if (resineux && (2 * rayon) / h >= 0.8) {
    const sy = Math.max(1, Math.min(h * 0.17, rayon * 0.5));
    const cy = h - sy * 0.9;
    return { h, rayon, fut: cy - sy * 0.35, sy, cy, resineux, forme: "parasol" };
  }
  if (resineux && (2 * rayon) / h >= 0.5) {
    const sy = Math.max(1.2, Math.min(h * 0.24, rayon * 0.7));
    const cy = h - sy;
    return { h, rayon, fut: cy - sy * 0.6, sy, cy, resineux, forme: "etale" };
  }
  if (resineux) {
    const fut = h * 0.15;
    const sy = (h - fut) / 2.2;
    return { h, rayon, fut, sy, cy: fut + 1.1 * sy, resineux, forme: "cone" };
  }
  const fut = h * 0.22;
  const sy = Math.max(rayon * 0.5, Math.min(rayon * 1.1, (h - fut) / 2));
  return { h, rayon, fut, sy, cy: Math.max(fut + sy * 0.7, h - sy), resineux, forme: "rond" };
}

/** Houppier en ombrelle (pin parasol) : dessous plat, dôme bas, facetté. Hauteur unité ≈ 1,25 (de −0,35 à 0,9). */
function geometrieParasol(): THREE.BufferGeometry {
  const profil = [
    [0, -0.35], [0.7, -0.35], [0.97, -0.2], [1, 0.05], [0.9, 0.35], [0.65, 0.65], [0.3, 0.86], [0, 0.9],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(profil, 10);
}

export interface CoucheArbres3D extends maplibregl.CustomLayerInterface {
  setArbres(arbres: ArbreOsm[], lat0: number, lon0: number): void;
  setOpacite(o: number): void;
  /** Altitude du sol (m) sous chaque arbre quand le relief 3D est affiché ; null : sol plat. */
  setSol(sol: ((lon: number, lat: number) => number | null) | null): void;
  /** Lumière solaire (azimut et hauteur en degrés, couleur) ; null : éclairage neutre par défaut. */
  setSoleil(s: { azimut: number; hauteur: number; couleur: number; intensite: number } | null): void;
}

export function creerCoucheArbres3D(id: string): CoucheArbres3D {
  let map: maplibregl.Map | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const groupe = new THREE.Group();
  scene.add(groupe);

  // Lumière douce : ciel et sol, plus un soleil rasant du sud-ouest.
  const ciel = new THREE.HemisphereLight(0xdce8f2, 0x4a4436, 1.0);
  scene.add(ciel);
  const soleil = new THREE.DirectionalLight(0xfff4e0, 1.25);
  soleil.position.set(-60, 120, 80);
  scene.add(soleil);

  const matTronc = new THREE.MeshStandardMaterial({ color: 0x5a3a20, roughness: 0.95, transparent: true });
  const matHouppier = new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true, transparent: true });
  const geoTronc = new THREE.CylinderGeometry(0.14, 0.22, 1, 7, 1).translate(0, 0.5, 0);
  const geoFeuillus = [new THREE.IcosahedronGeometry(1, 1), new THREE.DodecahedronGeometry(1, 0)];
  const geoResineux = new THREE.ConeGeometry(1, 2.2, 8, 2);
  const geoParasol = geometrieParasol();

  let origine = maplibregl.MercatorCoordinate.fromLngLat([0, 0], 0);
  let echelle = origine.meterInMercatorCoordinateUnits();
  let derniers: { arbres: ArbreOsm[]; lat0: number; lon0: number } | null = null;
  let sol: ((lon: number, lat: number) => number | null) | null = null;

  function vider(): void {
    for (const o of [...groupe.children]) {
      groupe.remove(o);
      (o as THREE.InstancedMesh).dispose?.();
    }
  }

  const couche: CoucheArbres3D = {
    id,
    type: "custom",
    renderingMode: "3d",

    onAdd(m, gl) {
      map = m;
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl as WebGLRenderingContext, antialias: true });
      renderer.autoClear = false;
      // Ré-ajout après une perte du contexte WebGL : on reconstruit les arbres.
      if (derniers) couche.setArbres(derniers.arbres, derniers.lat0, derniers.lon0);
    },

    render(_gl, args) {
      if (!renderer || groupe.children.length === 0) return;
      // Repère local : x = est (m), y = haut (m), z = sud (m), centré sur le site.
      const modele = new THREE.Matrix4()
        .makeTranslation(origine.x, origine.y, origine.z)
        .scale(new THREE.Vector3(echelle, -echelle, echelle))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      camera.projectionMatrix = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]).multiply(modele);
      renderer.resetState();
      renderer.render(scene, camera);
    },

    onRemove() {
      vider();
      renderer?.dispose();
      renderer = null;
    },

    setSol(f) {
      sol = f;
      if (derniers) couche.setArbres(derniers.arbres, derniers.lat0, derniers.lon0);
    },

    setArbres(arbres, lat0, lon0) {
      derniers = { arbres, lat0, lon0 };
      vider();
      origine = maplibregl.MercatorCoordinate.fromLngLat([lon0, lat0], 0);
      echelle = origine.meterInMercatorCoordinateUnits();
      const mLat = 110_540;
      const mLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
      const liste = arbres.slice(0, MAX_ARBRES);

      const troncs = new THREE.InstancedMesh(geoTronc, matTronc, liste.length);
      const parForme = [geoFeuillus[0], geoFeuillus[1], geoResineux, geoParasol].map((g) => ({ g, items: [] as THREE.Matrix4[], couleurs: [] as THREE.Color[] }));
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const axeY = new THREE.Vector3(0, 1, 0);

      liste.forEach((a, i) => {
        const x = (a.lon - lon0) * mLon;
        const z = -(a.lat - lat0) * mLat;
        const r1 = alea(a.lat, a.lon, 1);
        const r2 = alea(a.lat, a.lon, 2);
        const r3 = alea(a.lat, a.lon, 3);
        const { rayon, fut, sy, cy, forme: port } = gabaritArbre(a);
        const y0 = sol?.(a.lon, a.lat) ?? 0;

        // Fût jusque dans le houppier ; plus épais pour les grands sujets.
        const ep = port === "parasol" || port === "etale" ? 2 + rayon * 0.12 : 1.2 + rayon * 0.08;
        // Pin d'Alep : fût et houppier légèrement penchés (jusqu'à 10°), direction stable.
        const penche = port === "etale" ? (r3 - 0.5) * 0.35 : 0;
        const qT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(Math.cos(r1 * 6.28), 0, Math.sin(r1 * 6.28)), penche);
        m4.compose(new THREE.Vector3(x, y0, z), qT, new THREE.Vector3(ep, port === "parasol" ? fut + sy * 0.3 : port === "etale" ? fut + sy * 0.5 : fut + rayon * 0.5, ep));
        troncs.setMatrixAt(i, m4);

        const forme = port === "parasol" ? parForme[3] : port === "cone" ? parForme[2] : port === "etale" ? parForme[1] : parForme[r3 < 0.55 ? 0 : 1];
        q.setFromAxisAngle(axeY, r1 * Math.PI * 2);
        // Houppier déporté du côté où penche le fût ; port étalé : un peu irrégulier (axes inégaux).
        const dep = Math.sin(penche) * cy;
        const pos = new THREE.Vector3(x - Math.sin(r1 * 6.28) * dep, y0 + cy, z + Math.cos(r1 * 6.28) * dep);
        const sx = port === "etale" ? rayon * (0.9 + r2 * 0.2) : rayon, sz = port === "etale" ? rayon * (1.1 - r2 * 0.2) : rayon;
        forme.items.push(new THREE.Matrix4().compose(pos, q.clone(), new THREE.Vector3(sx, sy, sz)));
        const teintes = port === "rond" ? VERTS : VERTS_PINS;
        forme.couleurs.push(new THREE.Color(teintes[Math.floor(r2 * teintes.length)]));
      });
      troncs.instanceMatrix.needsUpdate = true;
      // La caméra est la matrice de MapLibre : le tri par champ de vision de
      // three.js se trompe, on le désactive (quelques centaines d'arbres).
      troncs.frustumCulled = false;
      groupe.add(troncs);

      for (const f of parForme) {
        if (f.items.length === 0) continue;
        const mesh = new THREE.InstancedMesh(f.g, matHouppier, f.items.length);
        f.items.forEach((mat, k) => {
          mesh.setMatrixAt(k, mat);
          mesh.setColorAt(k, f.couleurs[k]);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.frustumCulled = false;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        groupe.add(mesh);
      }
      map?.triggerRepaint();
    },

    setSoleil(sol) {
      if (!sol) {
        soleil.position.set(-60, 120, 80);
        soleil.color.setHex(0xfff4e0);
        soleil.intensity = 1.25;
        ciel.intensity = 1.0;
      } else if (sol.hauteur <= 0) {
        // Nuit : lumière du ciel seule, très atténuée.
        soleil.intensity = 0;
        ciel.intensity = 0.35;
      } else {
        const az = (sol.azimut * Math.PI) / 180;
        const el = (sol.hauteur * Math.PI) / 180;
        // Repère local : x = est, y = haut, z = sud.
        soleil.position.set(Math.sin(az) * Math.cos(el) * 100, Math.sin(el) * 100, -Math.cos(az) * Math.cos(el) * 100);
        soleil.color.setHex(sol.couleur);
        soleil.intensity = 0.6 + 1.0 * sol.intensite;
        ciel.intensity = 0.55 + 0.45 * sol.intensite;
      }
      map?.triggerRepaint();
    },

    setOpacite(o) {
      matTronc.opacity = o;
      matHouppier.opacity = o;
      // Opaque : plus net et sans tri de transparence.
      matTronc.transparent = matHouppier.transparent = o < 0.99;
      matTronc.depthWrite = matHouppier.depthWrite = o >= 0.99;
      matTronc.needsUpdate = matHouppier.needsUpdate = true;
      map?.triggerRepaint();
    },
  };
  return couche;
}
