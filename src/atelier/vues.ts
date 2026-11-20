// Vues de l'atelier : combinaisons de couches et de réglages enregistrées,
// rappelées d'un clic (à la manière des thèmes de carte de QGIS).
//
// Une vue retient l'état du panneau (couches, opacités, fond, réglages des
// couches) et, en 3D, l'inclinaison, l'orientation et la focale de la caméra.
// Elle ne retient pas le site : une même vue s'applique à toutes les adresses.
//
// Stockage dans ce navigateur (localStorage) ; export / import en fichier
// JSON pour sauvegarder ou partager les vues avec l'équipe.

export interface Vue {
  nom: string;
  /** Couche → [affichée, opacité 0-1]. Une couche absente garde son état. */
  couches: Record<string, [boolean, number]>;
  /** Groupe de boutons → valeur choisie (fond, colo, exag, courbes, pas, cosia, rendu, numeros, mode, produit:<couche>). */
  reglages: Record<string, string>;
  /** Cases à cocher (photo-dessous, theme-ign:<thème>). */
  coches: Record<string, boolean>;
  /** Réglages de la photo aérienne (opacite, couleurs, eclaircir), 0-1. */
  photo: Record<string, number>;
  /** Caméra en vue 3D : inclinaison et orientation (°), focale (mm, équivalent 24 × 36). */
  camera?: { pitch: number; bearing: number; focale: number };
}

const CLE = "atelier:vues";
export const FORMAT = "diagnostic-site/vues-atelier";

/** Focales proposées (mm, équivalent 24 × 36). 35 mm ≈ la perspective par défaut de MapLibre. */
export const FOCALES = [14, 18, 24, 28, 35, 50, 85, 135, 200] as const;
export const FOCALE_DEFAUT = 35;
/** Champ vertical (°) d'une focale, pour un capteur 24 × 36 (hauteur 24 mm). */
export const champVertical = (f: number) => (2 * Math.atan(12 / f) * 180) / Math.PI;

// --- Vues de départ ------------------------------------------------------------------
// Couches listées : affichées (avec leur opacité) ; toutes les autres sont masquées,
// sauf le périmètre et le repère du site, gardés.
interface Depart {
  nom: string;
  actives: Record<string, number>;
  reglages?: Record<string, string>;
  coches?: Record<string, boolean>;
  photo?: Record<string, number>;
  camera?: Vue["camera"];
}
const COMPOSE = { "theme-ign:fond": true, "theme-ign:eau": true, "theme-ign:vegetation": true, "theme-ign:sols": true, "theme-ign:voirie": true, "theme-ign:ferre": true, "theme-ign:noms": true };
const DEPARTS: Depart[] = [
  {
    nom: "Grand paysage",
    actives: { fond: 0.8, relief: 1, courbes: 0.85, "lidar-mnt": 0.6, arbres: 1, "patrimoine-sites": 0.6, protegees: 0.5 },
    reglages: { fond: "compose", exag: "1.5", courbes: "auto", "produit:lidar-mnt": "produit", "arbres-src": "lidar", rendu: "canopee", mode: "3d" },
    coches: { ...COMPOSE, "theme-ign:fond": false, "theme-ign:relief": false, "photo-dessous": true },
    photo: { opacite: 1, couleurs: 0.5, eclaircir: 0.15 },
    camera: { pitch: 62, bearing: -20, focale: 24 },
  },
  {
    nom: "Analyse du bâti",
    actives: { fond: 0.7, cadastre: 0.8, bati: 1, arbres: 0.9, "lidar-mns": 0.5 },
    reglages: { fond: "compose", colo: "hauteur", numeros: "non", rendu: "volume", "produit:lidar-mns": "produit", mode: "3d" },
    coches: { ...COMPOSE, "theme-ign:bati": false, "photo-dessous": false },
    camera: { pitch: 55, bearing: -20, focale: 35 },
  },
  {
    nom: "Mobilités centre-ville",
    actives: { fond: 0.8, bati: 0.6, isochrones: 0.35, equipements: 1 },
    reglages: { fond: "compose", colo: "neutre", mode: "2d" },
    coches: { ...COMPOSE, "photo-dessous": false },
  },
  {
    nom: "Soleil et ombres",
    actives: { fond: 0.6, bati: 1, arbres: 0.9, ombres: 0.4, course: 1 },
    reglages: { fond: "compose", colo: "neutre", rendu: "volume", mode: "3d" },
    coches: { ...COMPOSE, "theme-ign:noms": false, "photo-dessous": false },
    camera: { pitch: 55, bearing: -20, focale: 28 },
  },
  {
    nom: "Contraintes",
    actives: { fond: 0.7, cadastre: 0.8, bati: 0.7, zonage: 0.5, prescriptions: 0.8, servitudes: 0.7, "patrimoine-mh": 0.8, "patrimoine-spr": 0.6 },
    reglages: { fond: "compose", colo: "neutre", numeros: "non", mode: "2d" },
    coches: { ...COMPOSE, "photo-dessous": false },
  },
  {
    nom: "Nature en ville",
    actives: { fond: 0.7, canopee: 0.8, arbres: 0.9, bati: 0.5, protegees: 0.5 },
    reglages: { fond: "compose", colo: "neutre", rendu: "volume", "arbres-src": "lidar", mode: "2d" },
    coches: { ...COMPOSE, "theme-ign:vegetation": false, "photo-dessous": false },
  },
];
const GARDEES = ["perimetre", "repere"];

