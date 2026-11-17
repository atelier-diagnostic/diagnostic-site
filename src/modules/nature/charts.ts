// Config Chart.js partagée écran/export : couverture du sol dans le rayon.
// Avec CoSIA : barre empilée à 100 % par classe (couleurs de la légende IGN).
// Sans CoSIA : répartition sommaire OpenStreetMap (végétalisé / eau / autre).
import type { ChartConfiguration } from "chart.js";
import type { NatureResult } from "./compute";

export function occupationSolConfig(r: NatureResult): ChartConfiguration {
  if (r.sol) {
    return {
      type: "bar",
      data: {
        labels: [`Couverture du sol (CoSIA ${r.sol.millesime})`],
        datasets: r.sol.parts.map((p) => ({ label: `${p.titre} ${p.pct.toLocaleString("fr-FR")} %`, data: [p.pct], backgroundColor: p.couleur, borderColor: "#ffffff", borderWidth: 1 })),
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 10 } } } },
        scales: { x: { stacked: true, max: 100, ticks: { callback: (v) => `${v} %` } }, y: { stacked: true, display: false } },
      },
    };
  }
  const autre = Math.max(0, 100 - r.greenPct - r.waterPct);
  return {
    type: "doughnut",
    data: {
      labels: ["Végétalisé", "Eau", "Autre (bâti, voirie, sol nu…)"],
      datasets: [{ data: [r.greenPct, r.waterPct, autre], backgroundColor: ["#27ae60", "#2980b9", "#bdc3c7"] }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } },
  };
}
