// Panneau « Périmètre de projet », sous la carte du diagnostic : choix des
// parcelles par clic sur le cadastre ou par référence, import d'un contour
// GeoJSON, export, application au diagnostic.

import {
  construirePerimetre,
  perimetreImporte,
  parcelleAuPoint,
  parcelleParReference,
  versGeoJson,
  type ParcelleChoisie,
  type Perimetre,
} from "../core/perimetre";
import { setSelectionParcelles, afficherSelection, cadrerPerimetre } from "../map/map";

interface SitePanneau {
  insee?: string;
  label: string;
  perimetre: Perimetre | null;
  /** Point de l'adresse : sa parcelle est proposée d'office au premier choix. */
  pointAdresse?: { lat: number; lon: number };
}

export interface PanneauPerimetre {
  /** Site courant : commune (pour la saisie par référence) et périmètre appliqué. */
  setSite(site: SitePanneau | null): void;
}

const fr = (v: number) => v.toLocaleString("fr-FR", { maximumFractionDigits: 0 });

export function surfaceTexte(p: Perimetre): string {
  return `${fr(p.surfaceM2)} m²${p.surfaceSource === "contenance" ? " (contenances cadastrales)" : " (calculée sur le contour)"}`;
}

export function resumePerimetre(p: Perimetre): string {
  return p.source === "import"
    ? `Contour importé · ${surfaceTexte(p)}`
    : `${p.parcelles.length} parcelle${p.parcelles.length > 1 ? "s" : ""} · ${surfaceTexte(p)}`;
}

