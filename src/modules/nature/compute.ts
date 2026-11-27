// Calculs nature : couverture végétale/eau (%), proxy canopée, densité
// d'arbres recensés. Pur, sans I/O.
//
// LIMITE ASSUMÉE : Overpass "around" renvoie les polygones entiers dès qu'un
// point touche le rayon (pas de découpage géométrique au bord du cercle,
// qui demanderait une lib type turf). Les surfaces sont donc une borne haute,
// pas une mesure exacte de ce qui est strictement dans le cercle. Documenté
// dans l'export, pas masqué.
import { CLASSES_COSIA, indicateursSol, type ClasseCosia, type IndicateursSol } from "../../core/cosia";
import type { NatureRaw, ProtectedZoneItem } from "./fetch";
import { polygonAreaM2 } from "../../core/geo";
import type { SiteContext } from "../../core/types";

export interface NatureResult {
  effectiveRadiusM: number;
  fetchFailed: boolean;
  circleAreaM2: number;
  greenAreaM2: number;
  greenPct: number;
  waterAreaM2: number;
  waterPct: number;
  canopyAreaM2: number;
  canopyPct: number;
  treeCount: number;
  /** Arbres recensés pour 10 000 m² (1 ha). */
  treeDensityHa: number;
  protectedZones: ProtectedZoneItem[];
  protectedZonesFetchFailed: boolean;
  /** Couverture du sol mesurée (CoSIA, IGN) ; null si indisponible. */
  sol: (IndicateursSol & { millesime: string; couverturePct: number; parts: { id: ClasseCosia; titre: string; couleur: string; pct: number }[] }) | null;
  /** Couverture du sol dans le périmètre de projet (CoSIA) ; null sans périmètre ou si indisponible. */
  solPerimetre: (IndicateursSol & { millesime: string; couverturePct: number; surfaceM2: number }) | null;
  /** Un périmètre de projet était défini (même si sa mesure a échoué). */
  avecPerimetre: boolean;
  /** Zonages de protection lus sur le périmètre de projet plutôt qu'au point. */
  protectionsSurPerimetre: boolean;
  /** Source des pourcentages végétalisé / canopée. */
  sourceVerdure: "CoSIA" | "OSM";
  /** Canopée mesurée (LiDAR HD × CoSIA) ; null si indisponible. */
  lidar: NatureRaw["lidar"];
  /** Source du pourcentage de canopée retenu (canopyPct). */
  sourceCanopee: "LiDAR HD" | "CoSIA" | "OSM";
  espaceVert300: NatureRaw["espaceVert300"];
}

function sumArea(polys: { lat: number; lon: number }[][]): number {
  return polys.reduce((s, p) => s + polygonAreaM2(p), 0);
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, Math.round((part / whole) * 1000) / 10);
}

export function computeNature(raw: NatureRaw, ctx?: SiteContext): NatureResult {
  const circleAreaM2 = Math.PI * raw.effectiveRadiusM ** 2;

  const greenAreaM2 = Math.round(sumArea(raw.greenPolygons));
  const waterAreaM2 = Math.round(sumArea(raw.waterPolygons));
  const canopyAreaM2 = Math.round(sumArea(raw.canopyPolygons));

  const hectares = circleAreaM2 / 10000;

  const res: NatureResult = {
    effectiveRadiusM: raw.effectiveRadiusM,
    fetchFailed: raw.fetchFailed,
    circleAreaM2: Math.round(circleAreaM2),
    greenAreaM2,
    greenPct: pct(greenAreaM2, circleAreaM2),
    waterAreaM2,
    waterPct: pct(waterAreaM2, circleAreaM2),
    canopyAreaM2,
    canopyPct: pct(canopyAreaM2, circleAreaM2),
    treeCount: raw.treeCount,
    treeDensityHa: hectares > 0 ? Math.round((raw.treeCount / hectares) * 10) / 10 : 0,
    protectedZones: raw.protectedZones,
    protectedZonesFetchFailed: raw.protectedZonesFetchFailed,
    sol: null,
    sourceVerdure: "OSM",
    espaceVert300: raw.espaceVert300,
    lidar: raw.lidar,
    sourceCanopee: "OSM",
    solPerimetre: null,
    avecPerimetre: !!ctx?.perimetre,
    protectionsSurPerimetre: raw.protectionsSurPerimetre,
  };
  const cp = raw.cosiaPerimetre;
  if (cp && cp.totalM2 > 0)
    res.solPerimetre = { ...indicateursSol(cp), millesime: cp.millesime, couverturePct: Math.round(cp.couverturePct), surfaceM2: ctx?.perimetre?.surfaceGeomM2 ?? Math.round(cp.totalM2) };
  if (raw.cosia && raw.cosia.totalM2 > 0) {
    const ind = indicateursSol(raw.cosia);
    const tot = raw.cosia.totalM2;
    res.sol = {
      ...ind,
      millesime: raw.cosia.millesime,
      couverturePct: Math.round(raw.cosia.couverturePct),
      parts: CLASSES_COSIA.map((c) => ({ ...c, pct: Math.round((raw.cosia!.surfaces[c.id] / tot) * 1000) / 10 })).filter((c) => c.pct > 0),
    };
    // Mesure CoSIA plutôt que l'estimation OSM (polygones non découpés, jardins absents).
    res.greenPct = ind.vegetalisePct;
    res.canopyPct = ind.canopeePct;
    res.waterPct = Math.round((raw.cosia.surfaces.eau / tot) * 1000) / 10;
    res.sourceVerdure = "CoSIA";
    res.sourceCanopee = "CoSIA";
  }
  // Canopée mesurée en hauteur (végétation ≥ 3 m) : plus objective que la seule
  // vue d'avion (CoSIA compte aussi les arbustes bas en « feuillus »).
  if (raw.lidar && raw.lidar.couverturePct >= 50) {
    res.canopyPct = raw.lidar.canopeePct;
    res.sourceCanopee = "LiDAR HD";
  }
  return res;
}
