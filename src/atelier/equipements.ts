// Ville du quart d'heure : équipements du quotidien atteignables à pied en
// 5, 10 et 15 minutes (dans les isochrones de l'IGN). Six fonctions, dans
// l'esprit de la « ville du quart d'heure » (C. Moreno) : apprendre, se
// soigner, s'approvisionner, s'épanouir, se déplacer, services publics.
//
// Deux sources, sans doublon : les équipements publics (enseignement,
// établissements de santé, sport, culture, espaces publics, mairies,
// postes) viennent de la BD TOPO® de l'IGN (zones d'activité ou d'intérêt,
// WFS) ; les commerces alimentaires, pharmacies, médecins, aires de jeux,
// arrêts de transport et vélos en libre-service viennent d'OpenStreetMap,
// que la BD TOPO ne recense pas. Si l'une ne répond pas, l'autre est
// affichée et le manque est dit.
//
// LIMITE : ces bases sont plus ou moins complètes selon les villes ; un
// équipement absent ici peut exister. La présence compte, pas la capacité.

import { fetchJson } from "../api/client";
import { OVERPASS } from "../api/endpoints";

export type Fonction = "apprendre" | "soigner" | "approvisionner" | "epanouir" | "deplacer" | "services";

/** Ordre fixe et couleurs catégorielles (jamais recyclées). */
export const FONCTIONS: { id: Fonction; titre: string; couleur: string; detail: string }[] = [
  { id: "apprendre", titre: "Apprendre", couleur: "#2a78d6", detail: "écoles, collèges, lycées, enseignement supérieur" },
  { id: "soigner", titre: "Se soigner", couleur: "#d6457a", detail: "établissements de santé, pharmacies, médecins, dentistes" },
  { id: "approvisionner", titre: "S'approvisionner", couleur: "#eb6834", detail: "alimentation, supermarchés, marchés" },
  { id: "epanouir", titre: "S'épanouir", couleur: "#c99000", detail: "sport, culture, espaces publics, aires de jeux" },
  { id: "deplacer", titre: "Se déplacer", couleur: "#3a3a3c", detail: "arrêts de bus et de tram, gares, vélos en libre-service" },
  { id: "services", titre: "Services publics", couleur: "#7a5cc2", detail: "mairies, bureaux de poste" },
];

// OpenStreetMap : seulement ce que la BD TOPO ne recense pas.
const AMENITY: Record<string, Fonction> = {
  pharmacy: "soigner", doctors: "soigner", dentist: "soigner",
  marketplace: "approvisionner",
  bicycle_rental: "deplacer",
};
const SHOPS = ["supermarket", "convenience", "bakery", "butcher", "greengrocer", "deli", "cheese", "seafood"];
const LEISURE = ["playground"];

/** BD TOPO : zone d'activité ou d'intérêt → fonction (null : hors du quotidien). */
function fonctionBdTopo(categorie: string, nature: string): Fonction | null {
  if (categorie === "Science et enseignement") return /Enseignement|Collège|Lycée|Université/i.test(nature) ? "apprendre" : null;
  if (categorie === "Santé") return /retraite/i.test(nature) ? null : "soigner";
  if (categorie === "Sport") return "epanouir";
  if (categorie === "Culture et loisirs")
    return /Monument|Point de vue|Construction|Hébergement|Vestige|exposition|Camping/i.test(nature) ? null : "epanouir";
  if (categorie === "Administratif ou militaire") return /Mairie|Poste/i.test(nature) ? "services" : null;
  return null;
}
const WFS = "https://data.geopf.fr/wfs/ows";

interface ZaiFeature {
  properties: { categorie?: string; nature?: string; toponyme?: string | null };
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon | GeoJSON.Point | null;
}

function centre(g: ZaiFeature["geometry"]): [number, number] | null {
  if (!g) return null;
  if (g.type === "Point") return g.coordinates as [number, number];
  const anneau = g.type === "Polygon" ? g.coordinates[0] : g.coordinates[0]?.[0];
  if (!anneau?.length) return null;
  let x = 0, y = 0;
  for (const [a, b] of anneau) {
    x += a;
    y += b;
  }
  return [x / anneau.length, y / anneau.length];
}

interface El {
  type: string;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function fonctionDe(t: Record<string, string>): Fonction | null {
  if (t.amenity && AMENITY[t.amenity]) return AMENITY[t.amenity];
  if (t.shop && SHOPS.includes(t.shop)) return "approvisionner";
  if (t.leisure && LEISURE.includes(t.leisure)) return "epanouir";
  if (t.highway === "bus_stop" || /^(station|tram_stop|halt)$/.test(t.railway ?? "")) return "deplacer";
  return null;
}

type Geom = GeoJSON.Polygon | GeoJSON.MultiPolygon;
function dansAnneau(x: number, y: number, a: number[][]): boolean {
  let dedans = false;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++)
    if (a[i][1] > y !== a[j][1] > y && x < ((a[j][0] - a[i][0]) * (y - a[i][1])) / (a[j][1] - a[i][1]) + a[i][0]) dedans = !dedans;
  return dedans;
}
function dans(x: number, y: number, g: Geom): boolean {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.some((p) => dansAnneau(x, y, p[0]) && !p.slice(1).some((trou) => dansAnneau(x, y, trou)));
}

