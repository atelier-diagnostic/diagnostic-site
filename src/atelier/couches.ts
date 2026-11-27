// Catalogue des couches de l'Atelier cartographique. Toutes sont des données
// publiques sans clé, vérifiées le 12/11/2026 (réponse et CORS) :
//   - Géoplateforme IGN : WMTS (fonds), WMS-V (cadastre, urbanisme, espaces
//     protégés), WFS (bâti et végétation BD TOPO) ;
//   - Géorisques : WMS (retrait-gonflement des argiles) ;
//   - OpenStreetMap (Overpass) : arbres isolés.

import { IGN_WMTS, IGN_LAYERS } from "../api/endpoints";

export type Famille = "Fond" | "LiDAR HD" | "Occupation du sol" | "Parcelles" | "Bâti" | "Végétation" | "Soleil" | "Urbanisme" | "Patrimoine" | "Mobilité" | "Risques · Nature" | "Repères";

export interface CoucheDef {
  id: string;
  famille: Famille;
  titre: string;
  source: string;
  /** Active à l'ouverture. */
  active: boolean;
  /** Opacité initiale (0-1). */
  opacite: number;
  /** Couche raster (tuiles) : modèle d'URL MapLibre. */
  tuiles?: string;
  /** Zoom maximal servi par la source (au-delà : agrandissement). */
  zoomMax?: number;
  /** Légende servie par le service (image), pour les couches WMS. */
  legende?: string;
  /** Couche en niveaux de gris pouvant passer en mode « produit » (ombrages). */
  produit?: boolean;
  /** Mention affichée sous le titre (limites, hypothèses). */
  note?: string;
}

const WMS_V = "https://data.geopf.fr/wms-v/ows";
const GEORISQUES = "https://www.georisques.gouv.fr/services";

function wms(base: string, layers: string): string {
  return (
    `${base}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${layers}&STYLES=` +
    `&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true`
  );
}
function legendeWms(base: string, layer: string): string {
  return `${base}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetLegendGraphic&LAYER=${layer}&FORMAT=image/png&SLD_VERSION=1.1.0`;
}
function wmts(def: { layer: string; format: string }): string {
  return IGN_WMTS.replace("{layer}", def.layer).replace("{format}", def.format);
}

/** CoSIA (Couverture du Sol par IA, IGN) : un millésime par période de prise
 * de vue ; la couverture 2024-2026 est en cours de production. */
export const COSIA = {
  "2017-2020": "IGNF_COSIA_2017-2020",
  "2021-2023": "IGNF_COSIA_2021-2023",
  "2024-2026": "IGNF_COSIA_2024-2026",
} as const;
export type MillesimeCosia = keyof typeof COSIA;
export function tuilesCosia(m: MillesimeCosia): string {
  return wmts({ layer: COSIA[m], format: "image/png" });
}

/** Pas du carroyage Lambert-93 (m). */
export const PAS_CARROYAGE = [50, 100, 200, 500] as const;

/** Exagération du relief en 3D. */
export const EXAGERATIONS = [1, 1.5, 2, 3] as const;

/** Équidistance des courbes de niveau proposée (m). */
export const PAS_COURBES = ["auto", 0.5, 1, 2, 5, 10] as const;

export const FONDS = {
  plan: { titre: "Plan", tuiles: wmts(IGN_LAYERS.plan) },
  photo: { titre: "Photo", tuiles: wmts(IGN_LAYERS.ortho) },
  // Plan IGN vectoriel, par thèmes (voir fond-ign.ts).
  compose: { titre: "Composé", tuiles: "" },
  aucun: { titre: "Aucun", tuiles: "" },
} as const;
export type Fond = keyof typeof FONDS;

