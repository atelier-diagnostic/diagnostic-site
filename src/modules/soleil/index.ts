// Module Soleil — assemble le contrat DiagnosticModule. Scope "quartier" :
// les masques dépendent des bâtiments voisins dans le rayon choisi.
import type { DiagnosticModule, ExportBlock, SiteContext } from "../../core/types";
import { fetchSoleil, type SoleilRaw } from "./fetch";
import { computeSoleil, svfLabel, type SoleilResult } from "./compute";
import { renderSoleil, reliefTexte } from "./render";
import { masqueSolaireConfig, ensoleillementConfig, pvConfig } from "./charts";

export const soleilModule: DiagnosticModule<SoleilRaw, SoleilResult> = {
  id: "soleil",
  label: "Soleil",
  icon: "☀️",
  scope: "quartier",

  fetchData(ctx: SiteContext) {
    return fetchSoleil(ctx);
  },

  compute(raw: SoleilRaw, ctx: SiteContext) {
    return computeSoleil(raw, ctx);
  },

  render(el: HTMLElement, result: SoleilResult, ctx: SiteContext) {
    renderSoleil(el, result, ctx);
  },

  toExport(result: SoleilResult): ExportBlock {
    const pvAvailable = result.pv !== null && result.pv.annualKwhPerKwc !== null;
    const charts = [
      { title: "Diagramme de masques", config: masqueSolaireConfig(result) },
      { title: "Durée d'ensoleillement mensuelle", config: ensoleillementConfig(result) },
    ];
    if (pvAvailable) {
      charts.push({ title: "Production PV mensuelle estimée", config: pvConfig(result.pv!.monthlyKwhPerKwc!) });
    }

    return {
      moduleId: "soleil",
      title: "Soleil",
      summary:
        `Heures de soleil possibles (ciel clair) ${result.annualMaskedHours} h/an (perte de ${result.maskLossPct} % ` +
        `due aux masques du bâti et du relief), SVF ${result.svf} (${svfLabel(result.svf)}), sur ${result.buildingCount} ` +
        `bâtiments voisins pris en compte.` +
        (pvAvailable
          ? ` Potentiel PV estimé : ${Math.round(result.pv!.annualKwhPerKwc!)} kWh/an pour 1 kWc installé.`
          : ""),
      indicators: [
        { label: "Bâtiments pris en compte", value: `${result.buildingCount}` },
        { label: "Source des hauteurs", value: result.heightSource },
        { label: "Couverture données hauteur", value: `${result.heightCoveragePct} %` },
        { label: "Heures de soleil possibles (ciel clair, hors nuages)", value: `${result.annualMaskedHours} h/an` },
        { label: "Perte due aux masques", value: `${result.maskLossPct} %` },
        { label: "Masque du relief", value: reliefTexte(result) },
        { label: "Facteur de vue du ciel (SVF)", value: `${result.svf} — ${svfLabel(result.svf)}` },
        ...(pvAvailable
          ? [{ label: "Production PV / kWc", value: `${Math.round(result.pv!.annualKwhPerKwc!)} kWh/an` }]
          : []),
      ],
      charts,
      notes: [
        "Masque bâti estimé par échantillonnage aux sommets des bâtiments (secteurs de 10°), " +
          "pas une silhouette exacte. Hypothèse de 9 m appliquée aux bâtiments sans hauteur connue.",
        "Source des hauteurs : IGN BD TOPO® si disponible, sinon OpenStreetMap (repli).",
        "Ensoleillement calculé sur un jour représentatif par mois (le 15), masques du bâti " +
          "et du relief — la nébulosité réelle est dans le module Climat.",
        result.relief
          ? "Relief : RGE ALTI® (IGN), 72 directions jusqu'à 30 km, œil à 1,5 m au-dessus du sol, " +
            "courbure terrestre et réfraction comprises ; modèle de terrain sans bâtiments ni arbres."
          : "Relief non pris en compte (service altimétrique IGN indisponible ou site hors couverture).",
        "SVF (facteur de vue du ciel) : formule d'Oke à partir du masque total — valeur " +
          "au point du site, pas une carte ; ne tient pas compte de la végétation.",
        "Pour une vue 3D précise (extrusion réelle, ombres portées, orthophoto, LiDAR), " +
          "utiliser l'héliodon complet accessible depuis l'application (lien dans le module).",
        pvAvailable
          ? "Potentiel PV : système fictif de 3 kWc, orientation/inclinaison optimales " +
            "(PVGIS), à ajuster à un projet réel."
          : "Estimation PV non disponible (proxy PVGIS non configuré ou service indisponible).",
      ],
    };
  },
};
