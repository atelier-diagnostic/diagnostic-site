// Rendu écran du module Réglementaire.
import type { ReglementaireResult } from "./compute";

function indicator(label: string, value: string): string {
  return `<div class="indicator"><span class="ind-value">${value}</span><span class="ind-label">${label}</span></div>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Statut Géorisques mis en forme : « Risque Existant - important » → « Existant – important ». */
function statut(s: string | null): string {
  if (!s) return `<span class="module-note">n.d.</span>`;
  const t = s.replace(/^Risque\s+/i, "").replace(/\s+-\s+/, " – ");
  const fort = /existant|concerne$/i.test(t) && !/non\s+concern/i.test(t);
  return fort ? `<strong>${esc(t)}</strong>` : esc(t);
}

const GENRE_TXT: Record<string, string> = {
  mh: "sur un monument historique",
  abords: "dans les abords d'un monument historique",
  site: "dans un site classé ou inscrit",
  spr: "dans un site patrimonial remarquable",
};
function patrimoineBlock(r: ReglementaireResult): string {
  if (r.patrimoineAuPoint === null)
    return `<p class="error">Protections patrimoniales non vérifiées : le Géoportail de l'Urbanisme n'a pas répondu.</p>`;
  const proche = r.mhPlusProche
    ? ` Monument historique le plus proche : <strong>${esc(r.mhPlusProche.nom)}</strong>, à ${r.mhPlusProche.distanceM} m.`
    : "";
  if (!r.patrimoineAuPoint.length)
    return `<p>Aucune protection patrimoniale publiée ${r.surPerimetre ? "sur le périmètre de projet" : "au point"} (monument historique, abords, site, site patrimonial remarquable).${proche}</p>
      <p class="module-note">Toutes les servitudes ne sont pas encore publiées sur le Géoportail de l'Urbanisme : à confirmer sur l'Atlas des patrimoines ou auprès de l'UDAP. Carte dans l'atelier, thème Patrimoine.</p>`;
  const lignes = r.patrimoineAuPoint
    .map((p) => `<li>${r.surPerimetre ? "Le périmètre est (au moins en partie)" : "Le site est"} ${GENRE_TXT[p.genre]}${p.libelle ? ` : <strong>${esc(p.libelle)}</strong>` : ""}.</li>`)
    .join("");
  const abf = r.patrimoineAuPoint.some((p) => p.genre !== "site")
    ? `<p>Les travaux y sont soumis à l'Architecte des Bâtiments de France (UDAP) : à associer tôt au projet.</p>`
    : `<p>En site classé, les travaux relèvent d'une autorisation spéciale (ministre ou préfet) ; en site inscrit, d'une déclaration préalable avec avis de l'ABF.</p>`;
  return `<ul class="reg-list">${lignes}</ul>${abf}<p class="module-note">${proche.trim()} Carte dans l'atelier, thème Patrimoine.</p>`;
}

/** Zones du PLU et argiles sur le périmètre de projet. */
function perimetreBlock(r: ReglementaireResult): string {
  if (!r.surPerimetre) return "";
  const fr = (v: number) => v.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
  const zones =
    r.zonagesPerimetre === null
      ? `<p class="error">Zones du PLU sur le périmètre indisponibles (Géoportail de l'Urbanisme muet). Ce n'est pas une absence de zonage.</p>`
      : r.zonagesPerimetre.length === 0
        ? `<p class="module-note">Aucune zone du PLU publiée sur le périmètre de projet (RNU, ou document non publié sur le GPU).</p>`
        : `<table class="reg-table"><thead><tr><th>Zone du PLU</th><th>Part du périmètre</th><th>Règlement</th></tr></thead><tbody>${r.zonagesPerimetre
            .map(
              (z) =>
                `<tr><td><strong>${esc(z.libelle)}</strong>${z.typezone ? ` <span class="module-note">(${esc(z.typezone)})</span>` : ""}</td><td>${fr(z.pct)} %</td><td>${
                  z.urlfic ? `<a href="${esc(z.urlfic)}" target="_blank" rel="noopener">Ouvrir ↗</a>` : `<span class="module-note">non publié</span>`
                }</td></tr>`,
            )
            .join("")}</tbody></table>${
            r.zonagesPerimetre.length > 1 ? `<p><strong>Le périmètre est à cheval sur ${r.zonagesPerimetre.length} zones</strong> : chaque partie suit le règlement de sa zone.</p>` : ""
          }`;
  const argiles = r.rgaParcelles.length
    ? `<table class="reg-table"><thead><tr><th>Parcelle</th><th>Argiles (RGA)</th></tr></thead><tbody>${r.rgaParcelles
        .map((x) => `<tr><td>${esc(x.court)}</td><td>${x.exposition ? esc(x.exposition) : `<span class="module-note">n.d.</span>`}</td></tr>`)
        .join("")}</tbody></table>`
    : "";
  return `
    <h3 class="module-subtitle">Sur le périmètre de projet</h3>
    ${zones}
    ${argiles}
    <p class="module-note">Zones : surfaces découpées au contour des parcelles (zones qui ne font que toucher la limite écartées).
    Argiles : exposition au centre de chaque parcelle. Les servitudes et protections patrimoniales ci-dessous sont celles qui touchent le périmètre.</p>`;
}

