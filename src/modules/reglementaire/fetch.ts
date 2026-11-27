// Récupération : zonage PLU (API Carto GPU), lien vers le règlement, SUP,
// et risques (Géorisques). Chaque appel est indépendant (Promise.all sur des
// fonctions qui catchent elles-mêmes) : l'échec d'une source n'empêche pas
// d'afficher les autres.
import { fetchJson } from "../../api/client";
import {
  gpuZoneUrba,
  gpuMunicipality,
  gpuWfsAtPoint,
  gpuSup,
  georisquesRga,
  georisquesSynthese,
  georisquesCatnat,
} from "../../api/endpoints";
import { fetchPatrimoine, corrigerTexte, type Patrimoine } from "../../core/patrimoine";
import type { SiteContext } from "../../core/types";
import { pointInPolygon } from "../../core/geo";
import { geometrieApi, intersectionGeoJsonM2, centreDeGravite } from "../../core/perimetre";

function sitePoint(ctx: SiteContext) {
  return { type: "Point", coordinates: [ctx.lon, ctx.lat] };
}

/** Emprise d'interrogation : le périmètre de projet s'il existe, sinon le point. */
function siteZone(ctx: SiteContext) {
  return ctx.perimetre ? geometrieApi(ctx.perimetre) : sitePoint(ctx);
}

const fixMojibake = corrigerTexte;

// --- Zonage PLU --------------------------------------------------------------
export interface ZonageFeatureProps {
  libelle?: string;
  typezone?: string;
  partition?: string;
  libelong?: string;
  /** URL du règlement écrit (souvent avec l'ancre de la page de la zone). */
  urlfic?: string | null;
  /** Date de validité du document (AAAAMMJJ). */
  datvalid?: string | null;
}
interface GpuFeatureCollection<P> {
  features: { properties: P; geometry?: { type: string; coordinates: unknown } }[];
}

/** Le point est-il dans un Polygon / MultiPolygon GeoJSON ([lon, lat]) ? */
function containsPoint(geometry: { type: string; coordinates: unknown } | undefined, lat: number, lon: number): boolean {
  if (!geometry) return false;
  const polys =
    geometry.type === "Polygon"
      ? [geometry.coordinates as number[][][]]
      : geometry.type === "MultiPolygon"
        ? (geometry.coordinates as number[][][][])
        : [];
  return polys.some((poly) => {
    const [outer, ...holes] = poly.map((ring) => ring.map(([x, y]) => ({ lat: y, lon: x })));
    return outer && pointInPolygon({ lat, lon }, outer) && !holes.some((h) => pointInPolygon({ lat, lon }, h));
  });
}

/** Secours WFS Géoplateforme : objets au point (polygones) ou à quelques mètres (lignes, points). */
async function wfsAtPoint<P>(
  ctx: SiteContext,
  typeName: Parameters<typeof gpuWfsAtPoint>[0],
): Promise<P[]> {
  const surfacic = typeName.endsWith("_s") || typeName === "wfs_du:zone_urba";
  const data = await fetchJson<GpuFeatureCollection<P>>(gpuWfsAtPoint(typeName, ctx.lat, ctx.lon), {
    cacheKey: `gpu-wfs:${typeName}`,
    ttlMs: 60 * 24 * 60 * 60 * 1000,
    timeoutMs: 15_000,
    retries: 1,
  });
  return (data.features ?? [])
    .filter((f) => !surfacic || containsPoint(f.geometry, ctx.lat, ctx.lon))
    .map((f) => f.properties);
}