export const COUCHES: CoucheDef[] = [
  {
    id: "fond",
    famille: "Fond",
    titre: "Fond de carte",
    source: "IGN Plan / BD ORTHO® / Plan IGN vecteur",
    active: true,
    opacite: 0.7,
    note: "« Composé » : le Plan IGN vectoriel, dont on allume les thèmes un à un pour composer un fond précis.",
  },
  {
    id: "relief",
    famille: "Fond",
    titre: "Relief",
    source: "IGN LiDAR HD (MNT 50 cm), complété par le RGE ALTI®",
    active: false,
    opacite: 0.4,
    note: "En 3D, toutes les couches se posent sur le relief (exagération réglable) ; l'opacité règle l'ombrage, visible aussi en 2D. Altitudes du LiDAR HD là où il est publié (talus, fossés, digues lisibles), sinon du RGE ALTI ; la part LiDAR de la vue est indiquée. Les calculs d'ombres et d'heures de soleil au sol restent faits sur sol plat ; le relief lointain est dans le module Soleil.",
  },
  {
    id: "courbes",
    famille: "Fond",
    titre: "Courbes de niveau",
    source: "Calcul à partir du LiDAR HD ou du RGE ALTI®",
    active: false,
    opacite: 0.85,
    note: "Courbes calculées dans l'atelier sur un carré autour du site ; cotes en mètres NGF, une courbe sur cinq maîtresse et cotée. LiDAR HD : MNT 50 cm lu à 0,9 m (1,7 m au-delà de 1 km), lissé, complété par le RGE ALTI® là où il n'est pas encore publié ; permet l'équidistance de 0,5 m. RGE ALTI® : un point tous les 3 à 4 m.",
  },
  // LiDAR HD de l'IGN (nuages de points à 10 points/m², produits dérivés à
  // 50 cm), servis en tuiles ombrées par la Géoplateforme, sans clé.
  {
    id: "lidar-mnt",
    famille: "LiDAR HD",
    titre: "Sol (MNT ombré)",
    source: "IGN LiDAR HD",
    active: false,
    opacite: 0.75,
    tuiles: wmts({ layer: "IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW", format: "image/png" }),
    zoomMax: 18,
    produit: true,
    note: "Relief du sol nu au pas de 50 cm, sans bâtiments ni végétation : talus, murets, fossés, anciens tracés. Couverture LiDAR HD encore en cours dans certaines régions (zones vides).",
  },
  {
    id: "lidar-mns",
    famille: "LiDAR HD",
    titre: "Sursol (MNS ombré)",
    source: "IGN LiDAR HD",
    active: false,
    opacite: 0.75,
    tuiles: wmts({ layer: "IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW", format: "image/png" }),
    zoomMax: 18,
    produit: true,
    note: "Relief de tout ce que voit le laser : sol, bâtiments, arbres.",
  },
  {
    id: "lidar-mnh",
    famille: "LiDAR HD",
    titre: "Hauteur du sursol (MNH)",
    source: "IGN LiDAR HD",
    active: false,
    opacite: 0.75,
    tuiles: wmts({ layer: "IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW", format: "image/png" }),
    zoomMax: 18,
    produit: true,
    note: "Hauteur au-dessus du sol (bâtiments, arbres) : utile pour lire la canopée et les volumes.",
  },
  {
    id: "lidar-classes",
    famille: "LiDAR HD",
    titre: "Classes du nuage de points",
    source: "IGN LiDAR HD",
    active: false,
    opacite: 0.75,
    tuiles: wmts({ layer: "IGNF_LIDAR-HD_CLASS", format: "image/png" }),
    zoomMax: 18,
    note: "Sol, végétation basse, moyenne et haute, bâtiments, eau… tels que classés par l'IGN.",
  },
  {
    id: "cosia",
    famille: "Occupation du sol",
    titre: "CoSIA, couverture du sol",
    source: "IGN, couverture du sol par intelligence artificielle",
    active: false,
    opacite: 0.65,
    tuiles: wmts({ layer: COSIA["2021-2023"], format: "image/png" }),
    zoomMax: 18,
    // Légende publiée par l'IGN dans les capacités WMTS (la même pour les trois millésimes).
    legende: "https://data.geopf.fr/annexes/ressources/legendes/CoSIA-legend.png",
    note: "Classes déduites des photos aériennes par l'IGN : une aide à la lecture, à vérifier sur place.",
  },
  {
    id: "cadastre",
    famille: "Parcelles",
    titre: "Cadastre",
    source: "IGN Parcellaire Express (vecteur)",
    active: true,
    opacite: 0.8,
    note: "Limites de parcelles en trait fin, visibles à partir du zoom 15 ; numéros à partir du zoom 17.",
  },
  { id: "bati", famille: "Bâti", titre: "Bâtiments", source: "IGN BD TOPO® (repli OpenStreetMap)", active: true, opacite: 1 },
  {
    id: "canopee",
    famille: "Végétation",
    titre: "Canopée LiDAR",
    source: "IGN LiDAR HD (hauteur du sursol) × CoSIA",
    active: false,
    opacite: 0.8,
    note: "Végétation d'au moins 3 m de haut, mesurée : hauteur du sursol LiDAR HD (50 cm) là où CoSIA voit des feuillus, des conifères ou des broussailles (toits, murs, véhicules écartés). Teinte selon la hauteur. Dans le cercle d'analyse.",
  },
  {
    id: "arbres",
    famille: "Végétation",
    titre: "Arbres",
    source: "IGN LiDAR HD × CoSIA, ou OpenStreetMap",
    active: true,
    opacite: 0.9,
    note: "LiDAR : arbres détectés par leurs sommets dans la canopée mesurée, avec leur hauteur et leur houppier réels ; les bosquets serrés peuvent être sous-comptés (houppiers jointifs). OpenStreetMap : arbres saisis par les contributeurs, taille renseignée ou générique (pointillés en coupe). Les arbres alimentent la 3D, les ombres et la coupe.",
  },
  { id: "vegetation", famille: "Végétation", titre: "Zones de végétation", source: "IGN BD TOPO®", active: false, opacite: 0.5 },
  {
    id: "ombres",
    famille: "Soleil",
    titre: "Ombres portées",
    source: "Calcul à partir des hauteurs BD TOPO® et des arbres (LiDAR HD ou OSM)",
    active: false,
    opacite: 0.4,
    note: "Bâtiments et arbres, sol plat, toits plats, relief non pris en compte. Ombre des arbres indicative quand leur taille n'est pas renseignée. La lumière de la carte suit le soleil.",
  },
  {
    id: "ensoleillement",
    famille: "Soleil",
    titre: "Heures de soleil au sol",
    source: "Calcul à partir des hauteurs BD TOPO®",
    active: false,
    opacite: 0.75,
    note: "Durée d'ensoleillement du sol libre sur la journée choisie dans le panneau Soleil (ciel clair, pas de 15 min, cellules de 2 m). Ombres des bâtiments du périmètre seulement : arbres, relief et bâtiments hors périmètre ignorés ; toits exclus.",
  },
  {
    id: "course",
    famille: "Soleil",
    titre: "Course du soleil",
    source: "Calcul astronomique",
    active: false,
    opacite: 1,
    note: "Arcs du 21 juin (orange), des équinoxes (gris) et du 21 décembre (bleu), points aux heures pleines (heure légale) ; en noir, le jour choisi et le soleil à l'heure choisie. Voûte du rayon du périmètre (40 à 400 m). Vue de dessus, c'est un diagramme solaire en plan.",
  },
  {
    id: "zonage",
    famille: "Urbanisme",
    titre: "Zonage du PLU",
    source: "Géoportail de l'Urbanisme",
    active: false,
    opacite: 0.55,
    tuiles: wms(WMS_V, "zone_secteur"),
    legende: legendeWms(WMS_V, "zone_secteur"),
  },
  {
    id: "prescriptions",
    famille: "Urbanisme",
    titre: "Prescriptions",
    source: "Géoportail de l'Urbanisme",
    active: false,
    opacite: 0.7,
    tuiles: wms(WMS_V, "prescription"),
    legende: legendeWms(WMS_V, "prescription"),
  },
  {
    id: "servitudes",
    famille: "Urbanisme",
    titre: "Servitudes d'utilité publique",
    source: "Géoportail de l'Urbanisme",
    active: false,
    opacite: 0.7,
    tuiles: wms(WMS_V, "sup"),
  },
  {
    id: "patrimoine-mh",
    famille: "Patrimoine",
    titre: "Monuments historiques et abords",
    source: "Géoportail de l'Urbanisme (servitudes AC1)",
    active: false,
    opacite: 0.8,
    note: "Édifices protégés (rouge) et leurs abords (tirets), tels que publiés en servitudes sur le Géoportail de l'Urbanisme. Dans les abords, les travaux sont soumis à l'Architecte des Bâtiments de France. Toutes les servitudes ne sont pas encore publiées : une absence ici est à vérifier sur l'Atlas des patrimoines ou auprès de l'UDAP.",
  },
  {
    id: "patrimoine-sites",
    famille: "Patrimoine",
    titre: "Sites classés et inscrits",
    source: "Géoportail de l'Urbanisme (servitudes AC2)",
    active: false,
    opacite: 0.6,
  },
  {
    id: "patrimoine-spr",
    famille: "Patrimoine",
    titre: "Sites patrimoniaux remarquables",
    source: "Géoportail de l'Urbanisme (servitudes AC4)",
    active: false,
    opacite: 0.6,
    note: "Anciens secteurs sauvegardés, ZPPAUP et AVAP, réunis depuis 2016 sous le nom de sites patrimoniaux remarquables.",
  },
  {
    id: "unesco",
    famille: "Patrimoine",
    titre: "Patrimoine mondial (UNESCO)",
    source: "IGN",
    active: false,
    opacite: 0.6,
    tuiles: wms(WMS_V, "IGNF_SITES-UNESCO"),
  },
  {
    id: "isochrones",
    famille: "Mobilité",
    titre: "Isochrones à pied",
    source: "IGN, calcul d'itinéraire (BD TOPO®)",
    active: false,
    opacite: 0.35,
    note: "Zones atteignables à pied depuis le point du site en 5, 10 et 15 minutes, sur le réseau de la BD TOPO® (service d'itinéraire de la Géoplateforme, profil piéton, vitesse de marche fixée par le service). Pente, feux et traversées non modélisés.",
  },
  {
    id: "equipements",
    famille: "Mobilité",
    titre: "Équipements à 15 minutes",
    source: "IGN BD TOPO® et OpenStreetMap, dans les isochrones IGN",
    active: false,
    opacite: 1,
    note: "Ville du quart d'heure : équipements du quotidien atteignables à pied en 5, 10 ou 15 minutes. Équipements publics (enseignement, santé, sport, culture, espaces publics, mairies, postes) : BD TOPO® de l'IGN ; commerces alimentaires, pharmacies, médecins, aires de jeux, arrêts et vélos en libre-service : OpenStreetMap. Ces bases sont plus ou moins complètes selon les villes : un équipement absent ici peut exister. La présence compte, pas la capacité. Cliquer un point pour son nom.",
  },
  {
    id: "argiles",
    famille: "Risques · Nature",
    titre: "Argiles (retrait-gonflement)",
    source: "Géorisques",
    active: false,
    opacite: 0.55,
    tuiles: wms(GEORISQUES, "ALEARG"),
    legende: legendeWms(GEORISQUES, "ALEARG"),
  },
  {
    id: "protegees",
    famille: "Risques · Nature",
    titre: "Espaces protégés",
    source: "INPN : Natura 2000, ZNIEFF 1 et 2",
    active: false,
    opacite: 0.55,
    tuiles: wms(WMS_V, "Natura_2000,Patrinat_ZNIEFF2_France,Patrinat_ZNIEFF1_France"),
  },
  {
    id: "perimetre-projet",
    famille: "Repères",
    titre: "Périmètre de projet",
    source: "Parcelles choisies dans le diagnostic (cadastre PCI)",
    active: true,
    opacite: 1,
    note: "Choix des parcelles : onglet Diagnostic, sous la carte. Contour cadastral graphique, sans valeur juridique.",
  },
  { id: "perimetre", famille: "Repères", titre: "Rayon d'analyse", source: "Diagnostic", active: true, opacite: 1 },
  { id: "repere", famille: "Repères", titre: "Repère du site", source: "Point analysé", active: true, opacite: 1 },
  { id: "carroyage", famille: "Repères", titre: "Carroyage", source: "Lambert-93 (RGF93)", active: false, opacite: 0.45 },
];

