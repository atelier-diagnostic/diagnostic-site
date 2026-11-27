// Rendu écran du module Urbanisme.
import { Chart } from "chart.js/auto";
import type { ChartConfiguration } from "chart.js";
import { ORIENTATION_LABELS, type UrbanismeResult } from "./compute";
import { orientationConfig } from "./charts";
import { BUILDING_SOURCE_LABEL } from "../../core/buildings";
import { tableDeuxEchelles, entetePerimetre } from "../../ui/deux-echelles";

function indicator(label: string, value: string): string {
  return `<div class="indicator"><span class="ind-value">${value}</span><span class="ind-label">${label}</span></div>`;
}

const RISQUE_CLASS: Record<string, string> = {
  Faible: "risque-faible",
  Modéré: "risque-modere",
  Élevé: "risque-eleve",
  Indéterminé: "risque-indetermine",
};

export function renderUrbanisme(el: HTMLElement, r: UrbanismeResult): void {
  if (r.fetchFailed) {
    el.innerHTML = `<p class="error">Aucune source de bâtiments n'a répondu (IGN BD TOPO, puis
      OpenStreetMap en repli). Ce n'est pas une absence de bâti — réessayez dans quelques instants.</p>`;
    return;
  }
  if (r.buildingCount === 0) {
    el.innerHTML = `<p class="error">Aucun bâtiment identifié (IGN BD TOPO / OpenStreetMap) dans
      un rayon de ${r.effectiveRadiusM} m.</p>`;
    return;
  }

  const sourceNom = r.heightSource === "bdtopo" ? "IGN BD TOPO®" : "OpenStreetMap";
  const hauteurMethode =
    r.heightSource === "bdtopo"
      ? "attribut <code>hauteur</code> de la BD TOPO"
      : "tag <code>building:levels</code> × 3 m";

  const referenceLabel =
    r.referenceAreaSource === "parcelle_cadastrale"
      ? `Parcelle cadastrale${r.parcelleReference ? ` ${r.parcelleReference}` : ""} (${r.referenceAreaM2} m²)`
      : `Cercle de ${r.effectiveRadiusM} m (${r.referenceAreaM2} m²)`;

  const fr = (v: number, d = 0) => v.toLocaleString("fr-FR", { maximumFractionDigits: d });
  const p = r.perimetre;
  const deuxEchelles = p
    ? `${tableDeuxEchelles(
        [
          { label: "Bâtiments", perimetre: fr(p.batiments), rayon: fr(r.buildingCount) },
          { label: "Emprise bâtie", perimetre: `${fr(p.empriseM2)} m²`, rayon: `${fr(r.footprintAreaM2)} m²` },
          { label: "Emprise au sol (CES)", perimetre: `${fr(p.cesPct, 1)} %`, rayon: `${fr(r.cesPct, 1)} %` },
          { label: "COS approximatif", perimetre: fr(p.cosApprox, 2), rayon: fr(r.cosApprox, 2) },
          { label: "Hauteur moyenne", perimetre: p.meanHeightM !== null ? `${fr(p.meanHeightM, 1)} m` : "n.d.", rayon: r.meanHeightM !== null ? `${fr(r.meanHeightM, 1)} m` : "n.d." },
        ],
        entetePerimetre(p.surfaceM2),
        r.referenceAreaSource === "parcelle_cadastrale" ? "Parcelle de l'adresse" : `Rayon ${r.effectiveRadiusM} m`,
      )}
      <p class="module-note">Périmètre de projet : bâtiments découpés au contour des parcelles, rapportés à
      ${p.surfaceSource === "contenance" ? "la somme des contenances cadastrales" : "la surface du contour"} (${fr(p.surfaceM2)} m²) ;
      hauteur connue pour ${p.heightCoveragePct} % d'entre eux. Rayon : bâtiments entiers, estimation haute.</p>`
    : "";

  el.innerHTML = `
    ${deuxEchelles}
    <div class="indicators">
      ${indicator("Bâtiments recensés", `${r.buildingCount}`)}
      ${indicator("Source des hauteurs", BUILDING_SOURCE_LABEL[r.heightSource])}
      ${indicator("Surface de référence", referenceLabel)}
      ${indicator("Emprise au sol (CES)", `${r.cesPct} %`)}
      ${indicator("COS approximatif", `${r.cosApprox}`)}
      ${indicator("Hauteur moyenne estimée", r.meanHeightM !== null ? `${r.meanHeightM} m` : "n.d.")}
      ${indicator("Orientation dominante", ORIENTATION_LABELS[r.dominantOrientation])}
    </div>
    <div class="risque-badge ${RISQUE_CLASS[r.risqueIlotChaleur]}">
      Indice qualitatif d'îlot de chaleur : <strong>${r.risqueIlotChaleur}</strong>
    </div>
    <div class="chart-box"><canvas data-chart="orient"></canvas></div>
    <p class="module-note">${
      r.referenceAreaSource === "parcelle_cadastrale"
        ? "CES/COS calculés sur la surface cadastrale réelle (IGN PCI) — définition réglementaire correcte pour ce cadrage."
        : `Emprise au sol et COS estimés sur ${r.buildingCount} bâtiments ${sourceNom} dans un cercle de ${r.effectiveRadiusM} m (polygones non découpés au bord du cercle : estimation haute).`
    } Hauteur connue pour
    ${r.heightCoveragePct} % des bâtiments (${hauteurMethode}) ; le COS et la hauteur moyenne sont donc à lire avec prudence si ce
    taux est faible. L'indice d'îlot de chaleur est une heuristique simplifiée
    (densité + hauteur), pas une simulation d'îlot de chaleur urbain — à
    croiser avec la végétalisation du module Nature. Le confort des espaces
    publics (vent, ombre au niveau piéton) n'est pas calculé ici : il dépend
    de données de simulation non disponibles via API publique.</p>
  `;

  mountChart(el, "orient", orientationConfig(r));
}

function mountChart(el: HTMLElement, key: string, config: ChartConfiguration): void {
  const canvas = el.querySelector<HTMLCanvasElement>(`canvas[data-chart="${key}"]`);
  if (canvas) new Chart(canvas, config);
}