/** `undefined` = service en échec (≠ `null` = aucun zonage au point). */
async function fetchZonage(ctx: SiteContext): Promise<ZonageFeatureProps | null | undefined> {
  try {
    const url = gpuZoneUrba(sitePoint(ctx));
    const data = await fetchJson<GpuFeatureCollection<ZonageFeatureProps>>(url, {
      cacheKey: "gpu:zone-urba",
      ttlMs: 60 * 24 * 60 * 60 * 1000, // un PLU change rarement d'une visite à l'autre
      timeoutMs: 15_000,
      retries: 2,
    });
    // API Carto peut renvoyer plusieurs zones (constaté le 12/11/2026, la
    // première n'étant pas celle du point) : on garde celle qui le contient.
    const atPoint = data.features.find((f) => containsPoint(f.geometry, ctx.lat, ctx.lon));
    return (atPoint ?? data.features[0])?.properties ?? null;
  } catch {
    // API Carto en panne : même donnée via le WFS de la Géoplateforme.
    try {
      const props = await wfsAtPoint<ZonageFeatureProps>(ctx, "wfs_du:zone_urba");
      return props[0] ?? null;
    } catch {
      return undefined;
    }
  }
}

async function fetchIsRnu(ctx: SiteContext): Promise<boolean | null> {
  if (!ctx.insee) return null;
  try {
    const url = gpuMunicipality(ctx.insee);
    const data = await fetchJson<{ features: { properties: { is_rnu?: boolean } }[] }>(url, {
      cacheKey: "gpu:municipality",
      ttlMs: 60 * 24 * 60 * 60 * 1000,
      timeoutMs: 15_000,
      retries: 2,
    });
    return data.features[0]?.properties?.is_rnu ?? null;
  } catch {
    return null;
  }
}

/** Lien vers le règlement : fourni directement par API Carto (champ `urlfic`).
 * L'ancienne route /api/document/{partition}/details du GPU répond 404. */
function documentUrlFrom(zonage: ZonageFeatureProps | null): string | null {
  const u = zonage?.urlfic;
  return typeof u === "string" && /^https?:\/\//.test(u) ? u : null;
}

// --- Servitudes d'utilité publique -------------------------------------------
export interface SupItem {
  categorie: string | null;
  libelle: string | null;
  /** Nature de l'assiette, ex. « Périmètre des abords ». */
  typeAssiette: string | null;
  /** Identifiant d'assiette, pour dédoublonner. */
  id: string | null;
}

interface GpuSupProps {
  // Noms réels observés sur l'API (constatés à l'usage, pas documentés
  // clairement) : le code de catégorie est "suptype" (ex. "AC1"), le libellé
  // lisible "nomsuplitt" (repli sur "nomass", plus technique).
  suptype?: string;
  nomsuplitt?: string;
  nomass?: string;
  typeass?: string;
  idass?: string;
}

async function fetchSupLayer(
  ctx: SiteContext,
  layer: "assiette-sup-s" | "assiette-sup-l" | "assiette-sup-p",
): Promise<SupItem[] | null> {
  try {
    const url = gpuSup(layer, siteZone(ctx));
    const data = await fetchJson<GpuFeatureCollection<GpuSupProps>>(
      url,
      { cacheKey: `gpu:${layer}`, ttlMs: 60 * 24 * 60 * 60 * 1000, timeoutMs: 15_000 },
    );
    return data.features.map((f) => toSupItem(f.properties));
  } catch {
    // API Carto en panne : mêmes assiettes via le WFS de la Géoplateforme.
    try {
      const wfsName = `wfs_sup:${layer.replace(/-/g, "_")}` as Parameters<typeof gpuWfsAtPoint>[0];
      return (await wfsAtPoint<GpuSupProps>(ctx, wfsName)).map(toSupItem);
    } catch {
      return null; // échec ≠ « aucune servitude »
    }
  }
}

function toSupItem(p: GpuSupProps): SupItem {
  const libelle = p.nomsuplitt ?? p.nomass ?? null;
  return {
    categorie: p.suptype?.toUpperCase() ?? null,
    libelle: libelle !== null ? fixMojibake(libelle) : null,
    typeAssiette: p.typeass ? fixMojibake(p.typeass) : null,
    id: p.idass ?? null,
  };
}

