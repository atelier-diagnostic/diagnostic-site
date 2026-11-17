// Course du soleil autour du site, dessinée en 3D (three.js dans une couche
// MapLibre, même repère que les arbres) : la voûte de l'héliodon.
//
//  - trois arcs de référence : solstice d'été (21 juin), équinoxes (21 mars),
//    solstice d'hiver (21 décembre) ;
//  - les heures pleines (heure légale) marquées sur ces arcs et reliées entre
//    elles : on lit à quelle heure le soleil passe derrière tel bâtiment ;
//  - l'arc du jour choisi dans le panneau Soleil, et le soleil à l'heure
//    choisie, relié au site.
// En vue 2D, la voûte est aplatie en diagramme solaire polaire classique :
// distance au centre proportionnelle à 90° − hauteur (zénith au centre,
// horizon sur le cercle), avec les cercles de 30° et 60° de hauteur.

import * as THREE from "three";
import maplibregl from "maplibre-gl";
import { sunAtLegalTime } from "../map3d/sun";

const COULEURS = { ete: 0xe8743b, equinoxe: 0x8e8e93, hiver: 0x2a78d6, jour: 0x1d1d1f, soleil: 0xf5b301, heures: 0x8e8e93, sol: 0x48484d };

export interface CoucheCourseSoleil extends maplibregl.CustomLayerInterface {
  setSite(lat: number, lon: number, rayonM: number): void;
  /** Jour (AAAA-MM-JJ) et heure légale (décimale) choisis dans le panneau Soleil. */
  setMoment(date: string, heure: number): void;
  setOpacite(o: number): void;
  /** true : diagramme à plat (vue 2D) ; false : voûte en 3D. */
  setPlan(plan: boolean): void;
  /** Altitude du sol au site (m), quand le relief 3D est affiché. */
  setAltitude(z: number): void;
}

let aPlat = false;
/** Position (repère local : x = est, y = haut, z = sud) d'un soleil vu sous l'azimut et la hauteur donnés :
 * sur la voûte en 3D, ou dans le diagramme polaire à plat en 2D. */
function surVoute(R: number, azDeg: number, elDeg: number): THREE.Vector3 {
  const az = (azDeg * Math.PI) / 180;
  const e = Math.max(0, elDeg);
  if (aPlat) {
    const r = (R * (90 - e)) / 90;
    return new THREE.Vector3(r * Math.sin(az), 0.5, -r * Math.cos(az));
  }
  const el = (e * Math.PI) / 180;
  return new THREE.Vector3(R * Math.sin(az) * Math.cos(el), R * Math.sin(el), -R * Math.cos(az) * Math.cos(el));
}

