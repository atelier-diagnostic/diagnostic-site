// Périmètre de projet : une ou plusieurs parcelles cadastrales (ou un contour
// importé), fusionnées en un seul (multi)polygone.
//
// Deux échelles coexistent dans le diagnostic :
//   - le périmètre de projet : les chiffres « du terrain » (sols, bâti, zonage
//     touché, servitudes) ;
//   - le rayon d'analyse, recentré sur le centre du périmètre : le contexte
//     (quartier, mobilités, ombres, cartes de l'atelier).
//
// Rappel : le contour cadastral (PCI) est une représentation graphique, pas un
// document juridique. La surface « cadastrale » additionne les contenances
// officielles quand elles sont publiées.
import polygonClipping, { type MultiPolygon, type Polygon } from "polygon-clipping";
import { fetchJson } from "../api/client";
import { ignWfsParcelles, apicartoParcelle } from "../api/endpoints";
import { bboxAroundMeters, distanceMeters, type LatLon } from "./geo";

/** Coordonnées GeoJSON [lon, lat]. */
export type MultiPolygone = MultiPolygon;

export interface ParcelleChoisie {
  /** Identifiant unique (IDU cadastral si connu, sinon référence ou rang). */
  id: string;
  /** Référence lisible, ex. « 13204 000 AB 0123 ». */
  reference: string;
  /** Section et numéro seuls, ex. « AB 123 ». */
  court: string;
  surfaceM2: number;
  surfaceSource: "contenance" | "geometrie";
  geometrie: MultiPolygone;
}

export interface Perimetre {
  source: "cadastre" | "import";
  /** Vide pour un contour importé. */
  parcelles: ParcelleChoisie[];
  /** Union des parcelles (ou contour importé). */
  contour: MultiPolygone;
  /** Surface de référence : somme des contenances si toutes sont connues, sinon géométrie. */
  surfaceM2: number;
  surfaceSource: "contenance" | "geometrie";
  /** Surface recalculée depuis le contour fusionné. */
  surfaceGeomM2: number;
  /** Centre de gravité du contour (point d'analyse et centre du rayon). */
  centre: LatLon;
  /** Distance maximale du centre au contour (m). */
  rayonEnglobantM: number;
}

// --- Géométrie --------------------------------------------------------------

/** Projection locale en mètres autour d'une latitude de référence. */
function projecteur(lat0: number) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  return { kx, ky };
}

function aireAnneau(ring: [number, number][], kx: number, ky: number): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * kx * (y2 * ky) - x2 * kx * (y1 * ky);
  }
  return a / 2;
}

/** Aire (m²) d'un multipolygone GeoJSON, trous déduits. */
export function aireM2(mp: MultiPolygone): number {
  const lat0 = latMoyenne(mp);
  const { kx, ky } = projecteur(lat0);
  let total = 0;
  for (const poly of mp)
    poly.forEach((ring, i) => {
      const a = Math.abs(aireAnneau(ring as [number, number][], kx, ky));
      total += i === 0 ? a : -a;
    });
  return Math.max(0, total);
}

function latMoyenne(mp: MultiPolygone): number {
  let s = 0, n = 0;
  for (const poly of mp) for (const [, lat] of poly[0] ?? []) (s += lat), n++;
  return n ? s / n : 46;
}

/** Centre de gravité surfacique d'un multipolygone (trous déduits). */
export function centreDeGravite(mp: MultiPolygone): LatLon {
  const lat0 = latMoyenne(mp);
  const { kx, ky } = projecteur(lat0);
  let A = 0, X = 0, Y = 0;
  for (const poly of mp)
    poly.forEach((ring, k) => {
      const r = ring as [number, number][];
      let a = 0, cx = 0, cy = 0;
      for (let i = 0, n = r.length; i < n; i++) {
        const x1 = r[i][0] * kx, y1 = r[i][1] * ky;
        const x2 = r[(i + 1) % n][0] * kx, y2 = r[(i + 1) % n][1] * ky;
        const f = x1 * y2 - x2 * y1;
        a += f / 2;
        cx += (x1 + x2) * f;
        cy += (y1 + y2) * f;
      }
      if (Math.abs(a) < 1e-9) return;
      // Centre de l'anneau (indépendant de son sens), pondéré par son aire ;
      // les trous (anneaux suivants) sont retranchés.
      const poids = (k === 0 ? 1 : -1) * Math.abs(a);
      A += poids;
      X += poids * (cx / (6 * a));
      Y += poids * (cy / (6 * a));
    });
  if (Math.abs(A) < 1e-9) {
    const p = mp[0]?.[0]?.[0] ?? [0, 0];
    return { lat: p[1], lon: p[0] };
  }
  return { lon: X / A / kx, lat: Y / A / ky };
}

/** Le point est-il dans le multipolygone (trous exclus) ? */
export function dansContour(p: LatLon, mp: MultiPolygone): boolean {
  let dedans = false;
  for (const poly of mp)
    for (const ring of poly)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) dedans = !dedans;
      }
  return dedans;
}

