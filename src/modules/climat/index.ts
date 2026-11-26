// Module Climat — assemble le contrat DiagnosticModule.
// C'est LE gabarit de départ (voir README) : normales 1991-2020 + projections
// climatiques CMIP6 (horizons 2030/2050).
import type { DiagnosticModule, ExportBlock, SiteContext } from "../../core/types";
import { fetchClimatModule, type ClimatModuleRaw } from "./fetch";
import { computeClimat, computeProjectionHorizon, type ClimatResult } from "./compute";
import { renderClimat } from "./render";
import { koppen, traits, zoneRE2020 } from "./caractere";
import { tempPrecipConfig, rayonnementConfig, projectionsConfig } from "./charts";

export const climatModule: DiagnosticModule<ClimatModuleRaw, ClimatResult> = {
  id: "climat",
  label: "Climat",
  scope: "site",

  fetchData(ctx: SiteContext) {
    return fetchClimatModule(ctx);
  },

  compute(raw: ClimatModuleRaw) {
    const baseline = computeClimat(raw.baseline);
    // Un horizon sans aucun modèle exploitable (références indisponibles)
    // est retiré plutôt qu'affiché avec des valeurs vides.
    const projections = raw.projections
      .map((p) => computeProjectionHorizon(p.window.id, p.window.label, p.perModel, baseline))
      .filter((p) => p.nbModeles > 0);
    return { ...baseline, projections, site: raw.site };
  },

  render(el: HTMLElement, result: ClimatResult) {
    renderClimat(el, result);
  },

  toExport(result: ClimatResult): ExportBlock {
    const k = koppen(result.monthly.tMean, result.monthly.precip, result.site.lat);
    const t = traits(result.monthly, result.site.lat);
    const z = zoneRE2020(result.site.insee, result.site.altitude ?? null);
    const projectionNotes = result.projections.map((p) => {
      const pct = (v: number | null) => (v === null ? "n.d." : `${v > 0 ? "+" : ""}${v} %`);
      return (
        `${p.label} : temp. moyenne ${p.indicators.tMoyenneAnnuelle} °C ` +
        `(${p.deltaTemp > 0 ? "+" : ""}${p.deltaTemp} °C ; ${p.fourchette.tMoyenneAnnuelle.min} à ${p.fourchette.tMoyenneAnnuelle.max} °C selon les modèles), nuits tropicales ` +
        `${p.indicators.nuitsTropicales} j/an (${pct(p.pctNuitsTropicales)} ; ${p.fourchette.nuitsTropicales.min} à ${p.fourchette.nuitsTropicales.max}), ` +
        `jours ≥ 30 °C ${p.indicators.joursChaleur30} j/an (${pct(p.pctJours30)} ; ${p.fourchette.joursChaleur30.min} à ${p.fourchette.joursChaleur30.max}), ` +
        `vagues de chaleur ${p.indicators.vaguesChaleur}/an (${pct(p.pctVagues)}).` +
        (p.pluies.length
          ? " Pluies : " +
            p.pluies
              .map((s) => `${s.label.toLowerCase()} ${s.valeur} mm (${s.pct > 0 ? "+" : ""}${s.pct} % ; modèles ${s.pctMin > 0 ? "+" : ""}${s.pctMin} à ${s.pctMax > 0 ? "+" : ""}${s.pctMax} %)`)
              .join(", ") +
            "."
          : "")
      );
    });

    return {
      moduleId: "climat",
      title: "Climat",
      summary:
        `Climat ${k.nom.toLowerCase()} (${k.code} selon Köppen-Geiger). ` +
        `Température moyenne annuelle de ${result.tMoyenneAnnuelle} °C, ` +
        `${result.nuitsTropicales} nuits tropicales et ${result.joursChaleur30} jours ` +
        `≥ 30 °C par an en moyenne (normales 1991-2020).` +
        (result.projections.length > 0
          ? ` Projection à l'horizon 2050 : ${result.projections[result.projections.length - 1].indicators.tMoyenneAnnuelle} °C en moyenne annuelle.`
          : ""),
      indicators: [
        { label: "Climat (Köppen-Geiger)", value: `${k.code} — ${k.nom}` },
        ...result.projections.map((p) => {
          const k2 = koppen(result.monthly.tMean.map((v, i) => v + (p.deltaTMois[i] ?? 0)), result.monthly.precip, result.site.lat);
          return { label: `Köppen-Geiger — ${p.label} (températures projetées)`, value: k2.code === k.code ? `${k2.code} (inchangé)` : `${k2.code} — ${k2.nom}` };
        }),
        { label: "Amplitude thermique annuelle", value: `${t.amplitude} °C (${t.lectureContinentalite})` },
        { label: "Mois secs (Gaussen, P < 2T)", value: `${t.moisSecs.length}` },
        { label: "Pluie annuelle · bilan P − ETP", value: `${t.pluieAnnuelle} mm · ${t.bilan} mm (été ${t.bilanEte} mm)` },
        { label: "Jours de gel / an", value: `${result.joursGel}` },
        { label: "Rayonnement global annuel", value: `${t.rayonnementKwh} kWh/m²` },
        ...(z ? [{ label: "Zone climatique RE2020", value: `${z.zone}${z.altitude ? ` (altitude ${z.altitude})` : ""}` }] : []),
        { label: "Temp. moyenne annuelle", value: `${result.tMoyenneAnnuelle} °C` },
        { label: "DJU chauffage (base 18)", value: `${result.djuChauffage}` },
        { label: "DJU climatisation (base 18)", value: `${result.djuClim}` },
        { label: "Nuits tropicales / an", value: `${result.nuitsTropicales}` },
        { label: "Jours ≥ 30 °C / an", value: `${result.joursChaleur30}` },
        { label: "Jours ≥ 35 °C / an", value: `${result.joursChaleur35}` },
        ...result.projections.flatMap((p) =>
          p.pluies
            .filter((s) => s.id === "ete" || s.id === "hiver")
            .map((s) => ({
              label: `Pluies ${s.id === "ete" ? "d'été" : "d'hiver"} — ${p.label}`,
              value: `${s.valeur} mm (${s.pct > 0 ? "+" : ""}${s.pct} % ; modèles ${s.pctMin > 0 ? "+" : ""}${s.pctMin} à ${s.pctMax > 0 ? "+" : ""}${s.pctMax} %)`,
            })),
        ),
        ...result.projections.map((p) => ({
          label: `Temp. moyenne — ${p.label}`,
          value: `${p.indicators.tMoyenneAnnuelle} °C (${p.deltaTemp > 0 ? "+" : ""}${p.deltaTemp} °C)`,
        })),
      ],
      charts: [
        { title: "Diagramme ombrothermique (P = 2T)", config: tempPrecipConfig(result) },
        { title: "Rayonnement solaire mensuel", config: rayonnementConfig(result) },
        ...(result.projections.length > 0
          ? [
              {
                title: "Évolution nuits tropicales / jours de chaleur",
                config: projectionsConfig(result, result.projections),
              },
            ]
          : []),
      ],
      notes: [
        "Köppen-Geiger calculé sur les normales du site (critères de Peel et al. 2007 : mois le plus froid à 0 °C, été d'avril à septembre) ; " +
          "glissement aux horizons futurs avec les températures projetées mois par mois, pluies laissées à leurs normales pour ce classement (leur évolution, très incertaine, est donnée à part par saison).",
        "Mois secs au sens de Gaussen (P < 2T) ; continentalité de Gorczyński ; bilan hydrique P − ETP (ETP de référence FAO-56).",
        "Référence : Open-Meteo (réanalyse ERA5), période 1991-2020.",
        "DJU base 18 °C ; vague de chaleur simplifiée (≥ 3 j consécutifs Tmax ≥ 30 °C).",
        "Projections : Open-Meteo Climate API (CMIP6), moyenne d'un ensemble simplifié " +
          "de 3 modèles (couverture température et pluie complète). Pas de choix de scénario " +
          "d'émission possible : trajectoire proche de RCP8.5 jusqu'en 2050.",
        "Horizon 2050 = fin de la période disponible dans l'API (données jusqu'à 2050), " +
          "pas une valeur ponctuelle à cette date.",
        "Méthode des écarts : pour chaque modèle, écart entre l'horizon et sa propre " +
          "période 1991-2020, ajouté aux observations ERA5 ; la fourchette donne les valeurs " +
          "minimale et maximale entre modèles. Pluies : même méthode, en proportion (rapport " +
          "horizon / référence du modèle appliqué aux pluies observées).",
        "Horizons définis par périodes et scénario élevé, et non par niveaux de réchauffement : " +
          "proches, sans s'y confondre, de la trajectoire de référence française (TRACC : +2 °C en 2030, " +
          "+2,7 °C en 2050 en France). Référence officielle : Météo-France, Climadiag Commune " +
          "(référence 1976-2005, grille SAFRAN 8 km, ensemble de modèles régionaux corrigés, médiane) ; " +
          "ses comptages absolus peuvent différer de cette fiche, les hausses sont comparables.",
        ...projectionNotes,
      ],
    };
  },
};
