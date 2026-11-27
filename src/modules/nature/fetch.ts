// Récupération des espaces verts/bleus et arbres via Overpass (OSM), dans le
// rayon d'analyse "quartier". Voir compute.ts pour les limites (polygones non
// découpés au bord du cercle).
//
// Ajoute aussi les zonages de protection réglementaires (Natura 2000, ZNIEFF,
// réserves, parcs) via l'API Carto module Nature de l'IGN. Contrairement à la
// verdure OSM (un proxy), ce sont de vrais zonages officiels — une info
// souvent déterminante en amont d'un projet.
import { fetchJson } from "../../api/client";
import { OVERPASS, natureLayerUrl } from "../../api/endpoints";
import type { SiteContext } from "../../core/types";
import { geometrieApi } from "../../core/perimetre";
import { polygonAreaM2, pointInPolygon, distanceMeters, type LatLon } from "../../core/geo";
import { analyserCosia, type CosiaResultat } from "../../core/cosia";
import { analyserCanopee, type CanopeeLidar } from "../../core/canopee-lidar";

/** Rayon minimal appliqué si l'utilisateur est en cadrage "Parcelle" : ce
 * module n'a de sens qu'à partir d'une échelle de voisinage. */
export const FALLBACK_RADIUS_M = 50;

interface OverpassElement {
  type: "way" | "node" | "relation";
  geometry?: { lat: number; lon: number }[];
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
}
interface OverpassResponse {
  elements: OverpassElement[];
}

// --- Zonages de protection (API Carto module Nature) ------------------------
// NOTE IMPORTANTE : le segment d'URL exact de chaque couche n'a pas pu être
// vérifié par un appel réel au moment de l'écriture (doc IGN peu explicite
// sur ce point précis). Les valeurs ci-dessous sont la meilleure estimation.
// Si une couche renvoie systématiquement une erreur, le fetch la catche et
// l'ignore (voir fetchProtectedZones) — à ajuster ici si besoin après test.
const PROTECTED_LAYERS: { layer: string; label: string }[] = [
  { layer: "natura-habitat", label: "Natura 2000 (directive habitat)" },
  { layer: "natura-oiseaux", label: "Natura 2000 (directive oiseaux)" },
  { layer: "znieff1", label: "ZNIEFF de type I" },
  { layer: "znieff2", label: "ZNIEFF de type II" },
  { layer: "pn", label: "Parc national" },
  { layer: "pnr", label: "Parc naturel régional" },
  { layer: "rnn", label: "Réserve naturelle nationale" },
  { layer: "rnc", label: "Réserve naturelle de Corse" },
];

export interface ProtectedZoneItem {
  label: string;
  /** Nom du site si l'API le fournit (ex. "Camargue") — plusieurs noms de
   * propriété possibles selon la couche, extraits défensivement. */
  siteName: string | null;
}

interface NatureFeature {
  properties?: Record<string, unknown>;
}
interface NatureFeatureCollection {
  features?: NatureFeature[];
}

