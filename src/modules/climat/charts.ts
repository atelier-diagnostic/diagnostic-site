// Configs Chart.js partagées entre l'affichage (render) et l'export.
// Les garder ici évite toute divergence entre écran et rapport.
import type { ChartConfiguration } from "chart.js";
import type { ClimatResult } from "./compute";

const MOIS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

/**
 * Diagramme ombrothermique de Gaussen : précipitations (barres) et
 * température moyenne (trait) sur deux échelles calées P = 2T. Un mois est
 * sec quand la barre passe sous le trait (P < 2T) : il est teinté. Tmax et
 * Tmin en traits fins, pour l'amplitude.
 */
export function tempPrecipConfig(r: ClimatResult): ChartConfiguration {
  const { tMean, tMax, tMin, precip } = r.monthly;
  const pas = 5;
  const haut = Math.max(Math.ceil(Math.max(...tMax) / pas) * pas, Math.ceil(Math.max(...precip) / 2 / pas) * pas);
  const bas = Math.min(0, Math.floor(Math.min(...tMin) / pas) * pas);
  const sec = precip.map((p, i) => p < 2 * tMean[i]);
  return {
    type: "bar",
    data: {
      labels: MOIS,
      datasets: [
        {
          type: "line",
          label: "T° moyenne (°C)",
          data: tMean,
          borderColor: "#c0392b",
          backgroundColor: "transparent",
          borderWidth: 2.5,
          pointRadius: 2,
          yAxisID: "y",
          tension: 0.3,
          order: 0,
        },
        {
          type: "line",
          label: "T° max (°C)",
          data: tMax,
          borderColor: "rgba(192, 57, 43, 0.4)",
          backgroundColor: "transparent",
          borderWidth: 1,
          borderDash: [4, 3],
          pointRadius: 0,
          yAxisID: "y",
          tension: 0.3,
          order: 1,
        },
        {
          type: "line",
          label: "T° min (°C)",
          data: tMin,
          borderColor: "rgba(41, 128, 185, 0.55)",
          backgroundColor: "transparent",
          borderWidth: 1,
          borderDash: [4, 3],
          pointRadius: 0,
          yAxisID: "y",
          tension: 0.3,
          order: 1,
        },
        {
          type: "bar",
          label: "Précipitations (mm) — mois sec en orangé (P < 2T)",
          data: precip,
          backgroundColor: sec.map((x) => (x ? "rgba(230, 126, 34, 0.55)" : "rgba(52, 152, 219, 0.45)")),
          yAxisID: "y1",
          order: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        // Échelles liées : 1 °C = 2 mm (convention de Gaussen).
        y: { position: "left", min: bas, max: haut, title: { display: true, text: "°C" }, ticks: { stepSize: pas } },
        y1: {
          position: "right",
          min: 2 * bas,
          max: 2 * haut,
          title: { display: true, text: "mm (échelle = 2 × °C)" },
          grid: { drawOnChartArea: false },
          ticks: { stepSize: 2 * pas },
        },
      },
    },
  };
}

/** Rayonnement solaire mensuel (MJ/m²). */
export function rayonnementConfig(r: ClimatResult): ChartConfiguration {
  return {
    type: "bar",
    data: {
      labels: MOIS,
      datasets: [
        {
          label: "Rayonnement (MJ/m²)",
          data: r.monthly.rayonnement,
          backgroundColor: "rgba(243, 156, 18, 0.6)",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, title: { display: true, text: "MJ/m²" } } },
    },
  };
}

/** Comparaison référence / horizons de projection pour deux indicateurs clés. */
export function projectionsConfig(
  baseline: ClimatResult,
  horizons: { label: string; indicators: { nuitsTropicales: number; joursChaleur30: number } }[],
): ChartConfiguration {
  const labels = ["Référence 1991-2020", ...horizons.map((h) => h.label)];
  const nuitsTropicales = [baseline.nuitsTropicales, ...horizons.map((h) => h.indicators.nuitsTropicales)];
  const joursChaleur30 = [baseline.joursChaleur30, ...horizons.map((h) => h.indicators.joursChaleur30)];

  return {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Nuits tropicales / an",
          data: nuitsTropicales,
          backgroundColor: "rgba(192, 57, 43, 0.7)",
        },
        {
          label: "Jours ≥ 30 °C / an",
          data: joursChaleur30,
          backgroundColor: "rgba(243, 156, 18, 0.7)",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, title: { display: true, text: "jours / an" } } },
    },
  };
}