/** Vues de départ, complétées pour toutes les couches connues. */
export function vuesDeDepart(idsCouches: string[]): Vue[] {
  return DEPARTS.map((d) => ({
    nom: d.nom,
    couches: Object.fromEntries(
      idsCouches.map((id) => [id, id in d.actives ? [true, d.actives[id]] : GARDEES.includes(id) ? [true, 1] : [false, -1]]),
    ) as Vue["couches"],
    reglages: d.reglages ?? {},
    coches: d.coches ?? {},
    photo: d.photo ?? { opacite: 1, couleurs: 1, eclaircir: 0 },
    camera: d.camera,
  }));
}

// --- Stockage ----------------------------------------------------------------------
/** Vues enregistrées ; null si rien n'a encore été enregistré (on propose alors les vues de départ). */
export function lireVues(): Vue[] | null {
  try {
    const brut = localStorage.getItem(CLE);
    if (!brut) return null;
    const v = JSON.parse(brut) as unknown;
    return Array.isArray(v) ? v.filter(estVue) : null;
  } catch {
    return null;
  }
}
export function ecrireVues(vues: Vue[]): void {
  try {
    localStorage.setItem(CLE, JSON.stringify(vues));
  } catch {
    /* stockage indisponible : les vues valent pour la session */
  }
}

export function estVue(v: unknown): v is Vue {
  const o = v as Vue;
  return !!o && typeof o.nom === "string" && !!o.couches && typeof o.couches === "object";
}

/** Fichier d'export : un objet daté, lisible et réimportable. */
export function exporterVues(vues: Vue[]): Blob {
  return new Blob([JSON.stringify({ format: FORMAT, version: 1, date: new Date().toISOString().slice(0, 10), vues }, null, 2)], { type: "application/json" });
}
/** Lit un fichier d'export (ou une simple liste de vues). */
export function lireExport(texte: string): Vue[] {
  const o = JSON.parse(texte) as { vues?: unknown } | unknown[];
  const liste = Array.isArray(o) ? o : (o as { vues?: unknown }).vues;
  if (!Array.isArray(liste)) throw new Error("Fichier sans vues");
  const vues = liste.filter(estVue);
  if (!vues.length) throw new Error("Aucune vue lisible");
  return vues.map((v) => ({ ...v, reglages: v.reglages ?? {}, coches: v.coches ?? {}, photo: v.photo ?? {} }));
}