export function creerCoucheCourseSoleil(id: string): CoucheCourseSoleil {
  let map: maplibregl.Map | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const fixe = new THREE.Group(); // arcs de référence, heures, rose au sol
  const mobile = new THREE.Group(); // arc du jour et soleil
  scene.add(fixe, mobile);
  const materiaux = new Map<number, THREE.MeshBasicMaterial>();
  const mat = (c: number) => {
    if (!materiaux.has(c)) materiaux.set(c, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 1 }));
    return materiaux.get(c)!;
  };

  let site: { lat: number; lon: number; R: number } | null = null;
  let moment: { date: string; heure: number } | null = null;
  let origine = maplibregl.MercatorCoordinate.fromLngLat([0, 0], 0);
  let echelle = origine.meterInMercatorCoordinateUnits();

  const vider = (g: THREE.Group) => {
    for (const o of [...g.children]) {
      g.remove(o);
      (o as THREE.Mesh).geometry?.dispose();
    }
  };
  const tube = (pts: THREE.Vector3[], r: number, c: number, ferme = false) => {
    if (pts.length < 2) return;
    const courbe = new THREE.CatmullRomCurve3(pts, ferme);
    const m = new THREE.Mesh(new THREE.TubeGeometry(courbe, Math.max(8, pts.length * 3), r, 6, ferme), mat(c));
    m.frustumCulled = false;
    return m;
  };
  const bille = (p: THREE.Vector3, r: number, c: number) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat(c));
    m.position.copy(p);
    m.frustumCulled = false;
    return m;
  };

  /** Points de l'arc d'un jour, toutes les 10 minutes, soleil levé. */
  function arc(date: string): THREE.Vector3[] {
    if (!site) return [];
    const pts: THREE.Vector3[] = [];
    for (let h = 2; h <= 23.5; h += 1 / 6) {
      const s = sunAtLegalTime(site.lat, site.lon, date, h);
      if (s.elevationDeg > 0) pts.push(surVoute(site.R, s.azimuthDeg, s.elevationDeg));
    }
    return pts;
  }

  function construireFixe(): void {
    vider(fixe);
    if (!site) return;
    const { R } = site;
    const annee = (moment?.date ?? new Date().toISOString()).slice(0, 4);
    const e = R * 0.005; // épaisseur des traits
    // Rose au sol : cercle et quatre repères, le nord plus long.
    const cercle = Array.from({ length: 72 }, (_, i) => surVoute(R, i * 5, 0).setY(0.3));
    const c = tube(cercle, e * 0.8, COULEURS.sol, true);
    if (c) fixe.add(c);
    for (const a of [0, 90, 180, 270]) {
      const t = tube([surVoute(R * (a === 0 ? 0.82 : 0.9), a, 0).setY(0.3), surVoute(R * 1.06, a, 0).setY(0.3)], e * (a === 0 ? 1.6 : 1), COULEURS.sol);
      if (t) fixe.add(t);
    }
    // À plat : cercles de 30° et 60° de hauteur, pour lire le diagramme.
    if (aPlat)
      for (const h of [30, 60]) {
        const t2 = tube(Array.from({ length: 72 }, (_, i) => surVoute(R, i * 5, h)), e * 0.4, COULEURS.heures, true);
        if (t2) fixe.add(t2);
      }
    // Arcs de référence.
    const refs: [string, number][] = [[`${annee}-06-21`, COULEURS.ete], [`${annee}-03-21`, COULEURS.equinoxe], [`${annee}-12-21`, COULEURS.hiver]];
    for (const [d, col] of refs) {
      const t = tube(arc(d), e, col);
      if (t) fixe.add(t);
    }
    // Heures pleines : billes sur les arcs, reliées d'un solstice à l'autre.
    for (let h = 4; h <= 22; h++) {
      const pts = refs
        .map(([d]) => sunAtLegalTime(site!.lat, site!.lon, d, h))
        .filter((s) => s.elevationDeg > 0)
        .map((s) => surVoute(R, s.azimuthDeg, s.elevationDeg));
      for (const p of pts) fixe.add(bille(p, e * 2.2, COULEURS.heures));
      const t = tube(pts, e * 0.45, COULEURS.heures);
      if (t) fixe.add(t);
    }
  }

  function construireMobile(): void {
    vider(mobile);
    if (!site || !moment) return;
    const { R } = site;
    const e = R * 0.005;
    const t = tube(arc(moment.date), e * 1.4, COULEURS.jour);
    if (t) mobile.add(t);
    const s = sunAtLegalTime(site.lat, site.lon, moment.date, moment.heure);
    if (s.elevationDeg > 0) {
      const p = surVoute(R, s.azimuthDeg, s.elevationDeg);
      mobile.add(bille(p, R * 0.035, COULEURS.soleil));
      const rayon = tube([new THREE.Vector3(0, aPlat ? 0.5 : 0.3, 0), p], e * 0.5, COULEURS.soleil);
      if (rayon) mobile.add(rayon);
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
    },
    render(_gl, args) {
      if (!renderer || !site) return;
      const modele = new THREE.Matrix4()
        .makeTranslation(origine.x, origine.y, origine.z)
        .scale(new THREE.Vector3(echelle, -echelle, echelle))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      camera.projectionMatrix = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]).multiply(modele);
      renderer.resetState();
      renderer.render(scene, camera);
    },
    onRemove() {
      vider(fixe);
      vider(mobile);
      renderer?.dispose();
      renderer = null;
    },
    setSite(lat, lon, rayonM) {
      site = { lat, lon, R: Math.max(40, Math.min(400, rayonM)) };
      origine = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0);
      echelle = origine.meterInMercatorCoordinateUnits();
      construireFixe();
      construireMobile();
      map?.triggerRepaint();
    },
    setMoment(date, heure) {
      const anneeChange = moment?.date.slice(0, 4) !== date.slice(0, 4);
      moment = { date, heure };
      if (anneeChange) construireFixe();
      construireMobile();
      map?.triggerRepaint();
    },
    setAltitude(z) {
      fixe.position.y = mobile.position.y = z;
      map?.triggerRepaint();
    },
    setPlan(plan) {
      if (plan === aPlat) return;
      aPlat = plan;
      construireFixe();
      construireMobile();
      map?.triggerRepaint();
    },
    setOpacite(o) {
      for (const m of materiaux.values()) {
        m.opacity = o;
        m.transparent = o < 0.99;
        m.depthWrite = o >= 0.99;
        m.needsUpdate = true;
      }
      map?.triggerRepaint();
    },
  };
}
