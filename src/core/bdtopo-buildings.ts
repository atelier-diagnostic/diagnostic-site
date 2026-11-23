// Récupération des bâtiments via IGN BD TOPO® (WFS Géoplateforme) — source la
// plus précise pour la hauteur des bâtiments. Extrait de soleil/fetch.ts pour
// être réutilisé aussi par le module Urbanisme (voir src/core/buildings.ts).
import { fetchJson } from "../api/client";
import { ignWfsBatiments } from "../api/endpoints";
import { bboxAroundMeters } from "./geo";
import type { BuildingFootprint, BuildingInfo } from "./osm-buildings";

interface IgnBatimentFeature {
  // BD TOPO v3 livre les bâtiments en MultiPolygon (souvent 3D : [lon, lat, z]).
  geometry: { type: string; coordinates: number[][][] | number[][][][] };
  properties: Record<string, unknown>;
}
interface IgnBatimentResponse {
  features: IgnBatimentFeature[];
}

function extractHeight(props: Record<string, unknown>): number | null {
  // Noms d'attributs BD TOPO usuels ; à ajuster si le schéma diffère (voir
  // note dans src/api/endpoints.ts).
  const candidates = ["hauteur", "HAUTEUR", "z_max", "altitude_max"];
  for (const key of candidates) {
    const v = props[key];
    if (typeof v === "number" && v > 0) return v;
  }
  return null;
}

/** Attributs BD TOPO v3 utiles à la fiche d'un bâtiment (lus défensivement). */
function extractInfo(props: Record<string, unknown>): BuildingInfo {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined);
  return {
    usage: str(props.usage_1),
    etages: num(props.nombre_d_etages),
    logements: num(props.nombre_de_logements),
    dateApparition: str(props.date_d_apparition),
    faitageM: (() => {
      const zt = props.altitude_maximale_toit, zs = props.altitude_minimale_sol;
      if (typeof zt !== "number" || typeof zs !== "number") return undefined;
      const h = zt - zs;
      return h > 1 && h < 400 ? h : undefined;
    })(),
  };
}

/** Anneaux extérieurs d'un Polygon ou d'un MultiPolygon (≥ 3 sommets). */
function outerRings(geometry: IgnBatimentFeature["geometry"] | undefined): number[][][] {
  if (!geometry?.coordinates) return [];
  const rings =
    geometry.type === "Polygon"
      ? [(geometry.coordinates as number[][][])[0]]
      : geometry.type === "MultiPolygon"
        ? (geometry.coordinates as number[][][][]).map((poly) => poly[0])
        : [];
  return rings.filter((r) => Array.isArray(r) && r.length >= 3);
}

// Le WFS plafonne chaque réponse (COUNT=5000) : en ville dense, un périmètre
// de 600 m dépasse ce nombre et le reste était silencieusement perdu (place
// Estrangin, Marseille, 18/11). L'emprise est donc découpée en dalles
// (≈ 400 m de côté au plus) demandées en parallèle, chaque dalle paginée
// (STARTINDEX) tant qu'une page revient pleine ; les bâtiments à cheval sur
// deux dalles sont dédoublonnés par leur identifiant (cleabs).
const PAGE = 5000;
const DALLE_M = 400;
const MAX_PAGES = 10;

async function dalle(bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number }, radiusM: number): Promise<IgnBatimentFeature[]> {
  const tout: IgnBatimentFeature[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = ignWfsBatiments(bbox) + `&SORTBY=cleabs&STARTINDEX=${page * PAGE}`;
    const data = await fetchJson<IgnBatimentResponse>(url, {
      cacheKey: `ign-wfs:batiments-${radiusM}m`,
      ttlMs: 30 * 24 * 60 * 60 * 1000,
      timeoutMs: 30_000,
      retries: 2,
    });
    const f = data.features ?? [];
    tout.push(...f);
    if (f.length < PAGE) break;
  }
  return tout;
}

/** Retourne null si le WFS échoue ou ne renvoie rien d'exploitable (déclenche le repli OSM). */
export async function fetchBdTopoBuildings(
  lat: number,
  lon: number,
  radiusM: number,
): Promise<BuildingFootprint[] | null> {
  try {
    const bbox = bboxAroundMeters(lat, lon, radiusM);
    const n = Math.max(1, Math.ceil((2 * radiusM) / DALLE_M));
    const dLat = (bbox.maxLat - bbox.minLat) / n, dLon = (bbox.maxLon - bbox.minLon) / n;
    const emprises: Parameters<typeof dalle>[0][] = [];
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        emprises.push({ minLat: bbox.minLat + i * dLat, maxLat: bbox.minLat + (i + 1) * dLat, minLon: bbox.minLon + j * dLon, maxLon: bbox.minLon + (j + 1) * dLon });
    // Quatre dalles à la fois : le WFS de l'IGN sature vite.
    const features: IgnBatimentFeature[] = [];
    let suivante = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, emprises.length) }, async () => {
        while (suivante < emprises.length) features.push(...(await dalle(emprises[suivante++], radiusM)));
      }),
    );
    if (features.length === 0) return null;

    const vus = new Set<string>();
    const buildings: BuildingFootprint[] = [];
    for (const f of features) {
      const id = typeof f.properties?.cleabs === "string" ? f.properties.cleabs : null;
      if (id) {
        if (vus.has(id)) continue;
        vus.add(id);
      }
      const heightM = extractHeight(f.properties);
      const info = extractInfo(f.properties ?? {});
      for (const ring of outerRings(f.geometry)) {
        buildings.push({
          polygon: ring.map(([lon2, lat2]) => ({ lat: lat2, lon: lon2 })),
          heightM,
          info,
        });
      }
    }
    // Rien d'exploitable : null pour déclencher le repli OSM.
    return buildings.length > 0 ? buildings : null;
  } catch {
    return null;
  }
}