export function renderReglementaire(el: HTMLElement, r: ReglementaireResult): void {
  const zonageBlock = r.isRnu
    ? `<p><strong>Règlement National d'Urbanisme (RNU)</strong> — cette commune n'a pas de PLU
       communal publié sur le Géoportail de l'Urbanisme. Les règles de constructibilité relèvent
       du RNU (Code de l'urbanisme) ; se renseigner en mairie pour les règles locales complémentaires.</p>`
    : r.zonageLibelle
      ? `<p>Zone <strong>${r.zonageLibelle}</strong>${r.zonageType ? ` (type ${r.zonageType})` : ""}.
         ${
           r.documentUrl
             ? `<a href="${esc(r.documentUrl)}" target="_blank" rel="noopener">Ouvrir le règlement de la zone ↗</a>`
             : `Lien vers le règlement non publié pour cette zone — à vérifier en mairie.`
         }</p>`
      : r.zonageFailed
        ? `<p class="error">Zonage indisponible : le Géoportail de l'Urbanisme (API Carto IGN) n'a
           pas répondu. Ce n'est pas une absence de PLU — réessayer plus tard.</p>`
      : `<p class="error">Aucun zonage trouvé sur le Géoportail de l'Urbanisme pour ce point.
         Cela ne signifie pas forcément l'absence de document d'urbanisme (couverture GPU incomplète,
         surtout en zone rurale) — à vérifier en mairie.</p>`;

  const supBlock =
    r.supCount === null
      ? `<p class="error">Servitudes d'utilité publique indisponibles (Géoportail de l'Urbanisme
         n'a pas répondu). Ce n'est pas une absence de servitude — réessayer plus tard.</p>`
      : r.supCount > 0
        ? `<ul class="reg-list">${r.supItems
            .map(
              (s) =>
                `<li>${esc(s.libelle ?? "Servitude")}${s.categorie ? ` (${esc(s.categorie)})` : ""}` +
                `${s.typeAssiette ? ` — <span class="module-note">${esc(s.typeAssiette)}</span>` : ""}</li>`,
            )
            .join("")}</ul>`
        : `<p class="module-note">Aucune servitude d'utilité publique détectée sur le Géoportail de
           l'Urbanisme ${r.surPerimetre ? "sur le périmètre de projet" : "pour ce point"}. Rappel : la totalité des SUP n'est pas encore publiée sur le
           GPU — une absence de résultat ne garantit pas leur absence réelle.</p>`;

  const naturels = r.risquesPresents.filter((f) => f.famille === "naturel");
  const technos = r.risquesPresents.filter((f) => f.famille === "technologique");
  const risqueRow = (f: (typeof r.risquesPresents)[number]) =>
    `<tr><td>${esc(f.libelle)}</td><td>${statut(f.statutAdresse)}</td><td>${statut(f.statutCommune)}</td></tr>`;
  const risqueTable = (titre: string, list: typeof r.risquesPresents) =>
    list.length === 0
      ? ""
      : `<table class="reg-table"><thead><tr><th>${titre}</th><th>À l'adresse</th><th>Commune</th></tr></thead>
         <tbody>${list.map(risqueRow).join("")}</tbody></table>`;

  const risquesBlock = !r.risquesDisponibles
    ? `<p class="error">Synthèse des risques Géorisques indisponible pour le moment (service
       instable par intermittence). Ce n'est pas une absence de risque — réessayer plus tard, ou
       consulter directement georisques.gouv.fr pour ce point.</p>`
    : r.risquesPresents.length > 0
      ? `${risqueTable("Risques naturels", naturels)}${risqueTable("Risques technologiques", technos)}
         <p class="module-note">« Inconnu » ou « non connu » à l'adresse signifie que le risque
         n'est pas qualifié à cet endroit précis, pas qu'il est absent.${
           r.georisquesUrl
             ? ` <a href="${esc(r.georisquesUrl)}" target="_blank" rel="noopener">Rapport Géorisques complet ↗</a>`
             : ""
         }</p>`
      : `<p class="module-note">Aucun risque signalé par la synthèse Géorisques pour ce point.</p>`;

  const catnatBlock =
    r.catnatCount === null
      ? `<p class="error">Arrêtés de catastrophe naturelle indisponibles (Géorisques n'a pas
         répondu). Ce n'est pas une absence d'arrêté — réessayer plus tard.</p>`
      : r.catnatCount > 0
        ? `<p>${r.catnatCount} arrêté(s) de catastrophe naturelle sur les communes situées à moins
           de 1 km (Géorisques / GASPAR). Les plus récents :</p>
           <ul class="reg-list">${r.catnatRecent
             .map(
               (c) =>
                 `<li>${esc(c.libelle_risque_jo ?? "Arrêté CatNat")} — ${esc(c.date_debut_evt ?? "")}` +
                 `${c.date_fin_evt && c.date_fin_evt !== c.date_debut_evt ? ` → ${esc(c.date_fin_evt)}` : ""}</li>`,
             )
             .join("")}</ul>`
        : `<p class="module-note">Aucun arrêté de catastrophe naturelle recensé sur les communes à
           moins de 1 km.</p>`;

  el.innerHTML = `
    <div class="indicators">
      ${indicator("Zonage", r.isRnu ? "RNU" : r.zonageLibelle ?? "n.d.")}
      ${indicator("Servitudes (SUP)", r.supCount === null ? "n.d." : `${r.supCount}`)}
      ${indicator("Exposition RGA", r.rgaExposition ?? "n.d.")}
      ${indicator("Risques existants à l'adresse", r.risquesDisponibles ? `${r.risquesAdresseCount}` : "n.d.")}
      ${indicator("Arrêtés CatNat (communes < 1 km)", r.catnatCount === null ? "n.d." : `${r.catnatCount}`)}
    </div>

    ${perimetreBlock(r)}

    <h3 class="module-subtitle">Zonage PLU${r.surPerimetre ? ` <span class="sub-note">au centre du périmètre</span>` : ""}</h3>
    ${zonageBlock}

    <h3 class="module-subtitle">Servitudes d'utilité publique</h3>
    ${supBlock}

    <h3 class="module-subtitle">Patrimoine protégé</h3>
    ${patrimoineBlock(r)}

    <h3 class="module-subtitle">Retrait-gonflement des argiles (RGA)</h3>
    <p>${r.rgaExposition ? `Niveau : <strong>${esc(r.rgaExposition)}</strong> (code ${esc(r.rgaCode ?? "n.d.")}).` : "Donnée non disponible."}
    Concerne directement les fondations — une exposition moyenne/forte implique généralement une
    étude géotechnique G1/G2 (loi ÉLAN) pour une maison individuelle.</p>

    <h3 class="module-subtitle">Autres risques (synthèse Géorisques)</h3>
    ${risquesBlock}

    <h3 class="module-subtitle">Historique catastrophes naturelles</h3>
    ${catnatBlock}

    <p class="module-note">Sources : Géoportail de l'Urbanisme (via API Carto IGN), Géorisques (BRGM /
    Ministère de la Transition écologique). Informations à visée de diagnostic amont — seule la
    mairie et les services de l'État font foi pour l'instruction d'un dossier réel. Le zonage
    affiché correspond au point recherché, pas nécessairement à l'ensemble de la parcelle si
    celle-ci est à cheval sur deux zones.</p>
  `;
}