/** Surface (m²) de l'intersection d'un polygone simple [LatLon] avec le contour. */
export function intersectionM2(poly: LatLon[], mp: MultiPolygone): number {
  if (poly.length < 3) return 0;
  const ring = poly.map((p) => [p.lon, p.lat] as [number, number]);
  try {
    return aireM2(polygonClipping.intersection([ring], mp));
  } catch {
    return 0; // géométrie dégénérée
  }
}

/** Intersection d'un (multi)polygone GeoJSON quelconque avec le contour (m²). */
export function intersectionGeoJsonM2(geometry: { type: string; coordinates: unknown } | undefined, mp: MultiPolygone): number {
  const g = versMulti(geometry);
  if (!g) return 0;
  try {
    return aireM2(polygonClipping.intersection(g, mp));
  } catch {
    return 0;
  }
}

/** Polygon / MultiPolygon GeoJSON → MultiPolygon ; null sinon. */
export function versMulti(geometry: { type: string; coordinates: unknown } | undefined | null): MultiPolygone | null {
  if (!geometry) return null;
  if (geometry.type === "Polygon") return [geometry.coordinates as Polygon];
  if (geometry.type === "MultiPolygon") return geometry.coordinates as MultiPolygon;
  return null;
}

/** Distance maximale du centre aux sommets du contour (m). */
function rayonEnglobant(mp: MultiPolygone, c: LatLon): number {
  let r = 0;
  for (const poly of mp) for (const [lon, lat] of poly[0] ?? []) r = Math.max(r, distanceMeters(c, { lat, lon }));
  return Math.ceil(r);
}

/** Géométrie à envoyer aux API (API Carto) : coordonnées arrondies au cm. */
export function geometrieApi(p: Perimetre): { type: "MultiPolygon"; coordinates: MultiPolygone } {
  const r = (v: number) => Math.round(v * 1e7) / 1e7;
  return { type: "MultiPolygon", coordinates: p.contour.map((poly) => poly.map((ring) => ring.map(([x, y]) => [r(x), r(y)] as [number, number]))) };
}

// --- Construction -------------------------------------------------------------

/** Fusionne les parcelles en un périmètre ; null si aucune. */
export function construirePerimetre(parcelles: ParcelleChoisie[]): Perimetre | null {
  if (parcelles.length === 0) return null;
  const [premiere, ...autres] = parcelles.map((p) => p.geometrie);
  const contour = autres.length ? polygonClipping.union(premiere, ...autres) : premiere;
  return completer({ source: "cadastre", parcelles, contour, toutesContenances: parcelles.every((p) => p.surfaceSource === "contenance"), somme: parcelles.reduce((s, p) => s + p.surfaceM2, 0) });
}

/** Périmètre depuis un contour importé (GeoJSON) ; null si aucune surface. */
export function perimetreImporte(geojson: unknown): Perimetre | null {
  const geoms: MultiPolygone[] = [];
  const visiter = (o: unknown): void => {
    if (!o || typeof o !== "object") return;
    const g = o as { type?: string; features?: unknown[]; geometry?: unknown; geometries?: unknown[]; coordinates?: unknown };
    if (g.type === "FeatureCollection") g.features?.forEach(visiter);
    else if (g.type === "Feature") visiter(g.geometry);
    else if (g.type === "GeometryCollection") g.geometries?.forEach(visiter);
    else {
      const m = versMulti(g as { type: string; coordinates: unknown });
      // Coordonnées en degrés attendues (WGS84) : un GeoJSON en Lambert-93 est refusé.
      if (m && m.every((poly) => poly.every((ring) => ring.every(([x, y]) => Math.abs(x) <= 180 && Math.abs(y) <= 90)))) geoms.push(m);
    }
  };
  visiter(geojson);
  if (geoms.length === 0) return null;
  const [a, ...b] = geoms;
  const contour = b.length ? polygonClipping.union(a, ...b) : a;
  return completer({ source: "import", parcelles: [], contour, toutesContenances: false, somme: 0 });
}

function completer(o: { source: Perimetre["source"]; parcelles: ParcelleChoisie[]; contour: MultiPolygone; toutesContenances: boolean; somme: number }): Perimetre | null {
  const surfaceGeomM2 = Math.round(aireM2(o.contour));
  if (surfaceGeomM2 <= 0) return null;
  const centre = centreDeGravite(o.contour);
  return {
    source: o.source,
    parcelles: o.parcelles,
    contour: o.contour,
    surfaceM2: o.toutesContenances ? Math.round(o.somme) : surfaceGeomM2,
    surfaceSource: o.toutesContenances ? "contenance" : "geometrie",
    surfaceGeomM2,
    centre,
    rayonEnglobantM: rayonEnglobant(o.contour, centre),
  };
}