/** null si aucune des trois couches n'a répondu. Doublons d'assiette retirés. */
async function fetchSup(ctx: SiteContext): Promise<SupItem[] | null> {
  const layers = await Promise.all([
    fetchSupLayer(ctx, "assiette-sup-s"),
    fetchSupLayer(ctx, "assiette-sup-l"),
    fetchSupLayer(ctx, "assiette-sup-p"),
  ]);
  if (layers.every((l) => l === null)) return null;
  const seen = new Set<string>();
  const items: SupItem[] = [];
  for (const item of layers.flatMap((l) => l ?? [])) {
    const key = item.id ?? `${item.categorie}|${item.libelle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}

// --- Géorisques ----------------------------------------------------------------
export interface RgaResult {
  codeExposition: string;
  exposition: string;
}

async function fetchRga(ctx: SiteContext): Promise<RgaResult | null> {
  try {
    return await fetchJson<RgaResult>(georisquesRga(ctx.lat, ctx.lon), {
      cacheKey: "georisques:rga",
      ttlMs: 90 * 24 * 60 * 60 * 1000,
      timeoutMs: 15_000,
      retries: 1, // pas d'acharnement : cette API a des instabilités connues
    });
  } catch {
    return null;
  }
}

/** Réponse de /resultats_rapport_risque (vérifiée le 11/11/2026) : deux
 * familles, chacune un objet { cléRisque: { present, libelle, statuts } }. */
export interface RisqueSyntheseEntry {
  present?: boolean;
  libelle?: string;
  libelleStatutCommune?: string | null;
  libelleStatutAdresse?: string | null;
}
export interface RisqueSyntheseRaw {
  risquesNaturels?: Record<string, RisqueSyntheseEntry | undefined>;
  risquesTechnologiques?: Record<string, RisqueSyntheseEntry | undefined>;
  /** Lien vers le rapport Géorisques complet pour cette adresse. */
  url?: string;
}

async function fetchRisquesSynthese(ctx: SiteContext): Promise<RisqueSyntheseRaw | null> {
  try {
    return await fetchJson<RisqueSyntheseRaw>(georisquesSynthese(ctx.lat, ctx.lon), {
      cacheKey: "georisques:synthese",
      ttlMs: 30 * 24 * 60 * 60 * 1000,
      timeoutMs: 15_000,
      retries: 1,
    });
  } catch {
    return null; // module affichera "indisponible" plutôt qu'un plantage
  }
}

/** Champs réels de /gaspar/catnat (dates au format JJ/MM/AAAA). */
export interface CatnatItem {
  libelle_risque_jo?: string;
  date_debut_evt?: string;
  date_fin_evt?: string;
  date_publication_jo?: string;
  libelle_commune?: string;
}
export interface CatnatRaw {
  total: number;
  items: CatnatItem[];
}

/** null en cas d'échec : ne jamais l'afficher comme « aucun arrêté ». */
async function fetchCatnat(ctx: SiteContext): Promise<CatnatRaw | null> {
  try {
    const data = await fetchJson<{ results?: number; data?: CatnatItem[] | null }>(
      georisquesCatnat(ctx.lat, ctx.lon),
      { cacheKey: "georisques:catnat", ttlMs: 30 * 24 * 60 * 60 * 1000, timeoutMs: 15_000, retries: 1 },
    );
    if (!Array.isArray(data.data)) return null;
    return { total: data.results ?? data.data.length, items: data.data };
  } catch {
    return null;
  }
}

// --- Périmètre de projet ---------------------------------------------------------
export interface ZonePerimetre {
  libelle: string;
  typezone: string | null;
  /** Part du périmètre dans la zone (%). */
  pct: number;
  urlfic: string | null;
}

/** Zones du PLU qui recouvrent le périmètre, avec leur part. undefined = service en échec. */
async function fetchZonagesPerimetre(ctx: SiteContext): Promise<ZonePerimetre[] | undefined> {
  const p = ctx.perimetre;
  if (!p) return [];
  try {
    const data = await fetchJson<GpuFeatureCollection<ZonageFeatureProps>>(gpuZoneUrba(geometrieApi(p)), {
      cacheKey: "gpu:zone-urba-perimetre",
      ttlMs: 60 * 24 * 60 * 60 * 1000,
      timeoutMs: 20_000,
      retries: 2,
    });
    const parZone = new Map<string, ZonePerimetre & { m2: number }>();
    for (const f of data.features ?? []) {
      const m2 = intersectionGeoJsonM2(f.geometry, p.contour);
      if (m2 < 0.5) continue; // zone voisine qui ne fait que toucher la limite
      const libelle = f.properties.libelle ?? f.properties.libelong ?? "Zone sans libellé";
      const z = parZone.get(libelle) ?? { libelle, typezone: f.properties.typezone ?? null, pct: 0, urlfic: documentUrlFrom(f.properties), m2: 0 };
      z.m2 += m2;
      parZone.set(libelle, z);
    }
    const total = p.surfaceGeomM2;
    return [...parZone.values()]
      .map(({ m2, ...z }) => ({ ...z, pct: total > 0 ? Math.min(100, Math.round((m2 / total) * 1000) / 10) : 0 }))
      .sort((a, b) => b.pct - a.pct);
  } catch {
    return undefined;
  }
}

/** Exposition aux argiles au centre de chaque parcelle (12 au plus). */
async function fetchRgaParcelles(ctx: SiteContext): Promise<{ court: string; exposition: string | null }[]> {
  const parcelles = ctx.perimetre?.parcelles.slice(0, 12) ?? [];
  return Promise.all(
    parcelles.map(async (x) => {
      const c = centreDeGravite(x.geometrie);
      try {
        const r = await fetchJson<RgaResult>(georisquesRga(c.lat, c.lon), {
          cacheKey: "georisques:rga",
          ttlMs: 90 * 24 * 60 * 60 * 1000,
          timeoutMs: 15_000,
          retries: 1,
        });
        return { court: x.court, exposition: r.exposition ?? null };
      } catch {
        return { court: x.court, exposition: null };
      }
    }),
  );
}

// --- Assemblage ----------------------------------------------------------------
export interface ReglementaireRaw {
  zonage: ZonageFeatureProps | null;
  /** Le Géoportail de l'Urbanisme n'a pas répondu pour le zonage. */
  zonageFailed: boolean;
  isRnu: boolean | null;
  documentUrl: string | null;
  sup: SupItem[] | null;
  rga: RgaResult | null;
  risquesSynthese: RisqueSyntheseRaw | null;
  catnat: CatnatRaw | null;
  /** Monument historique le plus proche (servitudes AC1 du GPU, 1 km) ; null si non lu. */
  patrimoine: Patrimoine | null;
  /** true si un souci technique a touché au moins une source (affiché, pas cause de blocage). */
  partialFailure: boolean;
  /** Zones du PLU sur le périmètre de projet ([] sans périmètre, undefined si le service a échoué). */
  zonagesPerimetre: ZonePerimetre[] | undefined;
  /** Exposition RGA au centre de chaque parcelle du périmètre. */
  rgaParcelles: { court: string; exposition: string | null }[];
  /** Servitudes lues sur le périmètre de projet (et non au point). */
  surPerimetre: boolean;
}

export async function fetchReglementaire(ctx: SiteContext): Promise<ReglementaireRaw> {
  const [zonageRaw, isRnu, sup, rga, risquesSynthese, catnat, patrimoine, zonagesPerimetre, rgaParcelles] = await Promise.all([
    fetchZonage(ctx),
    fetchIsRnu(ctx),
    fetchSup(ctx),
    fetchRga(ctx),
    fetchRisquesSynthese(ctx),
    fetchCatnat(ctx),
    fetchPatrimoine(ctx.lat, ctx.lon, 1000).catch(() => null),
    fetchZonagesPerimetre(ctx),
    fetchRgaParcelles(ctx),
  ]);

  const zonageFailed = zonageRaw === undefined;
  const zonage = zonageRaw ?? null;
  const documentUrl = documentUrlFrom(zonage);

  const partialFailure =
    zonageFailed || rga === null || risquesSynthese === null || catnat === null || sup === null;

  return {
    zonage, zonageFailed, isRnu, documentUrl, sup, rga, risquesSynthese, catnat, patrimoine, partialFailure,
    zonagesPerimetre, rgaParcelles, surPerimetre: !!ctx.perimetre,
  };
}