export interface QuartDHeure {
  geojson: GeoJSON.FeatureCollection;
  /** Nombre d'équipements par fonction, cumulé à 5, 10 et 15 minutes. */
  comptes: Record<Fonction, Record<number, number>>;
  /** Sources qui n'ont pas répondu. */
  manques: ("IGN" | "OSM")[];
}

/** `isochrones` : polygones de l'IGN, propriété `minutes` (5, 10, 15). */
export async function recenserEquipements(isochrones: GeoJSON.FeatureCollection): Promise<QuartDHeure> {
  const zones = isochrones.features
    .filter((f) => f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"))
    .map((f) => ({ minutes: Number(f.properties?.minutes), g: f.geometry as Geom }))
    .sort((a, b) => a.minutes - b.minutes);
  if (!zones.length) throw new Error("Isochrones absentes");

  // Emprise de la plus grande isochrone.
  let s = 90, w = 180, n = -90, e = -180;
  for (const z of zones) {
    const polys = z.g.type === "Polygon" ? [z.g.coordinates] : z.g.coordinates;
    for (const p of polys)
      for (const [x, y] of p[0]) {
        if (y < s) s = y;
        if (y > n) n = y;
        if (x < w) w = x;
        if (x > e) e = x;
      }
  }
  const bb = `${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)}`;
  const query = `[out:json][timeout:40];(
    nwr["amenity"~"^(${Object.keys(AMENITY).join("|")})$"](${bb});
    nwr["shop"~"^(${SHOPS.join("|")})$"](${bb});
    nwr["leisure"~"^(${LEISURE.join("|")})$"](${bb});
    node["highway"="bus_stop"](${bb});
    node["railway"~"^(station|tram_stop|halt)$"](${bb});
  );out center tags;`;
  const [osm, ign] = await Promise.allSettled([
    fetchJson<{ elements: El[] }>(`${OVERPASS}?data=${encodeURIComponent(query)}`, {
      cacheKey: "overpass:quart-heure",
      ttlMs: 20 * 24 * 3600 * 1000,
      timeoutMs: 45_000,
      retries: 2,
    }),
    fetchJson<{ features: ZaiFeature[] }>(
      `${WFS}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=BDTOPO_V3:zone_d_activite_ou_d_interet` +
        `&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326&COUNT=3000&BBOX=${bb},urn:ogc:def:crs:EPSG::4326`,
      { cacheKey: "ign:zai-quart-heure", ttlMs: 60 * 24 * 3600 * 1000, timeoutMs: 30_000 },
    ),
  ]);
  if (osm.status === "rejected" && ign.status === "rejected") throw new Error("Sources indisponibles");

  const comptes = Object.fromEntries(FONCTIONS.map((f) => [f.id, { 5: 0, 10: 0, 15: 0 }])) as unknown as QuartDHeure["comptes"];
  const features: GeoJSON.Feature[] = [];
  const vus = new Set<string>();
  const ajouter = (fct: Fonction, lon: number, lat: number, nom: string, source: string) => {
    // Un même arrêt est souvent saisi deux fois (quai et poteau) : un point par nom et par fonction à 30 m près.
    const cle = `${fct}|${nom}|${Math.round(lat * 3000)}|${Math.round(lon * 3000)}`;
    if (nom && vus.has(cle)) return;
    vus.add(cle);
    const zone = zones.find((z) => dans(lon, lat, z.g));
    if (!zone) return;
    for (const m of [5, 10, 15]) if (zone.minutes <= m) comptes[fct][m]++;
    const def = FONCTIONS.find((f) => f.id === fct)!;
    features.push({
      type: "Feature",
      properties: { fonction: fct, couleur: def.couleur, titre: def.titre, nom, minutes: zone.minutes, source },
      geometry: { type: "Point", coordinates: [lon, lat] },
    });
  };
  if (ign.status === "fulfilled")
    for (const f of ign.value.features ?? []) {
      const fct = fonctionBdTopo(f.properties.categorie ?? "", f.properties.nature ?? "");
      const c = fct && centre(f.geometry);
      if (fct && c) ajouter(fct, c[0], c[1], f.properties.toponyme || f.properties.nature || "", "IGN BD TOPO®");
    }
  if (osm.status === "fulfilled")
    for (const el of osm.value.elements ?? []) {
      const t = el.tags ?? {};
      const fct = fonctionDe(t);
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (fct && lat != null && lon != null) ajouter(fct, lon, lat, t.name ?? "", "OpenStreetMap");
    }
  const manques: QuartDHeure["manques"] = [];
  if (ign.status === "rejected") manques.push("IGN");
  if (osm.status === "rejected") manques.push("OSM");
  return { geojson: { type: "FeatureCollection", features }, comptes, manques };
}