/** GeoJSON du périmètre (contour et parcelles), pour l'export. */
export function versGeoJson(p: Perimetre): object {
  return {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { role: "perimetre", surface_m2: p.surfaceM2, surface_source: p.surfaceSource, parcelles: p.parcelles.map((x) => x.reference) }, geometry: { type: "MultiPolygon", coordinates: p.contour } },
      ...p.parcelles.map((x) => ({ type: "Feature", properties: { role: "parcelle", reference: x.reference, surface_m2: x.surfaceM2, surface_source: x.surfaceSource }, geometry: { type: "MultiPolygon", coordinates: x.geometrie } })),
    ],
  };
}

// --- Parcelles cadastrales ------------------------------------------------------

interface ParcelleFeature {
  id?: string;
  geometry?: { type: string; coordinates: unknown };
  properties?: Record<string, unknown>;
}

function versParcelle(f: ParcelleFeature): ParcelleChoisie | null {
  const geometrie = versMulti(f.geometry);
  if (!geometrie) return null;
  const p = f.properties ?? {};
  const s = (k: string) => (p[k] === undefined || p[k] === null ? "" : String(p[k]));
  const section = s("section");
  const numero = s("numero");
  const insee = s("code_insee") || (s("code_dep") && s("code_com") ? `${s("code_dep")}${s("code_com")}` : "");
  const comAbs = s("com_abs") || "000";
  const reference = section && numero ? `${insee ? `${insee} ` : ""}${comAbs} ${section} ${numero.padStart(4, "0")}`.trim() : "parcelle sans référence";
  const court = section && numero ? `${section} ${Number(numero) || numero}` : reference;
  const contenance = Number(p.contenance);
  const aGeom = Math.round(aireM2(geometrie));
  return {
    id: s("idu") || (section && numero ? `${insee}${comAbs}${section}${numero.padStart(4, "0")}` : f.id ?? `${aGeom}-${geometrie[0]?.[0]?.[0]?.join(",")}`),
    reference,
    court,
    surfaceM2: Number.isFinite(contenance) && contenance > 0 ? Math.round(contenance) : aGeom,
    surfaceSource: Number.isFinite(contenance) && contenance > 0 ? "contenance" : "geometrie",
    geometrie,
  };
}

/** Parcelle cadastrale contenant le point (WFS Parcellaire Express) ; null si aucune. */
export async function parcelleAuPoint(lat: number, lon: number): Promise<ParcelleChoisie | null> {
  const data = await fetchJson<{ features?: ParcelleFeature[] }>(ignWfsParcelles(bboxAroundMeters(lat, lon, 3)), {
    cacheKey: "ign-wfs:parcelle-clic",
    ttlMs: 180 * 24 * 60 * 60 * 1000,
    timeoutMs: 20_000,
    retries: 2,
  });
  for (const f of data.features ?? []) {
    const parcelle = versParcelle(f);
    if (parcelle && dansContour({ lat, lon }, parcelle.geometrie)) return parcelle;
  }
  return null;
}

/**
 * Parcelle par sa référence (API Carto Cadastre, sans clé). Saisie acceptée :
 * « AB 123 », « AB123 », « 000 AB 123 » (préfixe de commune absorbée).
 * Lève une erreur si la saisie n'est pas lisible ; null si introuvable.
 */
export async function parcelleParReference(insee: string, saisie: string): Promise<ParcelleChoisie | null> {
  const m = saisie.trim().toUpperCase().match(/^(?:(\d{3})\s*)?([0-9A-Z]{1,2})\s*0*(\d{1,4})$/);
  if (!m) throw new Error("Référence attendue : section et numéro, par exemple « AB 123 ».");
  const [, comAbs, section, numero] = m;
  const url = apicartoParcelle(insee, section.padStart(2, "0"), numero.padStart(4, "0"), comAbs);
  const data = await fetchJson<{ features?: ParcelleFeature[] }>(url, {
    cacheKey: "apicarto:cadastre-parcelle",
    ttlMs: 180 * 24 * 60 * 60 * 1000,
    timeoutMs: 20_000,
    retries: 1,
  });
  const f = (data.features ?? [])[0];
  return f ? versParcelle(f) : null;
}

// --- Mémoire locale ---------------------------------------------------------------

const CLE = "perimetre:v1:";

/** Clé de mémoire d'un site (ici : les coordonnées du point de l'adresse). */
function cleSite(cle: string): string {
  return CLE + cle.trim().toLowerCase();
}

/** Retient le périmètre du site (navigateur seulement) ; null l'efface. */
export function memoriser(label: string, p: Perimetre | null): void {
  try {
    if (p) localStorage.setItem(cleSite(label), JSON.stringify(p));
    else localStorage.removeItem(cleSite(label));
  } catch {
    /* stockage indisponible : le périmètre reste pour la session */
  }
}

/** Périmètre retenu pour ce site, s'il y en a un. */
export function relire(label: string): Perimetre | null {
  try {
    const t = localStorage.getItem(cleSite(label));
    if (!t) return null;
    const p = JSON.parse(t) as Perimetre;
    return Array.isArray(p.contour) && p.centre ? p : null;
  } catch {
    return null;
  }
}
