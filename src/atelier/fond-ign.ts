// Fond composé : le Plan IGN vectoriel (tuiles PLAN.IGN de la Géoplateforme,
// sans clé) avec le style officiel de l'IGN, découpé en thèmes que l'on
// allume un à un (eau et mer, végétation, voirie, voies ferrées, bâti et
// équipements, relief, limites, noms). Les éléments souterrains sont écartés.

export const STYLE_PLAN_IGN = "https://data.geopf.fr/annexes/ressources/vectorTiles/styles/PLAN.IGN/standard.json";
export const SPRITE_PLAN_IGN = "https://data.geopf.fr/annexes/ressources/vectorTiles/styles/PLAN.IGN/sprite/PlanIgn";

export const THEMES_IGN = [
  { id: "fond", titre: "Fond", actif: true, couches: ["fond_opaque", "bati_zone_surf"] },
  { id: "eau", titre: "Eau et mer", actif: true, couches: ["hydro_surf", "hydro_reseau", "hydro_reseau_sup", "hydro_ponc"] },
  { id: "vegetation", titre: "Végétation", actif: true, couches: ["ocs_vegetation_surf"] },
  { id: "sols", titre: "Sable, rochers", actif: true, couches: ["ocs_nature_sol_surf"] },
  { id: "voirie", titre: "Voirie", actif: true, couches: ["routier_surf", "routier_route", "routier_route_sup", "routier_chemin", "routier_chemin_sup", "routier_liaison", "routier_ponc"] },
  { id: "ferre", titre: "Voies ferrées", actif: true, couches: ["ferre", "ferre_sup"] },
  { id: "bati", titre: "Bâti et équipements", actif: false, couches: ["bati_zai", "bati_surf", "bati_lin", "bati_ponc"] },
  { id: "relief", titre: "Relief", actif: false, couches: ["oro_relief", "oro_courbe", "oro_lin", "oro_ponc"] },
  { id: "limites", titre: "Limites", actif: false, couches: ["limite_lin"] },
  { id: "noms", titre: "Noms", actif: true, couches: [] as string[] }, // toutes les couches toponyme_*
] as const;
export type ThemeIgn = (typeof THEMES_IGN)[number]["id"];

export function themeDe(sourceLayer: string): ThemeIgn | null {
  if (sourceLayer.startsWith("toponyme_")) return "noms";
  for (const t of THEMES_IGN) if ((t.couches as readonly string[]).includes(sourceLayer)) return t.id;
  return null; // souterrain, etc. : écarté
}

export interface CoucheIgn {
  layer: Record<string, unknown> & { id: string; type: string; paint?: Record<string, unknown> };
  theme: ThemeIgn;
}

/** Couches du style IGN, renommées « ign-… », source « plan_ign ». */
export async function chargerStylePlanIgn(): Promise<{ source: Record<string, unknown>; couches: CoucheIgn[] }> {
  const style = (await (await fetch(STYLE_PLAN_IGN)).json()) as {
    sources: Record<string, Record<string, unknown>>;
    layers: (Record<string, unknown> & { id: string; type: string; "source-layer"?: string })[];
  };
  const couches: CoucheIgn[] = [];
  for (const l of style.layers) {
    const theme = themeDe(l["source-layer"] ?? (l.type === "background" ? "fond_opaque" : ""));
    if (!theme) continue;
    const layer = { ...l, id: `ign-${l.id}`, source: l.type === "background" ? undefined : "plan_ign" } as CoucheIgn["layer"];
    if (l.type === "background") delete (layer as Record<string, unknown>).source;
    couches.push({ layer: { ...layer, layout: { ...((l.layout as object) ?? {}), visibility: "none" } }, theme });
  }
  return { source: style.sources.plan_ign, couches };
}

/** Propriété d'opacité par type de couche. */
export const OPACITE: Record<string, string[]> = {
  background: ["background-opacity"],
  fill: ["fill-opacity"],
  line: ["line-opacity"],
  symbol: ["text-opacity", "icon-opacity"],
  circle: ["circle-opacity"],
};
