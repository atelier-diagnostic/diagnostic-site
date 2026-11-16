// Module Vent — assemble le contrat DiagnosticModule.
import type { DiagnosticModule, ExportBlock, SiteContext } from "../../core/types";
import { fetchVent, type VentRaw } from "./fetch";
import { computeVent, SECTOR_LABELS, SECTOR_NOMS, SEASON_LABELS, FORT_MS, RAFALE_MS, type VentResult } from "./compute";
import { renderVent } from "./render";
import { roseConfig } from "./charts";

export const ventModule: DiagnosticModule<VentRaw, VentResult> = {
  id: "vent",
  label: "Vent",
  icon: "🌬",
  scope: "site",

  fetchData(ctx: SiteContext) {
    return fetchVent(ctx);
  },

  compute(raw: VentRaw) {
    return computeVent(raw);
  },

  render(el: HTMLElement, result: VentResult) {
    renderVent(el, result);
  },

  toExport(result: VentResult): ExportBlock {
    const a = result.annual;
    const dominantLabel = SECTOR_LABELS[a.dominantSector];
    const kmh = (v: number) => Math.round(v * 3.6);
    const indicators = [
      { label: "Direction dominante", value: dominantLabel },
      { label: "Vitesse moyenne annuelle (hors calme)", value: `${a.meanSpeedOverall} m/s (${kmh(a.meanSpeedOverall)} km/h)` },
      { label: `Vent fort (≥ ${kmh(FORT_MS)} km/h)`, value: `${a.fortPct} % des heures${a.fortSecteur >= 0 ? `, surtout ${SECTOR_LABELS[a.fortSecteur]}` : ""}` },
      { label: "Calme (< 0,5 m/s)", value: `${a.calmPct} %` },
    ];
    if (result.joursRafales != null)
      indicators.push({ label: `Jours de rafales ≥ ${kmh(RAFALE_MS)} km/h (modélisées)`, value: `${result.joursRafales} j/an` });
    return {
      moduleId: "vent",
      title: "Vent",
      summary:
        `Vent dominant du ${SECTOR_NOMS[a.dominantSector]}, ${a.meanSpeedOverall} m/s en moyenne ` +
        `(calme ${a.calmPct} % du temps), fort (≥ ${kmh(FORT_MS)} km/h) ${a.fortPct} % des heures, ` +
        `sur ${result.years} ans de données horaires.`,
      indicators,
      charts: (["hiver", "ete"] as const).map((s) => ({
        title: `Rose des vents — ${SEASON_LABELS[s]}`,
        config: roseConfig(result.bySeason[s], SEASON_LABELS[s]),
      })).concat([{ title: "Rose des vents — année", config: roseConfig(a, "Année") }]),
      notes: [
        "Source : Open-Meteo (réanalyse ERA5, maille d'environ 30 km), vent horaire à 10 m sur 10 ans (fenêtre récente).",
        "Fréquences par direction d'origine (16 secteurs de 22,5°), découpées par classe de vitesse ; secteurs et calme totalisent 100 %.",
        "Rafales ERA5 calculées par le modèle, souvent plus faibles que les rafales mesurées en station.",
        "Les accélérations locales et l'effet canyon dépendent de la morphologie " +
          "bâtie et ne sont pas calculés ici (nécessitent une simulation CFD).",
      ],
    };
  },
};
