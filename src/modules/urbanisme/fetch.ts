// Récupération des emprises bâties via l'utilitaire partagé
// src/core/buildings.ts : IGN BD TOPO® en priorité (hauteur mesurée, plus
// précise), repli OpenStreetMap si le WFS échoue. Même source que le module
// Soleil, pour des CES/COS/hauteurs cohérents entre modules.
import type { SiteContext } from "../../core/types";
import { fetchBuildingsWithHeight, type BuildingSource } from "../../core/buildings";
import type { BuildingFootprint } from "../../core/osm-buildings";
import { dansContour, intersectionM2 } from "../../core/perimetre";

export const FALLBACK_RADIUS_M = 50;
export type { BuildingSource as HeightSource } from "../../core/buildings";

export interface UrbanismeRaw {
  effectiveRadiusM: number;
  buildings: BuildingFootprint[];
  heightSource: BuildingSource;
  fetchFailed: boolean;
  /** Bâtiments qui touchent le périmètre de projet (null sans périmètre). */
  buildingsPerimetre: BuildingFootprint[] | null;
}

export async function fetchUrbanisme(ctx: SiteContext): Promise<UrbanismeRaw> {
  const r = ctx.radiusM ?? FALLBACK_RADIUS_M;
  const { buildings, source } = await fetchBuildingsWithHeight(ctx, r);
  // Périmètre de projet plus large que le rayon : seconde lecture à sa mesure
  // (le rayon garde ses propres bâtiments, ses chiffres ne changent pas).
  let buildingsPerimetre: BuildingFootprint[] | null = null;
  const p = ctx.perimetre;
  if (p) {
    const rP = p.rayonEnglobantM + 10;
    const pool = rP > r ? (await fetchBuildingsWithHeight(ctx, rP)).buildings : buildings;
    // Tri rapide sur l'emprise du périmètre avant le découpage exact (coûteux).
    const pts = p.contour.flatMap((poly) => poly[0]);
    const [x0, x1] = [Math.min(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[0]))];
    const [y0, y1] = [Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[1]))];
    buildingsPerimetre = pool.filter(
      (b) =>
        b.polygon.some((q) => q.lon >= x0 && q.lon <= x1 && q.lat >= y0 && q.lat <= y1) &&
        (b.polygon.some((q) => dansContour(q, p.contour)) || intersectionM2(b.polygon, p.contour) > 0),
    );
  }
  return {
    effectiveRadiusM: r,
    buildings,
    heightSource: source,
    fetchFailed: source === "indisponible" && buildings.length === 0,
    buildingsPerimetre,
  };
}