export const FAMILLES: Famille[] = ["Fond", "LiDAR HD", "Occupation du sol", "Parcelles", "Bâti", "Végétation", "Soleil", "Urbanisme", "Patrimoine", "Mobilité", "Risques · Nature", "Repères"];

/** Classes de hauteur (m) : rampe séquentielle claire → foncée. */
export const HAUTEURS = [
  // Rampe douce (beige → terracotta), choisie à l'œil dans le Chrome de
  // Cédric le 13/11 : lisible en 3D sans couleurs criardes.
  { max: 6, color: "#f2ebe0", label: "< 6" },
  { max: 12, color: "#e7d8c1", label: "6–12" },
  { max: 20, color: "#d8bf9f", label: "12–20" },
  { max: 35, color: "#c19c7c", label: "20–35" },
  { max: Infinity, color: "#9c7562", label: "> 35" },
];
export const INCONNU = "#c9c6c0";

/** Usages BD TOPO (attribut usage_1) : palette catégorielle de référence,
 * dans son ordre fixe (contrôlée pour la vision des couleurs) ; annexes et
 * usages indifférenciés en gris. */
export const USAGES: { valeur: string; color: string }[] = [
  { valeur: "Résidentiel", color: "#2a78d6" },
  { valeur: "Commercial et services", color: "#eb6834" },
  { valeur: "Industriel", color: "#1baf7a" },
  { valeur: "Agricole", color: "#eda100" },
  { valeur: "Religieux", color: "#e87ba4" },
  { valeur: "Sportif", color: "#008300" },
];
export const USAGE_AUTRE = "#b8b8bd";
/** Bâti en coloration « Neutre » : blanc très légèrement grège (contour gris en 2D, faces ombrées en 3D). */
export const NEUTRE = "#f3f0ea";

/** Heures de soleil au sol : rampe chaude, du sombre (peu de soleil) au clair (beaucoup). */
export const CLASSES_SOLEIL = [
  { max: 1, couleur: "#4a2f45", label: "< 1 h" },
  { max: 2, couleur: "#7b3f4a", label: "1–2 h" },
  { max: 4, couleur: "#b5543f", label: "2–4 h" },
  { max: 6, couleur: "#e07f3a", label: "4–6 h" },
  { max: 8, couleur: "#f2b35a", label: "6–8 h" },
  { max: Infinity, couleur: "#fbe3a0", label: "≥ 8 h" },
];
