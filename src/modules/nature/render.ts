// Rendu écran du module Nature : couverture du sol mesurée (CoSIA, IGN),
// coefficient de biotope, règle 3-30-300, puis OpenStreetMap (arbres) et
// zonages de protection.
import type { NatureResult } from "./compute";
import { COEF_CBS, CLASSES_COSIA } from "../../core/cosia";
import { CLASSES_HAUTEUR } from "../../core/canopee-lidar";

function indicator(label: string, value: string, sous = ""): string {
  return `<div class="indicator">${sous ? `<span class="ind-sous">${sous}</span>` : ""}<span class="ind-value">${value}</span><span class="ind-label">${label}</span></div>`;
}
const fr = (v: number, d = 1) => v.toLocaleString("fr-FR", { maximumFractionDigits: d });
const esc = (t: string) => t.replace(/[<>&"]/g, "");

function blocSol(r: NatureResult): string {
  if (!r.sol)
    return `<p class="error">Couverture du sol CoSIA (IGN) indisponible pour ce site (service muet ou zone non couverte).
      Les pourcentages ci-dessous viennent d'OpenStreetMap, moins fiables.</p>`;
  const s = r.sol;
  const barre = s.parts
    .map((p) => `<span style="width:${p.pct}%;background:${p.couleur}" title="${p.titre} : ${fr(p.pct)} %"></span>`)
    .join("");
  const legende = s.parts
    .filter((p) => p.pct >= 0.5)
    .map((p) => `<li><i style="background:${p.couleur}"></i>${p.titre} <b>${fr(p.pct)} %</b></li>`)
    .join("");
  const coefs = CLASSES_COSIA.filter((c) => COEF_CBS[c.id] !== null)
    .reduce((a, c) => {
      const k = String(COEF_CBS[c.id]);
      (a[k] ??= []).push(c.titre.toLowerCase());
      return a;
    }, {} as Record<string, string[]>);
  return `
    <div class="indicators">
      ${indicator("Sols imperméabilisés", `${fr(s.impermeabilisePct)} %`, "bâti, voirie, piscines, serres")}
      ${indicator("Pleine terre", `${fr(s.pleineTerrePct)} %`, "végétation et sols nus")}
      ${indicator("Végétalisé", `${fr(s.vegetalisePct)} %`)}
      ${indicator("Canopée", `${fr(s.canopeePct)} %`, "feuillus et conifères")}
      ${indicator("Coefficient de biotope", fr(s.cbs, 2), "indicatif, voir note")}
    </div>
    <div class="sol-barre" role="img" aria-label="Couverture du sol par classe">${barre}</div>
    <ul class="sol-legende">${legende}</ul>
    <p class="module-note">CoSIA (IGN, couverture du sol déduite des photos aériennes par intelligence artificielle),
    millésime ${s.millesime}, mesurée pixel par pixel dans le cercle de ${r.effectiveRadiusM} m
    (${s.couverturePct} % du cercle couvert). Pourcentages calculés sur les terres (plans d'eau exclus).
    Coefficient de biotope indicatif, sur le seul sol vu d'avion : coefficient 0 pour ${coefs["0"]?.join(", ")} ;
    0,5 pour les zones perméables (gravier, stabilisé) ; 1 pour la pleine terre (${coefs["1"]?.join(", ")}).
    Les toitures et murs végétalisés ne sont pas détectés ; le CBS réglementaire du PLU se calcule à la parcelle, sur plan.</p>`;
}

function blocCanopee(r: NatureResult): string {
  const l = r.lidar;
  if (!l)
    return `<p class="module-note">Canopée LiDAR non mesurée : le LiDAR HD de l'IGN n'est pas encore publié sur ce secteur, ou le service n'a pas répondu.</p>`;
  const barre = CLASSES_HAUTEUR.map((c, k) => `<span style="width:${l.partsHauteur[k]}%;background:${c.couleur}" title="${c.titre} : ${fr(l.partsHauteur[k])} %"></span>`).join("");
  const legende = CLASSES_HAUTEUR.map((c, k) => `<li><i style="background:${c.couleur}"></i>${c.titre} <b>${fr(l.partsHauteur[k])} %</b></li>`).join("");
  return `
    <div class="indicators">
      ${indicator("Indice de canopée", `${fr(l.canopeePct)} %`, "végétation ≥ 3 m, mesurée")}
      ${l.arbresDetectes ? indicator("Arbres détectés", `${l.nbArbres}`, `${fr(l.densiteHa)} / ha`) : indicator("Arbres détectés", "n.d.", "cercle > 1,1 km : canopée seule")}
      ${indicator("Hauteur moyenne", `${fr(l.hMoy)} m`, `90 % sous ${fr(l.hP90)} m`)}
      ${indicator("Plus grand arbre", `${fr(l.hMax)} m`)}
      ${indicator("Volume de houppiers", `${fr(l.volumeM3 / 1000, 0)} k m³`, "approché")}
    </div>
    <div class="sol-barre" role="img" aria-label="Canopée par classe de hauteur">${barre}</div>
    <ul class="sol-legende">${legende}</ul>
    <p class="module-note">Mesure : hauteur du sursol LiDAR HD de l'IGN (laser aéroporté, pixels de ${fr(l.pixelM)} m), retenue là où CoSIA ${l.millesimeCosia}
    voit des feuillus, des conifères ou des broussailles : toits, murs et véhicules sont écartés. Canopée = végétation d'au moins 3 m,
    rapportée au cercle de ${l.rayonM} m${l.couverturePct < 95 ? ` (données sur ${fr(l.couverturePct)} % du cercle)` : ""}.
    Arbres : sommets de la canopée (fenêtre variable selon la hauteur, Popescu et Wynne 2004) ; les bosquets serrés sont sous-comptés
    (houppiers jointifs), l'indice de canopée n'en dépend pas. Le millésime du LiDAR (2021 à 2025 selon les régions) et celui de CoSIA
    peuvent différer : un arbre abattu ou planté entre-temps peut fausser quelques pixels.</p>`;
}

function bloc33030(r: NatureResult): string {
  const ok = (b: boolean) => `<span class="pastille ${b ? "ok" : "ko"}">${b ? "atteint" : "non atteint"}</span>`;
  const can = r.sourceCanopee === "LiDAR HD" ? r.canopyPct : r.sol ? r.sol.canopeePct : null;
  const ev = r.espaceVert300;
  const l300 =
    ev === null
      ? `<span class="pastille nd">non évalué</span> OpenStreetMap n'a pas répondu.`
      : ev.trouve
        ? `${ok(true)} ${ev.nom ? `<strong>${esc(ev.nom)}</strong>, ` : ""}${fr(ev.surfaceHa ?? 0)} ha, à ${ev.distanceM} m${ev.distanceM === 0 ? " (le site y est)" : ""}.`
        : `${ok(false)} Aucun parc, jardin ou bois d'au moins 1 ha recensé dans OpenStreetMap à moins de 300 m.`;
  return `
    <ul class="regle-33">
      <li><b>3</b> arbres visibles depuis chaque logement : <span class="pastille nd">non évaluable</span> (dépend des vues depuis chaque fenêtre).</li>
      <li><b>30 %</b> de canopée dans le quartier : ${can === null ? `<span class="pastille nd">non évalué</span>` : `${ok(can >= 30)} ${fr(can)} % dans le cercle de ${r.effectiveRadiusM} m (${r.sourceCanopee === "LiDAR HD" ? "LiDAR HD, végétation ≥ 3 m" : "CoSIA, vue d'avion"}).`}</li>
      <li><b>300 m</b> au plus d'un espace vert d'au moins 1 ha : ${l300}</li>
    </ul>
    <p class="module-note">Règle proposée par C. Konijnendijk (2021), reprise par de nombreuses villes. Espaces verts : parcs,
    jardins, bois et aires de loisirs d'OpenStreetMap (contours simples ; les grands espaces décrits en multipolygone peuvent manquer).</p>`;
}

export function renderNature(el: HTMLElement, r: NatureResult): void {
  const protectionBlock = r.protectedZonesFetchFailed
    ? `<p class="error">Service de zonages de protection (API Carto IGN) indisponible pour le
       moment. Réessayer plus tard — ce n'est pas une absence de protection confirmée.</p>`
    : r.protectedZones.length > 0
      ? `<ul class="reg-list">${r.protectedZones.map((z) => `<li>${z.label}${z.siteName ? ` — ${z.siteName}` : ""}</li>`).join("")}</ul>`
      : `<p class="module-note">Aucun zonage de protection (Natura 2000, ZNIEFF, réserve, parc)
         détecté sur ce point précis.</p>`;

  const osm = r.fetchFailed
    ? `<p class="error">OpenStreetMap (Overpass) n'a pas répondu : arbres isolés non comptés. Réessayer plus tard.</p>`
    : `<div class="indicators">
        ${indicator("Arbres recensés", `${r.treeCount}`, "OpenStreetMap")}
        ${indicator("Densité d'arbres", `${fr(r.treeDensityHa)} / ha`)}
       </div>
       <p class="module-note">Arbres isolés saisis dans OpenStreetMap, très inégalement selon les villes : un ordre de grandeur, pas un inventaire.</p>`;

  el.innerHTML = `
    <h3 class="module-subtitle">Couverture du sol</h3>
    ${blocSol(r)}
    <h3 class="module-subtitle">Canopée mesurée (LiDAR HD)</h3>
    ${blocCanopee(r)}
    <h3 class="module-subtitle">Règle 3-30-300</h3>
    ${bloc33030(r)}
    <h3 class="module-subtitle">Arbres recensés (OpenStreetMap)</h3>
    ${osm}
    <h3 class="module-subtitle">Zonages de protection réglementaires</h3>
    ${protectionBlock}
    <p class="module-note">Source : API Carto (module Nature, IGN/INPN). Vérifié sur le point
    précis recherché, pas sur l'ensemble du rayon "quartier" — une zone protégée peut commencer
    juste en dehors du point sans apparaître ici.</p>
  `;
}
