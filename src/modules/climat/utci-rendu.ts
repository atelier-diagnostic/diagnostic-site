// Affichage du confort extérieur (UTCI) : calendrier jour × heure de l'année
// médiane, sélecteur des quatre situations, et comparaison chiffrée.

import { CLASSES_UTCI, SITUATIONS, classeUtci, partHeures, type AnalyseUtci, type Situation } from "./utci";

const MOIS_COURTS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const JOURS_MOIS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const fr = (v: number, d = 0) => v.toLocaleString("fr-FR", { maximumFractionDigits: d });
const ETE = [5, 6, 7], HIVER = [11, 0, 1], ANNEE = [...Array(12).keys()];
const CHALEUR_FORTE = [7, 8, 9], CONFORT = [5], FROID_MODERE = [0, 1, 2, 3];

function dateDe(jour: number): string {
  let m = 0, j = jour;
  while (j >= JOURS_MOIS[m]) j -= JOURS_MOIS[m++];
  return `${j + 1} ${MOIS_COURTS[m]}`;
}

export function afficherUtci(slot: HTMLElement, a: AnalyseUtci): void {
  let situation: Situation = "soleil-vent";
  const ligne = (s: (typeof SITUATIONS)[number]) => {
    const c = (mois: number[], cl: number[]) => partHeures(a, s.id, mois, cl);
    return `<tr><th scope="row">${s.titre}</th><td>${fr(c(ETE, CHALEUR_FORTE))} %</td><td>${fr(c(ETE, CONFORT))} %</td><td>${fr(c(HIVER, FROID_MODERE))} %</td><td>${fr(c(ANNEE, CONFORT))} %</td></tr>`;
  };
  const p = (s: Situation, mois: number[], cl: number[]) => partHeures(a, s, mois, cl);
  const ombre = { avant: p("soleil-vent", ETE, CHALEUR_FORTE), apres: p("ombre-vent", ETE, CHALEUR_FORTE) };
  const abri = { avant: p("ombre-vent", HIVER, FROID_MODERE), apres: p("ombre-abri", HIVER, FROID_MODERE) };
  const abriSoleil = { avant: p("soleil-vent", HIVER, FROID_MODERE), apres: p("soleil-abri", HIVER, FROID_MODERE) };

  slot.innerHTML = `
    <div class="segmented seg-sm utci-situations" role="group" aria-label="Situation">
      ${SITUATIONS.map((s) => `<button type="button" data-situation="${s.id}" aria-pressed="${s.id === situation}">${s.titre}</button>`).join("")}
    </div>
    <div class="utci-graphe">
      <canvas aria-label="Stress thermique UTCI par jour et par heure"></canvas>
      <div class="utci-bulle" hidden></div>
    </div>
    <ul class="utci-legende">${[...CLASSES_UTCI].reverse().map((c) => `<li><i style="background:${c.couleur}"></i>${c.titre}</li>`).join("")}</ul>
    <p class="utci-lecture">
      <b>L'ombre</b> : en été, en journée, les heures de chaleur forte ou plus passent de ${fr(ombre.avant)} % au soleil à ${fr(ombre.apres)} % à l'ombre.
      <b>L'abri du vent</b> : en hiver, en journée, les heures de froid modéré ou plus passent de ${fr(abriSoleil.avant)} % à ${fr(abriSoleil.apres)} % au soleil, de ${fr(abri.avant)} % à ${fr(abri.apres)} % à l'ombre.
    </p>
    <table class="utci-table">
      <thead><tr><th></th><th>Été · chaleur forte ou plus</th><th>Été · sans stress</th><th>Hiver · froid modéré ou plus</th><th>Année · sans stress</th></tr></thead>
      <tbody>${SITUATIONS.map(ligne).join("")}</tbody>
    </table>
    <p class="module-note">Part des heures de jour (soleil levé), moyenne des mois de la période ; été = juin à août, hiver = décembre à février.
    Calendrier : UTCI médian de chaque jour et de chaque heure sur ${a.annees} années observées (2016-2025, réanalyse ERA5 via Open-Meteo).
    <b>UTCI</b> : température ressentie par une personne debout dehors, d'après l'air, l'humidité, le vent et le rayonnement reçu
    (polynôme de Bröde et al. 2012, identique à pythermalcomfort et Ladybug), classée en dix niveaux de stress.
    Au soleil : rayonnement direct, diffus et réfléchi par un sol d'albédo 0,2 reçu par une personne debout (méthode simplifiée de Thorsson et al. 2007) ;
    à l'ombre : ombre totale. Vent mesuré à 10 m (référence de l'UTCI) ; abrité = 0,5 m/s.
    <b>Limites</b> : le rayonnement des sols et façades surchauffés n'est pas compté, donc l'inconfort au soleil l'été en ville est sous-estimé ;
    maille de la réanalyse ≈ 10 km. Climat du site dans des situations types, pas une carte du confort rue par rue.</p>`;

  const canvas = slot.querySelector("canvas")!;
  const bulle = slot.querySelector<HTMLElement>(".utci-bulle")!;
  const M = { g: 34, d: 6, h: 6, b: 22 };
  const dessiner = () => {
    const W = Math.max(320, canvas.parentElement!.clientWidth), H = 250;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    const g = canvas.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const pw = W - M.g - M.d, ph = H - M.h - M.b, cw = pw / 365, ch = ph / 24;
    const v = a.medianes[situation];
    for (let j = 0; j < 365; j++)
      for (let h = 0; h < 24; h++) {
        const u = v[j * 24 + h];
        if (!Number.isFinite(u)) continue;
        g.fillStyle = CLASSES_UTCI[classeUtci(u)].couleur;
        // 0 h en bas, 23 h en haut (comme le diagramme de référence).
        g.fillRect(M.g + j * cw, M.h + ph - (h + 1) * ch, Math.ceil(cw + 0.5), Math.ceil(ch + 0.5));
      }
    const encre = getComputedStyle(slot).getPropertyValue("--muted") || "#8e8e93";
    g.fillStyle = encre;
    g.font = "10px -apple-system, 'Helvetica Neue', Arial, sans-serif";
    g.textAlign = "right";
    g.textBaseline = "middle";
    for (let h = 0; h <= 24; h += 6) g.fillText(`${h} h`, M.g - 5, M.h + ph - h * ch);
    g.textAlign = "center";
    g.textBaseline = "top";
    let debut = 0;
    JOURS_MOIS.forEach((n, m) => {
      g.fillText(MOIS_COURTS[m], M.g + (debut + n / 2) * cw, M.h + ph + 6);
      debut += n;
    });
    return { pw, ph, cw, ch };
  };
  let geo = dessiner();
  new ResizeObserver(() => (geo = dessiner())).observe(canvas.parentElement!);
  canvas.addEventListener("mousemove", (ev) => {
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left - M.g, y = ev.clientY - r.top - M.h;
    const j = Math.floor(x / geo.cw), h = 23 - Math.floor(y / geo.ch);
    if (j < 0 || j >= 365 || h < 0 || h > 23) {
      bulle.hidden = true;
      return;
    }
    const u = a.medianes[situation][j * 24 + h];
    if (!Number.isFinite(u)) return;
    bulle.hidden = false;
    bulle.innerHTML = `<b>${dateDe(j)}, ${h} h</b> · UTCI ${fr(u, 1)} °C · ${CLASSES_UTCI[classeUtci(u)].titre.toLowerCase()}`;
    bulle.style.left = `${Math.min(r.width - bulle.offsetWidth - 4, Math.max(4, ev.clientX - r.left - bulle.offsetWidth / 2))}px`;
    bulle.style.top = `${Math.max(0, ev.clientY - r.top - 36)}px`;
  });
  canvas.addEventListener("mouseleave", () => (bulle.hidden = true));
  slot.querySelectorAll<HTMLButtonElement>("[data-situation]").forEach((b) =>
    b.addEventListener("click", () => {
      situation = b.dataset.situation as Situation;
      slot.querySelectorAll("[data-situation]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      geo = dessiner();
    }),
  );
}