function esc(t: string): string {
  return t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export function attachPerimetrePanel(
  root: HTMLElement,
  /** Applique le périmètre (null : le retire) ; relance le diagnostic. */
  onApply: (p: Perimetre | null) => Promise<void> | void,
): PanneauPerimetre {
  let site: SitePanneau | null = null;
  let edition = false;
  let choix: ParcelleChoisie[] = [];
  let importe: Perimetre | null = null;
  let message = "";
  let occupe = false;

  root.className = "perimetre-panel";

  function brouillon(): Perimetre | null {
    return importe ?? construirePerimetre(choix);
  }

  function rendre(): void {
    root.hidden = !site;
    if (!site) return;
    const p = site.perimetre;
    if (!edition) {
      root.innerHTML = `
        <div class="pp-tete">
          <span class="pp-titre">Périmètre de projet</span>
          ${p ? `<span class="pp-resume">${esc(resumePerimetre(p))}</span>` : `<span class="pp-resume pp-vide">aucun : chiffres sur le rayon seul</span>`}
        </div>
        ${p && p.parcelles.length ? `<p class="pp-liste">${p.parcelles.map((x) => esc(x.court)).join(" · ")}</p>` : ""}
        <div class="pp-actions">
          <button type="button" data-a="editer" class="btn-secondary">${p ? "Modifier" : "Choisir des parcelles"}</button>
          ${p ? `<button type="button" data-a="export" class="btn-lien">Exporter (GeoJSON)</button>
          <button type="button" data-a="retirer" class="btn-lien">Retirer</button>` : ""}
        </div>`;
      return;
    }
    const b = brouillon();
    root.innerHTML = `
      <div class="pp-tete">
        <span class="pp-titre">Périmètre de projet</span>
        <span class="pp-resume">${b ? esc(resumePerimetre(b)) : "aucune parcelle"}</span>
      </div>
      <p class="pp-aide">Cliquez sur les parcelles de la carte pour les ajouter ou les retirer${site.insee ? ", ou saisissez leur référence" : ""}.</p>
      ${
        site.insee
          ? `<form class="pp-ref">
              <label><span class="visually-hidden">Référence cadastrale (section et numéro)</span>
              <input type="text" name="ref" placeholder="Section et numéro, ex. AB 123" autocomplete="off" /></label>
              <button type="submit" class="btn-secondary"${occupe ? " disabled" : ""}>Ajouter</button>
            </form>`
          : ""
      }
      ${
        choix.length
          ? `<ul class="pp-chips">${choix
              .map((x) => `<li><span title="${esc(x.reference)} · ${fr(x.surfaceM2)} m²">${esc(x.court)}</span><button type="button" data-retirer="${esc(x.id)}" aria-label="Retirer ${esc(x.court)}">×</button></li>`)
              .join("")}</ul>`
          : importe
            ? `<p class="pp-liste">Contour importé (GeoJSON).</p>`
            : ""
      }
      ${message ? `<p class="pp-message" role="status">${esc(message)}</p>` : ""}
      <div class="pp-actions">
        <button type="button" data-a="appliquer" class="btn-primary"${occupe ? " disabled" : ""}>Appliquer au diagnostic</button>
        <button type="button" data-a="annuler" class="btn-lien">Annuler</button>
        <label class="btn-lien pp-import">Importer un contour (GeoJSON)<input type="file" accept=".geojson,.json,application/geo+json,application/json" hidden /></label>
      </div>`;
  }

  function entrer(): void {
    edition = true;
    const p = site?.perimetre ?? null;
    choix = p && p.source === "cadastre" ? [...p.parcelles] : [];
    importe = p && p.source === "import" ? p : null;
    message = "";
    setSelectionParcelles((lat, lon) => void basculerAuPoint(lat, lon));
    afficherSelection(choix);
    rendre();
    // Premier choix : la parcelle de l'adresse est proposée d'office.
    if (!p && site?.pointAdresse) void basculerAuPoint(site.pointAdresse.lat, site.pointAdresse.lon);
  }

  function sortir(): void {
    edition = false;
    message = "";
    setSelectionParcelles(null);
    rendre();
  }

  async function basculerAuPoint(lat: number, lon: number): Promise<void> {
    if (occupe) return;
    occupe = true;
    message = "Recherche de la parcelle…";
    rendre();
    try {
      const p = await parcelleAuPoint(lat, lon);
      if (!p) message = "Aucune parcelle cadastrale à cet endroit (voirie, domaine public non cadastré ?).";
      else ajouterOuRetirer(p);
    } catch {
      message = "Le service du cadastre (IGN) ne répond pas. Réessayez dans un instant.";
    } finally {
      occupe = false;
      rendre();
    }
  }

  function ajouterOuRetirer(p: ParcelleChoisie): void {
    importe = null; // le choix de parcelles remplace un contour importé
    const i = choix.findIndex((x) => x.id === p.id);
    if (i >= 0) {
      choix.splice(i, 1);
      message = `Parcelle ${p.court} retirée.`;
    } else {
      choix.push(p);
      message = `Parcelle ${p.court} ajoutée (${fr(p.surfaceM2)} m²).`;
    }
    afficherSelection(choix);
  }

  root.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const retirer = t.closest<HTMLButtonElement>("button[data-retirer]");
    if (retirer) {
      choix = choix.filter((x) => x.id !== retirer.dataset.retirer);
      message = "";
      afficherSelection(choix);
      rendre();
      return;
    }
    const a = t.closest<HTMLButtonElement>("button[data-a]")?.dataset.a;
    if (!a) return;
    if (a === "editer") entrer();
    else if (a === "annuler") sortir();
    else if (a === "retirer") await onApply(null);
    else if (a === "export" && site?.perimetre) telecharger(site.perimetre, site.label);
    else if (a === "appliquer") {
      const p = brouillon();
      edition = false;
      setSelectionParcelles(null);
      if (p) cadrerPerimetre(p.contour);
      await onApply(p);
    }
  });

  root.addEventListener("submit", async (e) => {
    e.preventDefault();
    const champ = root.querySelector<HTMLInputElement>(".pp-ref input")!;
    if (!site?.insee || !champ.value.trim() || occupe) return;
    occupe = true;
    message = "Recherche de la parcelle…";
    rendre();
    try {
      const p = await parcelleParReference(site.insee, champ.value);
      if (!p) message = `Parcelle « ${champ.value.trim()} » introuvable sur la commune ${site.insee}.`;
      else {
        if (choix.some((x) => x.id === p.id)) message = `Parcelle ${p.court} déjà choisie.`;
        else ajouterOuRetirer(p);
        const b = brouillon();
        if (b) cadrerPerimetre(b.contour);
      }
    } catch (err) {
      message = err instanceof Error && /Référence attendue/.test(err.message) ? err.message : "Le service API Carto (cadastre) ne répond pas. Cliquez plutôt sur la parcelle.";
    } finally {
      occupe = false;
      rendre();
      root.querySelector<HTMLInputElement>(".pp-ref input")?.focus();
    }
  });

  root.addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    if (input.type !== "file" || !input.files?.[0]) return;
    try {
      const p = perimetreImporte(JSON.parse(await input.files[0].text()));
      if (!p) message = "Aucun polygone lisible : un GeoJSON en coordonnées WGS84 (degrés) est attendu.";
      else {
        importe = p;
        choix = [];
        afficherSelection([]);
        cadrerPerimetre(p.contour);
        message = `Contour importé : ${surfaceTexte(p)}.`;
      }
    } catch {
      message = "Fichier illisible : un GeoJSON est attendu.";
    }
    rendre();
  });

  function telecharger(p: Perimetre, label: string): void {
    const blob = new Blob([JSON.stringify(versGeoJson(p), null, 1)], { type: "application/geo+json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `perimetre-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "site"}.geojson`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  rendre();
  return {
    setSite(s) {
      site = s;
      if (edition) sortir();
      else rendre();
    },
  };
}
