// Plan de coupe dressé en 3D (three.js dans une couche MapLibre, même repère
// que la course du soleil) : un voile vertical le long de A → B, posé sur le
// relief affiché, avec le trait du sol coupé, les bâtiments coupés et des
// rappels verticaux tous les « pas » de distance.
//
// Les altitudes du voile sont celles du terrain affiché (relief 3D, exagération
// comprise) ; sans relief, le sol est plat à 0 et le voile ne montre que le bâti.

import * as THREE from "three";
import maplibregl from "maplibre-gl";

export interface DonneesCoupe3D {
  /** Points du tracé (lon, lat), du sol affiché (m, exagération comprise). */
  points: { lon: number; lat: number; sol: number; d: number }[];
  longueur: number;
  /** Bâtiments coupés : distances le long du tracé et hauteur (m). */
  batiments: { d0: number; d1: number; h: number }[];
  /** Pas des rappels verticaux (m). */
  pas: number;
}

export interface CoucheCoupe3D extends maplibregl.CustomLayerInterface {
  setCoupe(d: DonneesCoupe3D | null): void;
  setOpacite(o: number): void;
}

export function creerCoucheCoupe3D(id: string): CoucheCoupe3D {
  let map: maplibregl.Map | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const groupe = new THREE.Group();
  scene.add(groupe);
  let donnees: DonneesCoupe3D | null = null;
  let origine = maplibregl.MercatorCoordinate.fromLngLat([0, 0], 0);
  let echelle = 1;
  let opacite = 1;

  const voile = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false });
  const sol = new THREE.MeshBasicMaterial({ color: 0x6b4a2c, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const bati = new THREE.MeshBasicMaterial({ color: 0x3a3a3c, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
  const rappel = new THREE.MeshBasicMaterial({ color: 0x1d1d1f, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false });
  const bord = new THREE.MeshBasicMaterial({ color: 0x1d1d1f, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false });
  const materiaux = [voile, sol, bati, rappel, bord];
  const base = new Map(materiaux.map((m) => [m, m.opacity]));

  function vider(): void {
    for (const o of [...groupe.children]) {
      groupe.remove(o);
      (o as THREE.Mesh).geometry?.dispose();
    }
  }

  /** Bande verticale entre deux courbes (bas, haut) le long du tracé, en repère local. */
  function bande(xs: [number, number][], bas: number[], haut: number[], m: THREE.Material, decal = 0): THREE.Mesh {
    const pos: number[] = [];
    const idx: number[] = [];
    xs.forEach(([x, z], i) => {
      pos.push(x, bas[i] + decal, z, x, haut[i] + decal, z);
      if (i) {
        const k = 2 * i;
        idx.push(k - 2, k - 1, k, k - 1, k + 1, k);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    return mesh;
  }

  function construire(): void {
    vider();
    if (!donnees || donnees.points.length < 2) return;
    const d = donnees;
    const a = d.points[0];
    origine = maplibregl.MercatorCoordinate.fromLngLat([a.lon, a.lat], 0);
    echelle = origine.meterInMercatorCoordinateUnits();
    const cos = Math.cos((a.lat * Math.PI) / 180);
    // Repère local : x = est, y = haut, z = sud (comme la course du soleil).
    const loc = (lon: number, lat: number): [number, number] => [(lon - a.lon) * 111_320 * cos, -(lat - a.lat) * 110_540];
    const xs = d.points.map((p) => loc(p.lon, p.lat));
    const sols = d.points.map((p) => p.sol);
    const hMax = Math.max(0, ...d.batiments.map((b) => b.h));
    const marge = Math.max(8, d.longueur * 0.04);
    const sommet = Math.max(...sols) + hMax + marge;
    groupe.add(bande(xs, sols, sols.map(() => sommet), voile));
    // Trait du sol coupé : bande épaisse au pied du voile.
    const ep = Math.max(0.6, d.longueur / 250);
    groupe.add(bande(xs, sols.map((s) => s - ep / 3), sols.map((s) => s + ep), sol));
    // Bord supérieur, fin.
    groupe.add(bande(xs, sols.map(() => sommet - ep * 0.2), sols.map(() => sommet), bord));
    // Point du tracé à la distance donnée (interpolé).
    const en = (dist: number) => {
      const f = Math.max(0, Math.min(1, dist / d.longueur)) * (d.points.length - 1);
      const i = Math.min(d.points.length - 2, Math.floor(f)), t = f - i;
      return {
        x: xs[i][0] + (xs[i + 1][0] - xs[i][0]) * t,
        z: xs[i][1] + (xs[i + 1][1] - xs[i][1]) * t,
        sol: sols[i] + (sols[i + 1] - sols[i]) * t,
      };
    };
    // Bâtiments coupés : aplats sombres dans le plan, du sol à la hauteur BD TOPO.
    for (const b of d.batiments) {
      const n = Math.max(2, Math.ceil(((b.d1 - b.d0) / d.longueur) * 60));
      const pts = Array.from({ length: n + 1 }, (_, k) => en(b.d0 + ((b.d1 - b.d0) * k) / n));
      const pied = Math.min(...pts.map((p) => p.sol));
      groupe.add(bande(pts.map((p) => [p.x, p.z]), pts.map(() => pied), pts.map(() => pied + b.h), bati, 0.05));
    }
    // Rappels verticaux.
    const largeur = Math.max(0.25, d.longueur / 700);
    for (let dist = d.pas; dist < d.longueur - d.pas * 0.3; dist += d.pas) {
      const p0 = en(dist - largeur), p1 = en(dist + largeur);
      groupe.add(bande([[p0.x, p0.z], [p1.x, p1.z]], [p0.sol, p1.sol], [sommet, sommet], rappel, 0.02));
    }
  }

  return {
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
      if (!renderer || !donnees) return;
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
    setCoupe(d) {
      donnees = d;
      construire();
      map?.triggerRepaint();
    },
    setOpacite(o) {
      opacite = o;
      for (const m of materiaux) m.opacity = (base.get(m) ?? 1) * opacite;
      map?.triggerRepaint();
    },
  };
}
