// Module Nature — assemble le contrat DiagnosticModule.
// Premier module de portée "quartier" : consomme ctx.radiusM directement
// dans sa requête Overpass (voir fetch.ts). Sert de gabarit pour Urbanisme.
import type { DiagnosticModule, ExportBlock, SiteContext } from "../../core/types";
import { fetchNature, type NatureRaw } from "./fetch";
import { computeNature, type NatureResult } from "./compute";
import { renderNature } from "./render";
import { occupationSolConfig } from "./charts";

export const natureModule: DiagnosticModule<NatureRaw, NatureResult> = {
  id: "nature",
  label: "Nature",
  icon: "🌳",
  scope: "quartier",

  fetchData(ctx: SiteContext) {
    return fetchNature(ctx);
  },

  compute(raw: NatureRaw) {
    return computeNature(raw);
  },

  render(el: HTMLElement, result: NatureResult) {
    renderNature(el, result);
  },

  toExport(result: NatureResult): ExportBlock {
    const sol = result.sol;
    const ev = result.espaceVert300;
    const protections = result.protectedZonesFetchFailed
      ? "Zonages de protection : non vérifiés (service indisponible)."
      : result.protectedZones.length > 0
        ? `${result.protectedZones.length} zonage(s) de protection sur le point (${result.protectedZones.map((z) => z.label).join(", ")}).`
        : "Aucun zonage de protection détecté sur le point.";
    const indicators = sol
      ? [
          { label: "Sols imperméabilisés (CoSIA)", value: `${sol.impermeabilisePct} %` },
          { label: "Pleine terre", value: `${sol.pleineTerrePct} %` },
          { label: "Végétalisé", value: `${sol.vegetalisePct} %` },
          { label: "Canopée", value: `${sol.canopeePct} %` },
          { label: "Coefficient de biotope (indicatif)", value: `${sol.cbs}` },
        ]
      : [
          { label: "Surface végétalisée (OSM)", value: `${result.greenPct} %` },
          { label: "Canopée (bois/forêt, OSM)", value: `${result.canopyPct} %` },
        ];
    const l = result.lidar;
    if (l)
      indicators.push(
        { label: "Indice de canopée (LiDAR HD, végétation ≥ 3 m)", value: `${l.canopeePct} %` },
        { label: "Arbres détectés (LiDAR HD)", value: `${l.nbArbres} (${l.densiteHa} / ha)` },
        { label: "Hauteur moyenne de la canopée", value: `${l.hMoy} m (90 % sous ${l.hP90} m)` },
      );
    const canRetenue = result.sourceCanopee === "LiDAR HD" ? result.canopyPct : sol ? sol.canopeePct : null;
    indicators.push(
      { label: `3-30-300 : canopée ≥ 30 %${result.sourceCanopee === "LiDAR HD" ? " (LiDAR HD)" : ""}`, value: canRetenue === null ? "n.d." : canRetenue >= 30 ? "atteint" : "non atteint" },
      {
        label: "3-30-300 : espace vert ≥ 1 ha à 300 m",
        value: ev === null ? "n.d." : ev.trouve ? `atteint (${ev.nom ?? "sans nom"}, ${ev.distanceM} m)` : "non atteint",
      },
      { label: "Arbres recensés (OSM)", value: result.fetchFailed ? "n.d." : `${result.treeCount}` },
      { label: "Rayon analysé", value: `${result.effectiveRadiusM} m` },
      { label: "Zonages de protection", value: result.protectedZonesFetchFailed ? "n.d." : `${result.protectedZones.length}` },
    );
    return {
      moduleId: "nature",
      title: "Nature",
      summary:
        (sol
          ? `Dans un rayon de ${result.effectiveRadiusM} m : ${sol.impermeabilisePct} % de sols imperméabilisés, ` +
            `${sol.vegetalisePct} % végétalisés, canopée ${sol.canopeePct} %, coefficient de biotope indicatif ${sol.cbs}. `
          : `Dans un rayon de ${result.effectiveRadiusM} m : ${result.greenPct} % de surface végétalisée (OpenStreetMap). `) + protections,
      indicators,
      charts: [{ title: "Couverture du sol", config: occupationSolConfig(result) }],
      notes: [
        sol
          ? `Couverture du sol : CoSIA (IGN), millésime ${sol.millesime}, mesurée pixel par pixel dans le cercle ; plans d'eau exclus des pourcentages.`
          : "Couverture du sol CoSIA indisponible : estimation OpenStreetMap (polygones non découpés au bord du rayon).",
        l
          ? `Canopée LiDAR : hauteur du sursol LiDAR HD (IGN) là où CoSIA voit de la végétation ligneuse ; végétation d'au moins 3 m ; arbres détectés par leurs sommets (bosquets serrés sous-comptés).`
          : "Canopée LiDAR non mesurée (LiDAR HD non publié ici ou indisponible).",
        "Coefficient de biotope indicatif : 0 bâti et sols imperméables, 0,5 zones perméables, 1 pleine terre ; toitures et murs végétalisés non détectés.",
        "Règle 3-30-300 : le critère des 3 arbres visibles depuis chaque logement n'est pas évaluable ici.",
        "Zonages de protection (Natura 2000, ZNIEFF, réserves, parcs) : source API Carto IGN/INPN, vérifiée sur le point précis.",
      ],
    };
  },
};
