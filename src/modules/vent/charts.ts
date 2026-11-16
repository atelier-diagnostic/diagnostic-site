// Roses des vents normées : 16 secteurs, pétales empilés par classe de vitesse.
// À l'écran : SVG dessiné ici (Chart.js n'a pas de rose empilée). Dans le
// rapport PDF : barres empilées Chart.js par direction (même données).
import type { ChartConfiguration } from "chart.js";
import { CLASSES, SECTOR_LABELS, SECTOR_NOMS, type SeasonRose } from "./compute";

/** Rampe ordinale bleue (clair → foncé = plus de vent), par mode. Les valeurs
 * viennent de la palette de référence (pas 250 à 700 en clair, 600 à 100 en sombre). */
export const RAMPE_CLAIR = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"];
export const RAMPE_SOMBRE = ["#184f95", "#256abf", "#3987e5", "#6da7ec", "#b7d3f6"];

const fr = (v: number, d = 1) => v.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });

/** Pas des cercles (%) et rayon maximal arrondi pour une fréquence `max`. */
export function echelleRose(max: number): { pas: number; rmax: number } {
  const pas = max <= 6 ? 2 : max <= 15 ? 5 : max <= 30 ? 10 : 20;
  return { pas, rmax: Math.max(pas, Math.ceil(max / pas) * pas) };
}

/** Fréquence maximale d'un secteur (toutes classes) pour un jeu de roses. */
export function maxSecteur(roses: SeasonRose[]): number {
  return Math.max(...roses.flatMap((r) => r.parClasse.map((c) => c.reduce((a, b) => a + b, 0))));
}

function point(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}

function couronne(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const f = (v: number) => v.toFixed(2);
  const [x1, y1] = point(cx, cy, r1, a0);
  const [x2, y2] = point(cx, cy, r1, a1);
  if (r0 <= 0.01) return `M${f(cx)},${f(cy)}L${f(x1)},${f(y1)}A${f(r1)},${f(r1)} 0 0 1 ${f(x2)},${f(y2)}Z`;
  const [x3, y3] = point(cx, cy, r0, a1);
  const [x4, y4] = point(cx, cy, r0, a0);
  return `M${f(x4)},${f(y4)}L${f(x1)},${f(y1)}A${f(r1)},${f(r1)} 0 0 1 ${f(x2)},${f(y2)}L${f(x3)},${f(y3)}A${f(r0)},${f(r0)} 0 0 0 ${f(x4)},${f(y4)}Z`;
}

/** Rose SVG. `rmax` (en %) est partagé entre les roses comparées. */
export function roseSvg(rose: SeasonRose, titre: string, rmax: number, pas: number, taille = 260): string {
  const c = taille / 2;
  const R = c - 22; // place pour les lettres des directions
  const k = R / rmax;
  const demi = (360 / 16) * 0.42; // pétale un peu plus étroit que le secteur : un fin vide entre pétales

  const cercles: string[] = [];
  for (let v = pas; v <= rmax + 1e-9; v += pas) {
    cercles.push(`<circle cx="${c}" cy="${c}" r="${(v * k).toFixed(1)}" class="rose-cercle"/>`);
    const [tx, ty] = point(c, c, v * k, 157.5);
    cercles.push(`<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" class="rose-pct">${v} %</text>`);
  }
  const axes = [0, 90, 180, 270]
    .map((a) => {
      const [x, y] = point(c, c, R, a);
      const [lx, ly] = point(c, c, R + 12, a);
      return `<line x1="${c}" y1="${c}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="rose-axe"/>` +
        `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" class="rose-dir">${["N", "E", "S", "O"][a / 90]}</text>`;
    })
    .join("");

  const petales = rose.parClasse
    .map((classes, s) => {
      const total = classes.reduce((a, b) => a + b, 0);
      if (total <= 0) return "";
      const angle = s * 22.5;
      let r0 = 0;
      const segs = classes
        .map((v, ci) => {
          if (v <= 0) return "";
          const r1 = r0 + v * k;
          const d = couronne(c, c, r0, r1, angle - demi, angle + demi);
          r0 = r1;
          return `<path d="${d}" class="rose-c${ci}"/>`;
        })
        .join("");
      const detail = classes.map((v, ci) => `${CLASSES[ci].label} : ${fr(v)} %`).join("\n");
      return `<g class="rose-petale"><title>Vent du ${SECTOR_NOMS[s]} (${SECTOR_LABELS[s]}) : ${fr(total)} % des heures\n${detail}</title>${segs}</g>`;
    })
    .join("");

  return `<figure class="rose">
    <figcaption>${titre}</figcaption>
    <svg viewBox="0 0 ${taille} ${taille}" role="img" aria-label="Rose des vents, ${titre}">
      ${cercles.join("")}${axes}${petales}
      <circle cx="${c}" cy="${c}" r="3" class="rose-centre"/>
    </svg>
    <p class="rose-calme">Calme ${fr(rose.calmPct)} %</p>
  </figure>`;
}

export function legendeClasses(): string {
  return `<ul class="rose-legende">${CLASSES.map((k, i) => `<li><span class="rose-pastille rose-c${i}"></span>${k.label} <span class="rose-kmh">${k.kmh}</span></li>`).join("")}</ul>`;
}

/** Version rapport : barres empilées par direction (Chart.js). */
export function roseConfig(rose: SeasonRose, title: string): ChartConfiguration {
  return {
    type: "bar",
    data: {
      labels: SECTOR_LABELS,
      datasets: CLASSES.map((k, i) => ({
        label: `${k.label} (${k.kmh})`,
        data: rose.parClasse.map((c) => c[i]),
        backgroundColor: RAMPE_CLAIR[i],
        borderColor: "#ffffff",
        borderWidth: 1,
      })),
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        title: { display: true, text: `${title} — fréquence par direction d'origine (%), calme ${fr(rose.calmPct)} %` },
        legend: { position: "bottom" },
      },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, title: { display: true, text: "% des heures" } },
      },
    },
  };
}
