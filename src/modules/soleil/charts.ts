// Configs Chart.js partagées écran/export.
import type { ChartConfiguration } from "chart.js";
import type { SoleilResult } from "./compute";

const MOIS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

/** Diagramme de masques : silhouette du masque bâti + trajectoires solaires. */
export function masqueSolaireConfig(r: SoleilResult): ChartConfiguration {
  // Marches de 10° : chaque secteur tracé de son bord gauche à son bord droit.
  const marches = (m: number[]) => [...m.flatMap((elev, i) => [{ x: i * 10, y: elev }, { x: i * 10 + 10, y: elev }])];

  const pathColors = ["#2980b9", "#f39c12", "#c0392b"];
  const pathDatasets = r.sunPaths.map((path, i) => ({
    label: path.label,
    data: path.points.map((p) => ({ x: p.azimuthDeg, y: p.elevationDeg })),
    borderColor: pathColors[i % pathColors.length],
    backgroundColor: "transparent",
    showLine: true,
    pointRadius: 0,
    borderWidth: 2,
  }));

  return {
    type: "line",
    data: {
      datasets: [
        ...(r.reliefMaskDeg
          ? [
              {
                label: "Relief (RGE ALTI, jusqu'à 30 km)",
                data: marches(r.reliefMaskDeg),
                borderColor: "rgba(122, 94, 58, 0.9)",
                backgroundColor: "rgba(166, 134, 92, 0.45)",
                fill: "origin" as const,
                pointRadius: 0,
                borderWidth: 1,
              },
            ]
          : []),
        {
          label: "Bâtiments",
          data: marches(r.batiMaskDeg),
          borderColor: "rgba(80, 80, 80, 0.7)",
          backgroundColor: "rgba(80, 80, 80, 0.3)",
          fill: "origin",
          pointRadius: 0,
          borderWidth: 1,
        },
        ...pathDatasets,
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      scales: {
        x: {
          type: "linear",
          min: 0,
          max: 360,
          title: { display: true, text: "Azimut (° depuis le Nord)" },
          ticks: { stepSize: 45 },
        },
        y: {
          min: 0,
          max: 90,
          title: { display: true, text: "Élévation (°)" },
        },
      },
    },
  };
}

export function ensoleillementConfig(r: SoleilResult): ChartConfiguration {
  return {
    type: "bar",
    data: {
      labels: MOIS,
      datasets: [
        {
          label: "Théorique (sans masque)",
          data: r.monthlyTheoreticalHours,
          backgroundColor: "rgba(243, 156, 18, 0.35)",
        },
        {
          label: "Réel estimé (bâti et relief)",
          data: r.monthlyMaskedHours,
          backgroundColor: "rgba(243, 156, 18, 0.85)",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, title: { display: true, text: "h / jour" } } },
    },
  };
}

export function pvConfig(monthlyKwhPerKwc: number[]): ChartConfiguration {
  return {
    type: "bar",
    data: {
      labels: MOIS,
      datasets: [
        {
          label: "Production estimée (kWh / kWc)",
          data: monthlyKwhPerKwc,
          backgroundColor: "rgba(39, 174, 96, 0.7)",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, title: { display: true, text: "kWh/kWc" } } },
    },
  };
}