function extractSiteName(props: Record<string, unknown> = {}): string | null {
  const candidates = ["sitename", "SITENAME", "nom", "NOM", "name", "NAME", "designation"];
  for (const key of candidates) {
    const v = props[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

async function fetchProtectedLayer(
  layer: string,
  label: string,
  ctx: SiteContext,
): Promise<{ success: boolean; items: ProtectedZoneItem[] }> {
  try {
    // Sur le périmètre de projet s'il existe (zonages qui le touchent), sinon au point.
    const geom = ctx.perimetre ? geometrieApi(ctx.perimetre) : { type: "Point", coordinates: [ctx.lon, ctx.lat] };
    const url = natureLayerUrl(layer, geom);
    const data = await fetchJson<NatureFeatureCollection>(url, {
      cacheKey: `apicarto-nature:${layer}`,
      ttlMs: 90 * 24 * 60 * 60 * 1000, // zonages officiels, très stables
      timeoutMs: 15_000,
      retries: 1,
    });
    return {
      success: true,
      items: (data.features ?? []).map((f) => ({ label, siteName: extractSiteName(f.properties) })),
    };
  } catch {
    return { success: false, items: [] }; // couche indisponible ou segment d'URL à ajuster
  }
}

/** `allFailed` = true si TOUTES les couches ont échoué (signal probable d'un
 * souci de segment d'URL plutôt que "vraiment aucune protection trouvée") —
 * distinction utile à l'affichage. */
async function fetchProtectedZones(
  ctx: SiteContext,
): Promise<{ zones: ProtectedZoneItem[]; allFailed: boolean }> {
  const results = await Promise.all(
    PROTECTED_LAYERS.map((l) => fetchProtectedLayer(l.layer, l.label, ctx)),
  );
  const zones = results.flatMap((r) => r.items);
  const allFailed = results.every((r) => !r.success);
  return { zones, allFailed };
}

export interface NatureRaw {
  effectiveRadiusM: number;
  greenPolygons: LatLon[][];
  waterPolygons: LatLon[][];
  canopyPolygons: LatLon[][]; // sous-ensemble "boisé" des espaces verts
  treeCount: number;
  /** true si Overpass a échoué : à distinguer d'un résultat "vraiment 0". */
  fetchFailed: boolean;
  protectedZones: ProtectedZoneItem[];
  protectedZonesFetchFailed: boolean;
  /** Couverture du sol CoSIA (IGN) dans le cercle ; null si indisponible. */
  cosia: CosiaResultat | null;
  /** Couverture du sol CoSIA dans le périmètre de projet ; null si aucun périmètre ou indisponible. */
  cosiaPerimetre: CosiaResultat | null;
  /** Zonages de protection lus sur le périmètre de projet (true) ou au point (false). */
  protectionsSurPerimetre: boolean;
  /** Canopée et arbres mesurés (LiDAR HD × CoSIA) ; null si indisponible ou non publié. */
  lidar: Omit<CanopeeLidar, "image" | "arbres"> & { nbArbres: number } | null;
  /** Règle 3-30-300 : espace vert d'au moins 1 ha à moins de 300 m ; null si non évalué. */
  espaceVert300: { trouve: boolean; nom: string | null; surfaceHa: number | null; distanceM: number | null } | null;
}

/** Espace vert ≥ 1 ha à moins de 300 m (OpenStreetMap ; contours simples, sans les multipolygones). */
async function fetchEspaceVert300(ctx: SiteContext): Promise<NatureRaw["espaceVert300"]> {
  const q = `[out:json][timeout:25];(
    way["leisure"~"^(park|garden|recreation_ground|nature_reserve)$"](around:300,${ctx.lat},${ctx.lon});
    way["landuse"~"^(forest|recreation_ground|village_green)$"](around:300,${ctx.lat},${ctx.lon});
    way["natural"="wood"](around:300,${ctx.lat},${ctx.lon});
  );out geom;`;
  try {
    const data = await fetchJson<OverpassResponse>(`${OVERPASS}?data=${encodeURIComponent(q)}`, {
      cacheKey: "overpass:espace-vert-300",
      ttlMs: 30 * 24 * 60 * 60 * 1000,
      timeoutMs: 25_000,
      retries: 2,
    });
    let best: NonNullable<NatureRaw["espaceVert300"]> = { trouve: false, nom: null, surfaceHa: null, distanceM: null };
    for (const el of data.elements) {
      if (el.type !== "way" || !el.geometry || el.geometry.length < 4) continue;
      const poly = el.geometry.map((p) => ({ lat: p.lat, lon: p.lon }));
      const ha = polygonAreaM2(poly) / 10_000;
      if (ha < 1) continue;
      const site = { lat: ctx.lat, lon: ctx.lon };
      const d = pointInPolygon(site, poly) ? 0 : Math.min(...poly.map((p) => distanceMeters(site, p)));
      if (d > 300) continue;
      if (!best.trouve || d < (best.distanceM ?? Infinity))
        best = { trouve: true, nom: el.tags?.name ?? null, surfaceHa: Math.round(ha * 10) / 10, distanceM: Math.round(d) };
    }
    return best;
  } catch {
    return null;
  }
}

function isGreenTag(tags: Record<string, string> = {}): boolean {
  return (
    ["wood", "scrub"].includes(tags.natural ?? "") ||
    ["forest", "meadow", "grass"].includes(tags.landuse ?? "") ||
    ["park", "garden"].includes(tags.leisure ?? "")
  );
}
function isCanopyTag(tags: Record<string, string> = {}): boolean {
  return tags.natural === "wood" || tags.landuse === "forest";
}
function isWaterTag(tags: Record<string, string> = {}): boolean {
  return tags.natural === "water" || tags.landuse === "basin";
}

export async function fetchNature(ctx: SiteContext): Promise<NatureRaw> {
  const r = ctx.radiusM ?? FALLBACK_RADIUS_M;

  const query = `
    [out:json][timeout:25];
    (
      way["natural"~"^(wood|scrub|water)$"](around:${r},${ctx.lat},${ctx.lon});
      way["landuse"~"^(forest|meadow|grass|basin)$"](around:${r},${ctx.lat},${ctx.lon});
      way["leisure"~"^(park|garden)$"](around:${r},${ctx.lat},${ctx.lon});
      node["natural"="tree"](around:${r},${ctx.lat},${ctx.lon});
    );
    out geom;
  `.trim();

  // CoSIA (IGN) et espace vert à 300 m : indépendants d'Overpass pour la verdure.
  const p = ctx.perimetre;
  const [{ zones: protectedZones, allFailed: protectedZonesFetchFailed }, cosia, cosiaPerimetre, espaceVert300, lidar] = await Promise.all([
    fetchProtectedZones(ctx),
    analyserCosia(ctx.lat, ctx.lon, Math.max(r, 50)).catch(() => null),
    p ? analyserCosia(p.centre.lat, p.centre.lon, Math.max(p.rayonEnglobantM, 5), p.contour).catch(() => null) : Promise.resolve(null),
    fetchEspaceVert300(ctx),
    analyserCanopee(ctx.lat, ctx.lon, Math.max(r, 50))
      .then(({ image: _i, arbres, ...reste }) => ({ ...reste, nbArbres: arbres.length }))
      .catch(() => null),
  ]);

  try {
    const url = `${OVERPASS}?data=${encodeURIComponent(query)}`;
    const data = await fetchJson<OverpassResponse>(url, {
      cacheKey: `overpass:nature-${r}m`,
      ttlMs: 30 * 24 * 60 * 60 * 1000,
      timeoutMs: 25_000,
      retries: 2,
    });

    const greenPolygons: LatLon[][] = [];
    const waterPolygons: LatLon[][] = [];
    const canopyPolygons: LatLon[][] = [];
    let treeCount = 0;

    for (const el of data.elements) {
      if (el.type === "node" && el.tags?.natural === "tree") {
        treeCount++;
        continue;
      }
      if (el.type !== "way" || !el.geometry || el.geometry.length < 3) continue;
      const poly = el.geometry.map((p) => ({ lat: p.lat, lon: p.lon }));
      if (isWaterTag(el.tags)) waterPolygons.push(poly);
      else if (isGreenTag(el.tags)) {
        greenPolygons.push(poly);
        if (isCanopyTag(el.tags)) canopyPolygons.push(poly);
      }
    }

    return {
      effectiveRadiusM: r,
      greenPolygons,
      waterPolygons,
      canopyPolygons,
      treeCount,
      fetchFailed: false,
      protectedZones,
      protectedZonesFetchFailed,
      cosia,
      cosiaPerimetre,
      protectionsSurPerimetre: !!p,
      espaceVert300,
      lidar,
    };
  } catch {
    // Overpass indisponible/timeout : le module l'affichera explicitement,
    // pas comme un site sans verdure ni eau.
    return {
      effectiveRadiusM: r,
      greenPolygons: [],
      waterPolygons: [],
      canopyPolygons: [],
      treeCount: 0,
      fetchFailed: true,
      protectedZones,
      protectedZonesFetchFailed,
      cosia,
      cosiaPerimetre,
      protectionsSurPerimetre: !!p,
      espaceVert300,
      lidar,
    };
  }
}
