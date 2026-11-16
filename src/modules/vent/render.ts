// Rendu écran du module Vent : indicateurs, lecture en une phrase, roses
// normées hiver / été côte à côte, puis printemps, automne et année.
import { SECTOR_LABELS, SECTOR_NOMS, FORT_MS, RAFALE_MS, type SeasonRose, type VentResult } from "./compute";
import { echelleRose, legendeClasses, maxSecteur, roseSvg } from "./charts";

const fr = (v: number, d = 1) => v.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
const kmh = (ms: number) => Math.round(ms * 3.6);

function indicator(label: string, value: string, sous = ""): string {
  // L'indicateur s'affiche en ordre inverse (libellé, valeur, précision).
  return `<div class="indicator">${sous ? `<span class="ind-sous">${sous}</span>` : ""}<span class="ind-value">${value}</span><span class="ind-label">${label}</span></div>`;
}

/** Une heure sur N, pour les parts lisibles (« 1 heure sur 8 »). */
function uneSur(pct: number): string {
  if (pct <= 0.05) return "presque jamais";
  if (pct >= 50) return `${fr(pct, 0)} % du temps`;
  return `1 heure sur ${Math.round(100 / pct)}`;
}

function phraseSaison(nom: string, r: SeasonRose): string {
  const dom = SECTOR_NOMS[r.dominantSector];
  let p = `${nom}, le vent vient surtout du ${dom} (${fr(r.frequency[r.dominantSector], 0)} % des heures ventées)`;
  if (r.fortPct >= 0.5 && r.fortSecteur >= 0) {
    p += `, fort ${uneSur(r.fortPct)}`;
    if (r.fortSecteur !== r.dominantSector) p += `, alors surtout du ${SECTOR_NOMS[r.fortSecteur]}`;
  } else p += ", rarement fort";
  return p + ".";
}

export function renderVent(el: HTMLElement, r: VentResult): void {
  const a = r.annual;
  const roses = [r.bySeason.hiver, r.bySeason.ete, r.bySeason.printemps, r.bySeason.automne, a];
  const { pas, rmax } = echelleRose(maxSecteur(roses));

  el.innerHTML = `
    <div class="indicators">
      ${indicator("Direction dominante", SECTOR_LABELS[a.dominantSector], `vent du ${SECTOR_NOMS[a.dominantSector]}`)}
      ${indicator("Vitesse moyenne", `${fr(a.meanSpeedOverall)} m/s`, `${kmh(a.meanSpeedOverall)} km/h, hors calme`)}
      ${indicator(`Vent fort (≥ ${kmh(FORT_MS)} km/h)`, `${fr(a.fortPct)} %`, a.fortSecteur >= 0 ? `des heures, surtout du ${SECTOR_LABELS[a.fortSecteur]}` : "des heures")}
      ${r.joursRafales != null ? indicator(`Rafales ≥ ${kmh(RAFALE_MS)} km/h`, `${fr(r.joursRafales, 0)} j/an`, "modélisées, voir note") : ""}
      ${indicator("Calme (< 0,5 m/s)", `${fr(a.calmPct)} %`)}
    </div>
    <p class="vent-lecture">${phraseSaison("En hiver", r.bySeason.hiver)} ${phraseSaison("En été", r.bySeason.ete)}</p>
    <div class="rose-duo">
      ${roseSvg(r.bySeason.hiver, "Hiver · déc. à fév.", rmax, pas)}
      ${roseSvg(r.bySeason.ete, "Été · juin à août", rmax, pas)}
    </div>
    ${legendeClasses()}
    <details class="rose-plus">
      <summary>Printemps, automne et année</summary>
      <div class="rose-trio">
        ${roseSvg(r.bySeason.printemps, "Printemps", rmax, pas, 220)}
        ${roseSvg(r.bySeason.automne, "Automne", rmax, pas, 220)}
        ${roseSvg(a, "Année", rmax, pas, 220)}
      </div>
    </details>
    <p class="module-note">Roses normées : chaque pétale montre la part des heures où le vent
    vient de cette direction, découpée par classe de vitesse ; les pétales et le calme
    totalisent 100 %. Toutes les roses ont la même échelle. Vent horaire à 10 m sur
    ${r.years} ans (réanalyse ERA5, maille d'environ 30 km) : c'est le vent régional, sans
    les accélérations dues aux rues et aux bâtiments. Les rafales d'ERA5 sont calculées
    par le modèle, et souvent plus faibles que celles mesurées en station
    (Météo-France compte les jours où une rafale atteint 58 km/h).</p>
  `;
}
