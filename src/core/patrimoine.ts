// Patrimoine protégé autour du site, lu dans les servitudes d'utilité
// publique du Géoportail de l'Urbanisme (WFS de la Géoplateforme, sans clé) :
//   - AC1 : monuments historiques (l'édifice) et leurs abords ;
//   - AC2 : sites classés et inscrits ;
//   - AC4 : sites patrimoniaux remarquables (ex-ZPPAUP, AVAP, secteurs sauvegardés).
//
// LIMITE : toutes les servitudes ne sont pas encore publiées sur le GPU ;
// une absence ici ne garantit pas une absence réelle (à vérifier sur l'Atlas
// des patrimoines ou auprès de l'UDAP).

import { fetchJson } from "../api/client";

export type GenrePatrimoine = "mh" | "abords" | "site" | "spr";

export const GENRES: Record<GenrePatrimoine, { titre: string; couleur: string }> = {
  mh: { titre: "Monument historique", couleur: "#9b2d20" },
  abords: { titre: "Abords de monument historique", couleur: "#c4553f" },
  site: { titre: "Site classé ou inscrit", couleur: "#3d7a3a" },
  spr: { titre: "Site patrimonial remarquable", couleur: "#6b4fa8" },
};

/** Corrige un mojibake UTF-8 relu en Latin-1 (« TrinitÃ© » → « Trinité »), constaté sur les libellés SUP. */
export function corrigerTexte(s: string): string {
  if (!/[ÃÂ][\x80-\xBF]/.test(s)) return s;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
  } catch {
    return s;
  }
}

interface SupProps {
  suptype?: string;
  typeass?: string;
  nomsuplitt?: string;
  nomass?: string;
  idass?: string;
}

/** Genre d'une assiette SUP patrimoniale (null : autre servitude). */
export function genreDe(suptype: string | undefined, typeass: string | undefined): GenrePatrimoine | null {
  const t = (suptype ?? "").toLowerCase();
  const ty = corrigerTexte(typeass ?? "");
  if (t === "ac1") return /monument/i.test(ty) && !/abord|protection|périmètre|perimetre/i.test(ty) ? "mh" : "abords";
  if (t === "ac2") return "site";
  if (t === "ac4") return "spr";
  return null;
}

export interface Patrimoine {
  geojson: GeoJSON.FeatureCollection;
  /** Monument historique le plus proche du site (m, nom), null s'il n'y en a pas dans l'emprise. */
  plusProche: { nom: string; distanceM: number } | null;
}

function distanceM(lat: number, lon: number, g: GeoJSON.Geometry): number {
  const mx = 111_320 * Math.cos((lat * Math.PI) / 180), my = 110_540;
  let best = Infinity;
  const voir = (c: number[]) => {
    const d = Math.hypot((c[0] - lon) * mx, (c[1] - lat) * my);
    if (d < best) best = d;
  };
  const parcourir = (x: unknown): void => {
    if (Array.isArray(x) && typeof x[0] === "number") voir(x as number[]);
    else if (Array.isArray(x)) x.forEach(parcourir);
  };
  parcourir((g as { coordinates: unknown }).coordinates);
  return best;
}

export async function fetchPatrimoine(lat: number, lon: number, demiCoteM: number): Promise<Patrimoine> {
  const dLat = demiCoteM / 110_540, dLon = demiCoteM / (111_320 * Math.cos((lat * Math.PI) / 180));
  const bbox = [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((v) => v.toFixed(5)).join(",");
  const data = await fetchJson<{ features: { geometry: GeoJSON.Geometry | null; properties: SupProps }[] }>(
    "https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=wfs_sup:assiette_sup_s" +
      `&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326&COUNT=3000&BBOX=${bbox},urn:ogc:def:crs:EPSG::4326`,
    { cacheKey: "gpu:patrimoine", ttlMs: 30 * 24 * 3600 * 1000, timeoutMs: 30_000 },
  );
  const features: GeoJSON.Feature[] = [];
  const vus = new Set<string>();
  let plusProche: Patrimoine["plusProche"] = null;
  for (const f of data.features ?? []) {
    const genre = genreDe(f.properties.suptype, f.properties.typeass);
    if (!genre || !f.geometry) continue;
    const id = f.properties.idass ?? "";
    if (id && vus.has(id)) continue;
    vus.add(id);
    const nom = corrigerTexte(f.properties.nomsuplitt || f.properties.nomass || "");
    const type = corrigerTexte(f.properties.typeass ?? "");
    features.push({
      type: "Feature",
      properties: { genre, couleur: GENRES[genre].couleur, nom, type, titre: GENRES[genre].titre },
      geometry: f.geometry,
    });
    if (genre === "mh") {
      const d = distanceM(lat, lon, f.geometry);
      if (!plusProche || d < plusProche.distanceM) plusProche = { nom, distanceM: Math.round(d) };
    }
  }
  return { geojson: { type: "FeatureCollection", features }, plusProche };
}
