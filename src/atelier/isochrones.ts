// Isochrones à pied : zones atteignables depuis le point du site en 5, 10 et
// 15 minutes de marche, calculées par le service d'itinéraire de la
// Géoplateforme (IGN) sur le réseau de la BD TOPO® (ressource
// bdtopo-valhalla, profil piéton). Sans clé. Le service fixe lui-même la
// vitesse de marche ; ni relief, ni attente aux feux ne sont modélisés ici.

import { fetchJson } from "../api/client";

const ISOCHRONE = "https://data.geopf.fr/navigation/isochrone";
export const DUREES_MIN = [5, 10, 15] as const;
/** Rampe verte, du plus proche (foncé) au plus lointain (clair). */
export const COULEURS_ISO: Record<number, string> = { 5: "#0f6e4a", 10: "#1baf7a", 15: "#86d4b0" };

interface ReponseIso {
  geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

/** Aire (ha) d'un polygone en lon/lat, projection locale. */
function aireHa(g: GeoJSON.Polygon | GeoJSON.MultiPolygon): number {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  let total = 0;
  for (const poly of polys)
    poly.forEach((anneau, k) => {
      const lat0 = anneau[0][1];
      const mx = 111_320 * Math.cos((lat0 * Math.PI) / 180), my = 110_540;
      let a = 0;
      for (let i = 0, j = anneau.length - 1; i < anneau.length; j = i++)
        a += (anneau[j][0] * mx) * (anneau[i][1] * my) - (anneau[i][0] * mx) * (anneau[j][1] * my);
      total += (k === 0 ? 1 : -1) * Math.abs(a / 2);
    });
  return total / 10_000;
}

export interface Isochrones {
  geojson: GeoJSON.FeatureCollection;
  /** Surface atteinte (ha) par durée ; absente si le service n'a pas répondu pour cette durée. */
  surfaces: Partial<Record<number, number>>;
}

export async function calculerIsochrones(lat: number, lon: number): Promise<Isochrones> {
  const resultats = await Promise.allSettled(
    DUREES_MIN.map((m) =>
      fetchJson<ReponseIso>(
        `${ISOCHRONE}?resource=bdtopo-valhalla&profile=pedestrian&costType=time&timeUnit=second` +
          `&costValue=${m * 60}&direction=departure&geometryFormat=geojson&point=${lon.toFixed(6)},${lat.toFixed(6)}`,
        { cacheKey: "ign:isochrone", ttlMs: 90 * 24 * 3600 * 1000, timeoutMs: 30_000 },
      ),
    ),
  );
  const features: GeoJSON.Feature[] = [];
  const surfaces: Partial<Record<number, number>> = {};
  // Du plus lointain au plus proche : le plus proche est dessiné par-dessus.
  for (let k = DUREES_MIN.length - 1; k >= 0; k--) {
    const r = resultats[k];
    const m = DUREES_MIN[k];
    if (r.status !== "fulfilled" || !r.value.geometry) continue;
    surfaces[m] = Math.round(aireHa(r.value.geometry));
    features.push({ type: "Feature", properties: { minutes: m, couleur: COULEURS_ISO[m], label: `${m} min à pied` }, geometry: r.value.geometry });
  }
  if (!features.length) throw new Error("Isochrones indisponibles");
  return { geojson: { type: "FeatureCollection", features }, surfaces };
}
