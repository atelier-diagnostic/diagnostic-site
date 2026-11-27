// Atelier cartographique : carte pleine page (MapLibre, 2D et 3D) et menu des
// couches à gauche, chacune avec son interrupteur et sa réglette d'opacité.
// Chargé à la demande (import dynamique) : MapLibre pèse ~1 Mo.
//
// Reprend la vue 3D du Diagnostic (bâtiments BD TOPO, ombres portées à date
// et heure légale) et ajoute les couches de contexte (cadastre, urbanisme,
// risques, nature, végétation).

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { fetchJson } from "../api/client";
import { fetchBuildingsWithHeight, BUILDING_SOURCE_LABEL, type BuildingsResult } from "../core/buildings";
import { bboxAroundMeters } from "../core/geo";
import { attachPerimetrePanel } from "../ui/perimetre-panel";
import type { Perimetre } from "../core/perimetre";
import { disponibiliteLidar, texteDispoLidar, LIBELLE_DISPO_COURT } from "../core/lidar-dispo";
import type { SiteContext } from "../core/types";
import { fetchTrees, type ArbreOsm } from "../modules/soleil/fetch";
import { creerCoucheCourseSoleil } from "./course-soleil";
import type { CarteEnsoleillement, PasSoleil } from "../map3d/ensoleillement";
import { DEFAULT_HEIGHT_M, MAX_SHADOW_M, type ShadowBuilding } from "../map3d/shadows";
import type { ShadowRequest, ShadowResponse } from "../map3d/shadow-worker";
import { sunAtLegalTime, formatHour } from "../map3d/sun";
import {
  COUCHES, FAMILLES, FONDS, HAUTEURS, INCONNU, USAGES, USAGE_AUTRE, NEUTRE, COSIA, PAS_CARROYAGE, tuilesCosia,
  type CoucheDef, type Fond, type MillesimeCosia,
  CLASSES_SOLEIL, EXAGERATIONS, PAS_COURBES,
} from "./couches";
import { calculerCourbes } from "./courbes";
import { calculerIsochrones, DUREES_MIN, COULEURS_ISO } from "./isochrones";
import { recenserEquipements, FONCTIONS } from "./equipements";
import { fetchPatrimoine } from "../core/patrimoine";

const CLE_REPLIEES = "atelier:themes-replies";
const CLE_VUES_REPLIEES = "atelier:vues-repliees";
import { enregistrerProtocoleRelief, statsRelief, tuilesRelief, ZOOM_MAX_RELIEF, type SourceAlt } from "./relief-dem";
import { enregistrerProduit, enProduit } from "./produit";
import { THEMES_IGN, SPRITE_PLAN_IGN, OPACITE, chargerStylePlanIgn, type ThemeIgn, type CoucheIgn } from "./fond-ign";
import { carroyage } from "./lambert93";
import { creerCoucheArbres3D, MAX_ARBRES } from "./arbres3d";
import { ombresArbres } from "./ombres-arbres";
import { creerCoucheCoupe3D } from "./coupe3d";
import { creerCoucheCanopee3D } from "./canopee3d";
import { creerCoucheBati3D, type BilanBati3D } from "./bati3d";
import { grilleSursol } from "../core/sursol-lidar";
import { analyserCanopee, CLASSES_HAUTEUR, type CanopeeLidar } from "../core/canopee-lidar";
import { calculerProfil, dessinerProfil, vuAuDela, penteEn, profilCsv, distanceM, COULEURS_ECRAN, COULEURS_EXPORT, EXAGERATIONS_COUPE, type Profil, type ExagCoupe } from "./coupe";
import { FOCALES, FOCALE_DEFAUT, champVertical, lireVues, ecrireVues, vuesDeDepart, exporterVues, lireExport, type Vue } from "./vues";
import { brancherMiseEnPage, type ElementLegende } from "./mise-en-page";

type Coloration = "neutre" | "hauteur" | "usage";

export interface Atelier {
  setSite(ctx: SiteContext): Promise<void>;
  /** À appeler quand l'onglet redevient visible. */
  resize(): void;
}

interface Etat {
  actif: boolean;
  opacite: number;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function cercle(lat: number, lon: number, r: number, n = 96): [number, number][] {
  const mLat = 110_540;
  const mLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return [lon + (Math.sin(a) * r) / mLon, lat + (Math.cos(a) * r) / mLat] as [number, number];
  });
}

function repere(): HTMLElement {
  const el = document.createElement("div");
  el.className = "site-marker";
  el.innerHTML = `<svg viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
    <line x1="18" y1="1" x2="18" y2="11" /><line x1="18" y1="25" x2="18" y2="35" />
    <line x1="1" y1="18" x2="11" y2="18" /><line x1="25" y1="18" x2="35" y2="18" />
    <circle cx="18" cy="18" r="7" class="ring" /><circle cx="18" cy="18" r="3" class="dot" /></svg>`;
  return el;
}

function batiGeoJSON(data: BuildingsResult): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: data.buildings.map((b, i) => ({
      type: "Feature",
      id: i,
      geometry: {
        type: "Polygon",
        coordinates: [[...b.polygon.map((p) => [p.lon, p.lat]), [b.polygon[0].lon, b.polygon[0].lat]]],
      },
      properties: {
        h: b.heightM ?? DEFAULT_HEIGHT_M,
        connue: b.heightM !== null,
        usage: b.info?.usage ?? "",
        etages: b.info?.etages ?? null,
        logements: b.info?.logements ?? null,
      },
    })),
  };
}

/** Zones de végétation BD TOPO (WFS Géoplateforme), dans l'emprise. */
async function fetchVegetation(ctx: SiteContext, r: number): Promise<GeoJSON.FeatureCollection> {
  const b = bboxAroundMeters(ctx.lat, ctx.lon, r);
  const url =
    `https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature` +
    `&TYPENAMES=BDTOPO_V3:zone_de_vegetation&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326&COUNT=3000` +
    `&BBOX=${b.minLon},${b.minLat},${b.maxLon},${b.maxLat},EPSG:4326`;
  return fetchJson<GeoJSON.FeatureCollection>(url, {
    cacheKey: "bdtopo:vegetation",
    ttlMs: 30 * 24 * 60 * 60 * 1000,
    timeoutMs: 30_000,
    retries: 2,
  });
}

/** WebGL disponible ? (désactivé si le navigateur a coupé l'accélération graphique). */
function webglDisponible(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

export interface OptionsAtelier {
  /** Périmètre de projet choisi dans l'atelier : appliqué à tout l'outil (diagnostic compris). */
  onPerimetre?: (p: Perimetre | null) => Promise<void> | void;
}

export function createAtelier(root: HTMLElement, options: OptionsAtelier = {}): Atelier {
  const famillesRepliees = new Set<string>();
  try {
    for (const f of JSON.parse(localStorage.getItem(CLE_REPLIEES) ?? "[]") as string[]) famillesRepliees.add(f);
  } catch {
    /* rien de retenu */
  }
  let vuesRepliees = false;
  try {
    vuesRepliees = localStorage.getItem(CLE_VUES_REPLIEES) === "1";
  } catch {
    /* rien de retenu */
  }
  if (!webglDisponible()) {
    root.innerHTML = `<div class="at-sans-webgl"><div>
      <h2>La carte de l'atelier ne peut pas s'afficher</h2>
      <p>Le navigateur a désactivé l'accélération graphique (WebGL), nécessaire à la carte 2D et 3D.
      Cela arrive souvent après un plantage du moteur graphique du navigateur.</p>
      <ol>
        <li>Quittez complètement le navigateur, puis relancez-le.</li>
        <li>Si le problème persiste, dans Chrome : Réglages › Système › activez « Utiliser l'accélération graphique si disponible ».</li>
        <li>Contrôle : la page <code>chrome://gpu</code> doit indiquer « WebGL : Hardware accelerated ».</li>
      </ol>
      <p>L'onglet <a href="#diagnostic">Diagnostic</a> reste utilisable.</p>
    </div></div>`;
    return { setSite: async () => {}, resize: () => {} };
  }
  const etat = new Map<string, Etat>(COUCHES.map((c) => [c.id, { actif: c.active, opacite: c.opacite }]));
  let fond: Fond = "plan";
  let coloration: Coloration = "hauteur";
  let mode3d = false;
  /** Volumes du bâti en 3D : extrudés (hauteur BD TOPO, toit plat) ou mesurés (LiDAR HD : toits, pentes, décrochés). */
  let batiRendu: "extrude" | "lidar" | "plans" = "extrude";
  try {
    const r = localStorage.getItem("atelier:bati-rendu");
    if (r === "lidar" || r === "plans") batiRendu = r;
  } catch {
    /* rien */
  }
  let rendu: "volume" | "canopee" | "point" = "volume";
  /** Facteur appliqué au diamètre des houppiers (réglage à l'œil, retenu). */
  let envergure = 1;
  try {
    envergure = Math.max(0.7, Math.min(1.6, Number(localStorage.getItem("atelier:envergure")) || 1));
  } catch {
    /* valeur par défaut */
  }
  /** Arbres tels que mesurés ou recensés, avant l'envergure. */
  let arbresBruts: { arbres: import("../modules/soleil/fetch").ArbreOsm[]; lat0: number; lon0: number } | null = null;
  let derniersArbres: { arbres: import("../modules/soleil/fetch").ArbreOsm[]; lat0: number; lon0: number } | null = null;
  let millesime: MillesimeCosia = "2021-2023";
  let pas: (typeof PAS_CARROYAGE)[number] = 100;
  let exag: (typeof EXAGERATIONS)[number] = 1.5;
  let pasCourbes: (typeof PAS_COURBES)[number] = "auto";
  let numerosCadastre = false;
  /** Altitudes des courbes et des coupes : LiDAR HD (complété par le RGE ALTI) ou RGE ALTI seul. */
  let sourceAlt: SourceAlt = "lidar";
  /** Dernier texte d'état de la couche Relief (source réellement lue). */
  let texteRelief = "";
  /** Source des arbres : détectés dans le LiDAR HD, ou saisis dans OpenStreetMap. */
  let sourceArbres: "lidar" | "osm" = "lidar";
  /** Analyse LiDAR de la canopée, une par site (partagée par la canopée et les arbres). */
  let canopee: { ctx: SiteContext; p: Promise<CanopeeLidar> } | null = null;
  const canopeePour = (ctx: SiteContext) => {
    if (canopee?.ctx !== ctx) {
      // Progression affichée dans les couches qui l'attendent (le service LiDAR peut être lent sur un grand cercle).
      let fini = false;
      const p = analyserCanopee(ctx.lat, ctx.lon, ctx.radiusM ?? 150, (f, t) => {
        if (fini || site !== ctx) return;
        for (const id of ["canopee", "arbres"])
          if (etat.get(id)!.actif && (id === "canopee" || sourceArbres === "lidar")) etatCouche(id, `Lecture du LiDAR HD et de CoSIA : ${f} / ${t} tuiles…`);
      });
      p.finally(() => (fini = true)).catch(() => {});
      canopee = { ctx, p };
    }
    return canopee.p;
  };
  /** Bâtiments chargés (pour les coupes). */
  let dernierBati: GeoJSON.FeatureCollection | null = null;
  /** Bâtiments du site (pour les volumes LiDAR). */
  let dernierBatiData: BuildingsResult | null = null;
  /** Fond composé posé sur la photo aérienne (le fond opaque IGN s'efface). */
  let photoDessous = false;
  /** Réglages propres à la photo aérienne (0-1) : opacité sous le composé, couleurs, éclaircissement. */
  const photo = { opacite: 1, couleurs: 1, eclaircir: 0 };
  const themesIgn = new Map<ThemeIgn, boolean>(THEMES_IGN.map((t) => [t.id, t.actif]));
  let couchesIgn: CoucheIgn[] | null = null;

  // --- Gabarit ----------------------------------------------------------------
  const ligne = (c: CoucheDef) => {
    const e = etat.get(c.id)!;
    const extra =
      c.id === "fond"
        ? `<div class="segmented seg-sm" role="group" aria-label="Fond de carte">
            ${(Object.keys(FONDS) as Fond[]).map((k) => `<button type="button" data-fond="${k}" aria-pressed="${k === fond}">${FONDS[k].titre}</button>`).join("")}
          </div>
          <div class="at-photo-reglages" hidden>
            <label class="at-opacite" data-ligne-photo-opacite><span>Photo</span>
              <input type="range" data-photo="opacite" min="0" max="100" step="5" value="100" aria-label="Opacité de la photo aérienne"><output>100 %</output></label>
            <label class="at-opacite"><span>Couleurs</span>
              <input type="range" data-photo="couleurs" min="0" max="100" step="5" value="100" aria-label="Couleurs de la photo (0 : noir et blanc)"><output>100 %</output></label>
            <label class="at-opacite"><span>Éclaircir</span>
              <input type="range" data-photo="eclaircir" min="0" max="100" step="5" value="0" aria-label="Éclaircir la photo"><output>0 %</output></label>
          </div>
          <div class="at-themes-ign" hidden>
            <label class="at-chip at-chip-fort"><input type="checkbox" data-photo-dessous> Photo aérienne dessous</label>
            ${THEMES_IGN.map((t) => `<label class="at-chip"><input type="checkbox" data-theme-ign="${t.id}" ${t.actif ? "checked" : ""}> ${t.titre}</label>`).join("")}
          </div>`
        : c.id === "cadastre"
          ? `<div class="segmented seg-sm" role="group" aria-label="Numéros de parcelle">
              <button type="button" data-numeros="non" aria-pressed="true">Traits seuls</button>
              <button type="button" data-numeros="oui" aria-pressed="false">Avec numéros</button>
            </div>`
        : c.id === "cosia"
          ? `<div class="segmented seg-sm" role="group" aria-label="Millésime CoSIA">
              ${(Object.keys(COSIA) as MillesimeCosia[]).map((m) => `<button type="button" data-cosia="${m}" aria-pressed="${m === millesime}">${m}</button>`).join("")}
            </div>`
        : c.id === "arbres"
          ? `<div class="segmented seg-sm" role="group" aria-label="Source des arbres">
              <button type="button" data-arbres-src="lidar" aria-pressed="true">LiDAR HD</button>
              <button type="button" data-arbres-src="osm" aria-pressed="false">OpenStreetMap</button>
            </div>
            <div class="segmented seg-sm" role="group" aria-label="Rendu des arbres">
              <button type="button" data-rendu="volume" aria-pressed="true" title="Un volume par arbre, port selon les proportions mesurées">Arbres</button>
              <button type="button" data-rendu="canopee" aria-pressed="false" title="Surface de la canopée mesurée par le LiDAR HD, en volume : masses boisées et houppiers jointifs">Canopée</button>
              <button type="button" data-rendu="point" aria-pressed="false">Point</button>
            </div>
            <label class="at-envergure" title="Ajuste le diamètre des houppiers (arbres LiDAR, et OSM quand il est renseigné), pour les caler à l'œil sur la photo aérienne. Agit sur la 3D, les ombres et la coupe.">
              <span>Envergure</span>
              <input type="range" data-envergure min="70" max="160" step="5" value="${Math.round(envergure * 100)}" aria-label="Envergure des houppiers">
              <output>×${envergure.toLocaleString("fr-FR", { minimumFractionDigits: 2 })}</output>
            </label>`
        : c.produit
          ? `<div class="segmented seg-sm" role="group" aria-label="Mode de fusion">
              <button type="button" data-produit="${c.id}" data-fusion="produit" aria-pressed="true">Produit</button>
              <button type="button" data-produit="${c.id}" data-fusion="normal" aria-pressed="false">Normal</button>
            </div>`
        : c.id === "relief"
          ? `<div class="segmented seg-sm" role="group" aria-label="Exagération du relief en 3D">
              ${EXAGERATIONS.map((v) => `<button type="button" data-exag="${v}" aria-pressed="${v === exag}">×${String(v).replace(".", ",")}</button>`).join("")}
            </div>
            <div class="segmented seg-sm" role="group" aria-label="Source des altitudes">
              <button type="button" data-alt="lidar" aria-pressed="${sourceAlt === "lidar"}">LiDAR HD 50 cm</button>
              <button type="button" data-alt="rgealti" aria-pressed="${sourceAlt === "rgealti"}">RGE ALTI 1 m</button>
            </div>`
        : c.id === "courbes"
          ? `<div class="segmented seg-sm" role="group" aria-label="Équidistance des courbes">
              ${PAS_COURBES.map((v) => `<button type="button" data-courbes="${v}" aria-pressed="${v === pasCourbes}">${v === "auto" ? "Auto" : `${v} m`}</button>`).join("")}
            </div>
            <div class="segmented seg-sm" role="group" aria-label="Source des altitudes">
              <button type="button" data-alt="lidar" aria-pressed="true">LiDAR HD 50 cm</button>
              <button type="button" data-alt="rgealti" aria-pressed="false">RGE ALTI 1 m</button>
            </div>`
        : c.id === "carroyage"
          ? `<div class="segmented seg-sm" role="group" aria-label="Pas du carroyage">
              ${PAS_CARROYAGE.map((v) => `<button type="button" data-pas="${v}" aria-pressed="${v === pas}">${v} m</button>`).join("")}
            </div>`
        : c.id === "bati"
          ? `<div class="segmented seg-sm" role="group" aria-label="Coloration des bâtiments">
              <button type="button" data-colo="neutre" aria-pressed="false">Neutre</button>
              <button type="button" data-colo="hauteur" aria-pressed="true">Hauteur</button>
              <button type="button" data-colo="usage" aria-pressed="false">Usage</button>
              <button type="button" disabled title="L'année de construction n'est pas publiée dans la BD TOPO">Époque</button>
            </div>
            <div class="segmented seg-sm" role="group" aria-label="Volumes du bâti en 3D" title="En vue 3D : volumes extrudés à la hauteur BD TOPO (toit plat), ou volumes mesurés par le LiDAR HD (toits en pente, décrochés, édicules)">
              <button type="button" data-bati-rendu="extrude" aria-pressed="${batiRendu === "extrude"}">Extrudés</button>
              <button type="button" data-bati-rendu="lidar" aria-pressed="${batiRendu === "lidar"}" title="Dessus du LiDAR pixel par pixel">LiDAR brut</button>
              <button type="button" data-bati-rendu="plans" aria-pressed="${batiRendu === "plans"}" title="Toits reconstruits en pans plans à partir du LiDAR (façon LoD2)">Pans plans</button>
            </div>
            <div class="at-legende" data-legende-bati></div>
            <p class="at-note" data-bati-source></p>
            <p class="at-note" data-bati-lidar hidden></p>`
          : c.id === "ensoleillement"
            ? `<div class="at-legende">${CLASSES_SOLEIL.map((k) => `<span><i style="background:${k.couleur}"></i>${k.label}</span>`).join("")}</div>`
            : "";
    return `<div class="at-couche${e.actif ? " on" : ""}" data-couche="${c.id}">
      <label class="at-ligne">
        <span class="at-titre">${esc(c.titre)}<span class="at-source">${esc(c.source)}</span></span>
        <input type="checkbox" class="switch" ${e.actif ? "checked" : ""} aria-label="Afficher ${esc(c.titre)}">
      </label>
      <div class="at-reglages">
        ${extra}
        ${c.note ? `<p class="at-note">${esc(c.note)}</p>` : ""}
        ${c.legende ? `<details class="at-leg"><summary>Légende</summary><div class="at-leg-box"><img class="at-legende-img" alt="Légende : ${esc(c.titre)}" loading="lazy" src="${c.legende}" onerror="this.closest('details').remove()"></div></details>` : ""}
        <label class="at-opacite"><span>Opacité</span>
          <input type="range" min="0" max="100" step="5" value="${Math.round(e.opacite * 100)}" aria-label="Opacité de ${esc(c.titre)}">
          <output>${Math.round(e.opacite * 100)} %</output></label>
        <div class="at-etat" hidden></div>
      </div>
    </div>`;
  };

  root.innerHTML = `
    <aside class="at-panneau" aria-label="Couches">
      <div class="at-entete"><h2>Couches</h2><span class="at-compte"></span>
        <button type="button" class="icon-btn at-replier" aria-label="Replier le panneau" title="Replier le panneau">‹</button></div>
      <div class="at-site"></div>
      <section class="at-vues${vuesRepliees ? " repliee" : ""}" aria-label="Vues enregistrées">
        <div class="at-vues-entete">
          <h3><button type="button" class="at-vues-titre" aria-expanded="${!vuesRepliees}">
            <svg class="at-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Vues<span class="at-vues-active"></span></button></h3>
          <button type="button" class="at-vues-plus" title="Enregistrer l'affichage actuel (couches, réglages, caméra 3D)">＋ Enregistrer</button>
          <button type="button" class="icon-btn at-vues-menu-btn" aria-label="Exporter, importer les vues" aria-haspopup="menu" aria-expanded="false">⋯</button>
          <div class="at-menu at-vues-menu" role="menu" hidden>
            <button type="button" role="menuitem" data-vues-action="exporter">Exporter les vues (fichier)</button>
            <button type="button" role="menuitem" data-vues-action="importer">Importer des vues…</button>
            <button type="button" role="menuitem" data-vues-action="depart">Ajouter les vues de départ</button>
          </div>
        </div>
        <form class="at-vues-form" hidden>
          <input type="text" maxlength="40" placeholder="Nom de la vue" aria-label="Nom de la vue" required>
          <button type="submit">OK</button>
          <button type="button" data-vues-annuler>Annuler</button>
        </form>
        <div class="at-vues-liste"></div>
        <div class="at-menu at-vue-menu" role="menu" hidden>
          <button type="button" role="menuitem" data-vue-action="maj">Remplacer par l'affichage actuel</button>
          <button type="button" role="menuitem" data-vue-action="renommer">Renommer</button>
          <button type="button" role="menuitem" data-vue-action="gauche">Déplacer avant</button>
          <button type="button" role="menuitem" data-vue-action="supprimer">Supprimer</button>
        </div>
        <p class="at-vues-msg" aria-live="polite" hidden></p>
        <input type="file" class="at-vues-fichier" accept=".json,application/json" hidden>
      </section>
      <div class="at-familles">
        ${FAMILLES.map(
          (f) =>
            `<section class="at-famille${famillesRepliees.has(f) ? " repliee" : ""}" data-famille="${f}">
              <h3><button type="button" class="at-famille-btn" aria-expanded="${!famillesRepliees.has(f)}">
                <svg class="at-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
                <span>${f}</span>${f === "LiDAR HD" ? `<span class="at-lidar-pastille" data-lidar-pastille hidden></span>` : ""}<span class="at-famille-n"></span>
              </button></h3>
              <div class="at-famille-corps">${f === "Repères" ? `<div data-at-perimetre></div>` : ""}${f === "LiDAR HD" ? `<p class="at-lidar-dispo" data-lidar-dispo>Disponibilité du LiDAR HD : recherchez une adresse.</p>` : ""}${COUCHES.filter((c) => c.famille === f).map(ligne).join("")}</div>
            </section>`,
        ).join("")}
      </div>
      <p class="at-sources">Sources : IGN (Plan, BD ORTHO®, BD TOPO®, Parcellaire Express), Géoportail de
        l'Urbanisme, Géorisques, INPN, OpenStreetMap.</p>
    </aside>
    <div class="at-carte">
      <div class="at-canvas"></div>
      <button type="button" class="at-ouvrir icon-btn" aria-label="Afficher les couches" title="Afficher les couches">☰</button>
      <div class="at-barre">
        <div class="segmented at-mode" role="group" aria-label="Vue">
          <button type="button" data-mode="2d" aria-pressed="true">2D</button>
          <button type="button" data-mode="3d" aria-pressed="false">3D</button>
        </div>
        <div class="at-focale" hidden>
          <button type="button" class="at-outil at-focale-btn" aria-expanded="false" title="Focale de la caméra (équivalent 24 × 36) : courte pour accentuer la profondeur, longue pour aplatir la perspective">
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>
            <span>${FOCALE_DEFAUT} mm</span>
          </button>
          <input type="range" class="at-focale-reglette" hidden min="0" max="${FOCALES.length - 1}" step="1" value="${FOCALES.indexOf(FOCALE_DEFAUT)}" aria-label="Focale de la vue 3D">
        </div>
        <button type="button" class="at-outil at-coupe-btn" aria-pressed="false" title="Coupe de terrain : cliquez deux points sur la carte">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 12.5 5 7l3 3 2.5-4 4 6.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/><path d="M1.5 14.5h13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          <span>Coupe</span>
        </button>
      </div>
      <div class="at-coupe-aide" hidden>Cliquez le point A <span class="at-note">· Échap pour annuler</span></div>
      <section class="at-coupe" aria-label="Coupe de terrain" hidden>
        <div class="at-coupe-entete">
          <h3>Coupe A–B</h3>
          <div class="segmented seg-sm" role="group" aria-label="Source des altitudes">
            <button type="button" data-alt="lidar" aria-pressed="true">LiDAR HD</button>
            <button type="button" data-alt="rgealti" aria-pressed="false">RGE ALTI</button>
          </div>
          <div class="segmented seg-sm" role="group" aria-label="Exagération verticale">
            ${EXAGERATIONS_COUPE.map((v) => `<button type="button" data-coupe-exag="${v}" aria-pressed="${v === "auto"}">${v === "auto" ? "Auto" : `×${v}`}</button>`).join("")}
          </div>
          <label class="at-chip"><input type="checkbox" data-coupe-bati checked> Bâti coupé</label>
          <label class="at-chip" title="Sursol mesuré par le LiDAR HD (MNS) : arbres, haies, végétation haute… le long du trait"><input type="checkbox" data-coupe-sursol checked> Végétation LiDAR</label>
          <div class="segmented seg-sm" role="group" aria-label="Vue au-delà du plan de coupe" title="Bâti et arbres vus au-delà du plan de coupe, en élévation">
            <span class="seg-titre">Au-delà</span>
            ${[0, 15, 30, 60].map((v) => `<button type="button" data-coupe-prof="${v}" aria-pressed="${v === 30}">${v ? `${v} m` : "—"}</button>`).join("")}
          </div>
          <button type="button" class="at-lien" data-coupe-inverser title="Inverser A et B : regarder de l'autre côté du plan de coupe">⇄ <span class="at-coupe-regard"></span></button>
          <span class="at-coupe-actions">
            <button type="button" class="at-lien" data-coupe-export="svg" title="Profil en SVG (vectoriel, pour la mise en page)">SVG</button>
            <button type="button" class="at-lien" data-coupe-export="csv" title="Distances et altitudes (tableur)">CSV</button>
            <button type="button" class="at-lien" data-coupe-nouvelle>Nouvelle</button>
            <button type="button" class="icon-btn" data-coupe-reduire aria-label="Réduire le profil" aria-expanded="true" title="Réduire / déplier le profil">–</button>
            <button type="button" class="icon-btn" data-coupe-fermer aria-label="Fermer la coupe">×</button>
          </span>
        </div>
        <div class="at-coupe-poignee" title="Glisser pour agrandir le profil" aria-hidden="true"></div>
        <div class="at-coupe-chiffres"></div>
        <div class="at-coupe-profil"><div class="at-coupe-bulle" hidden></div></div>
        <p class="at-note at-coupe-source"></p>
      </section>
      <div class="m3d-panel m3d-sun at-soleil" hidden>
        <div class="m3d-sun-row">
          <input type="date" class="m3d-date" aria-label="Date">
          <span class="m3d-presets">
            <button type="button" data-md="12-21">21 déc.</button>
            <button type="button" data-md="03-20">21 mars</button>
            <button type="button" data-md="06-21">21 juin</button>
          </span>
        </div>
        <input type="range" class="m3d-hour" min="5" max="22" step="0.25" value="14" aria-label="Heure légale">
        <p class="m3d-sun-info" aria-live="polite"></p>
      </div>
      <div class="at-vide" hidden>
        <p>Lancez d'abord une analyse dans l'onglet <a href="#diagnostic">Diagnostic</a> :
        l'atelier reprend son site et son périmètre.</p>
      </div>
    </div>`;

  const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const canvasEl = q<HTMLElement>(".at-canvas");
  const dateInput = q<HTMLInputElement>(".m3d-date");
  const hourInput = q<HTMLInputElement>(".m3d-hour");
  const sunInfo = q<HTMLElement>(".m3d-sun-info");
  const soleilPanel = q<HTMLElement>(".at-soleil");
  const vide = q<HTMLElement>(".at-vide");
  dateInput.value = today();

  // Panneau repliable (fermé par défaut sur téléphone).
  const setPanneau = (ouvert: boolean) => root.classList.toggle("panneau-ferme", !ouvert);
  setPanneau(!window.matchMedia("(max-width: 800px)").matches);
  q<HTMLButtonElement>(".at-replier").addEventListener("click", () => {
    setPanneau(false);
    setTimeout(() => map.resize(), 220);
  });
  q<HTMLButtonElement>(".at-ouvrir").addEventListener("click", () => {
    setPanneau(true);
    setTimeout(() => map.resize(), 220);
  });

  // --- Carte -------------------------------------------------------------------
  const vecteur = (): maplibregl.GeoJSONSourceSpecification => ({ type: "geojson", data: { type: "FeatureCollection", features: [] } });
  const raster = (c: CoucheDef): maplibregl.LayerSpecification => ({
    id: c.id,
    type: "raster",
    source: c.id,
    layout: { visibility: etat.get(c.id)!.actif ? "visible" : "none" },
    paint: { "raster-opacity": etat.get(c.id)!.opacite, "raster-fade-duration": 150 },
  });
  const rasters = COUCHES.filter((c) => c.tuiles);

  enregistrerProtocoleRelief();
  enregistrerProduit();
  const map = new maplibregl.Map({
    container: canvasEl,
    style: {
      version: 8,
      // Polices des étiquettes (cotes des courbes) : celles des styles vectoriels de l'IGN.
      glyphs: "https://data.geopf.fr/annexes/ressources/vectorTiles/fonts/{fontstack}/{range}.pbf",
      sources: {
        plan: { type: "raster", tiles: [FONDS.plan.tuiles], tileSize: 256, maxzoom: 19, attribution: "© IGN" },
        photo: { type: "raster", tiles: [FONDS.photo.tuiles], tileSize: 256, maxzoom: 19, attribution: "© IGN" },
        ...Object.fromEntries(
          // Ombrages LiDAR : en mode « produit » par défaut (ils assombrissent sans griser le fond).
          rasters.map((c) => [c.id, { type: "raster", tiles: [c.produit ? enProduit(c.tuiles!) : c.tuiles!], tileSize: 256, maxzoom: c.zoomMax ?? 20, attribution: c.source }]),
        ),
        bati: vecteur(),
        vegetation: vecteur(),
        arbres: vecteur(),
        ombres: vecteur(),
        "ombres-arbres": vecteur(),
        perimetre: vecteur(),
        "perimetre-projet": vecteur(),
        "perimetre-selection": vecteur(),
        carroyage: vecteur(),
        courbes: vecteur(),
        isochrones: vecteur(),
        equipements: vecteur(),
        patrimoine: vecteur(),
        coupe: vecteur(),
        // Deux sources pour les mêmes tuiles : MapLibre conseille de séparer terrain et ombrage.
        // Terrain jusqu'au zoom 15 (environ 3 m par pixel, assez pour le volume) ; ombrage au
        // zoom 14, plus doux : au mètre près, il dessine chaque talus et chaque mur.
        // Parcellaire Express en tuiles vectorielles (traits fins, numéros à la demande).
        pci: { type: "vector", tiles: ["https://data.geopf.fr/tms/1.0.0/PCI/{z}/{x}/{y}.pbf"], minzoom: 5, maxzoom: 19, attribution: "© IGN Parcellaire Express" },
        // Zoom maximal fixé à celui du LiDAR (une source ne change pas de maxzoom) ; en RGE ALTI, quelques tuiles de plus.
        dem: { type: "raster-dem", tiles: [tuilesRelief(sourceAlt)], tileSize: 256, encoding: "terrarium", maxzoom: ZOOM_MAX_RELIEF.lidar, attribution: "© IGN LiDAR HD, RGE ALTI®" },
        "dem-ombrage": { type: "raster-dem", tiles: [tuilesRelief(sourceAlt)], tileSize: 256, encoding: "terrarium", maxzoom: ZOOM_MAX_RELIEF.lidar - 1 },
      },
      // Pictogrammes du Plan IGN vectoriel (fond « Composé »).
      sprite: SPRITE_PLAN_IGN,
      layers: [
        { id: "fond-uni", type: "background", paint: { "background-color": "#efeeea" } },
        { id: "fond-plan", type: "raster", source: "plan", paint: { "raster-opacity": 0.7 } },
        { id: "fond-photo", type: "raster", source: "photo", layout: { visibility: "none" }, paint: { "raster-opacity": 0.7 } },
        {
          id: "relief",
          type: "hillshade",
          source: "dem-ombrage",
          layout: { visibility: "none" },
          paint: { "hillshade-exaggeration": 0.4, "hillshade-shadow-color": "#5b5246", "hillshade-highlight-color": "#fffdf8", "hillshade-accent-color": "#6e655a" },
        },
        ...rasters.filter((c) => c.id !== "cadastre").map(raster),
        {
          id: "isochrones",
          type: "fill",
          source: "isochrones",
          layout: { visibility: "none" },
          paint: { "fill-color": ["get", "couleur"], "fill-opacity": 0.35 },
        },
        {
          id: "isochrones-ligne",
          type: "line",
          source: "isochrones",
          layout: { visibility: "none", "line-join": "round" },
          paint: { "line-color": ["get", "couleur"], "line-width": 1.6, "line-dasharray": [4, 2] },
        },
        {
          id: "isochrones-cotes",
          type: "symbol",
          source: "isochrones",
          layout: {
            visibility: "none",
            "symbol-placement": "line",
            "symbol-spacing": 400,
            "text-field": ["get", "label"],
            "text-font": ["Source Sans Pro Regular"],
            "text-size": 11,
            "text-keep-upright": true,
          },
          paint: { "text-color": "#0b4f35", "text-halo-color": "rgba(255,255,255,0.9)", "text-halo-width": 1.5 },
        },
        { id: "vegetation", type: "fill", source: "vegetation", layout: { visibility: "none" }, paint: { "fill-color": "#5f9e4b", "fill-opacity": 0.5 } },
        { id: "ombres", type: "fill", source: "ombres", layout: { visibility: "none" }, paint: { "fill-color": "#1f2a44", "fill-opacity": 0.4 } },
        { id: "ombres-arbres", type: "fill", source: "ombres-arbres", layout: { visibility: "none" }, paint: { "fill-color": "#1f2a44", "fill-opacity": 0.32 } },
        // Heures de soleil au sol : image calculée, ajoutée au premier calcul (voir afficherEnsoleillement).
        {
          id: "cadastre",
          type: "line",
          source: "pci",
          "source-layer": "parcelle",
          minzoom: 15,
          paint: { "line-color": "#2b2b2e", "line-opacity": 0.8, "line-width": ["interpolate", ["linear"], ["zoom"], 15, 0.25, 17, 0.5, 19, 0.9] },
        },
        {
          id: "cadastre-numeros",
          type: "symbol",
          source: "pci",
          "source-layer": "localisant",
          minzoom: 17,
          layout: {
            visibility: "none",
            "text-field": ["to-string", ["to-number", ["get", "numero"], 0]],
            "text-font": ["Source Sans Pro Regular"],
            "text-size": 9.5,
            "text-allow-overlap": false,
          },
          paint: { "text-color": "#46464a", "text-halo-color": "rgba(255,255,255,0.85)", "text-halo-width": 1 },
        },
        { id: "bati-2d", type: "fill", source: "bati", paint: { "fill-color": NEUTRE, "fill-opacity": 1, "fill-outline-color": "rgba(60,60,60,0.45)" } },
        {
          id: "bati-3d",
          type: "fill-extrusion",
          source: "bati",
          layout: { visibility: "none" },
          paint: { "fill-extrusion-color": NEUTRE, "fill-extrusion-height": ["get", "h"], "fill-extrusion-opacity": 1, "fill-extrusion-vertical-gradient": false },
        },
        {
          id: "arbres",
          type: "circle",
          source: "arbres",
          paint: {
            "circle-color": "#3f8f3a",
            "circle-opacity": 0.85,
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 1,
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 1.5, 17, 4, 19, 9],
          },
        },
        // Patrimoine : du plus étendu (dessous) au plus précis (dessus).
        { id: "patrimoine-spr", type: "fill", source: "patrimoine", filter: ["==", ["get", "genre"], "spr"], layout: { visibility: "none" }, paint: { "fill-color": "#6b4fa8", "fill-opacity": 0.6 } },
        { id: "patrimoine-spr-ligne", type: "line", source: "patrimoine", filter: ["==", ["get", "genre"], "spr"], layout: { visibility: "none" }, paint: { "line-color": "#6b4fa8", "line-width": 1.6 } },
        { id: "patrimoine-sites", type: "fill", source: "patrimoine", filter: ["==", ["get", "genre"], "site"], layout: { visibility: "none" }, paint: { "fill-color": "#3d7a3a", "fill-opacity": 0.6 } },
        { id: "patrimoine-sites-ligne", type: "line", source: "patrimoine", filter: ["==", ["get", "genre"], "site"], layout: { visibility: "none" }, paint: { "line-color": "#3d7a3a", "line-width": 1.4 } },
        { id: "patrimoine-abords", type: "line", source: "patrimoine", filter: ["==", ["get", "genre"], "abords"], layout: { visibility: "none", "line-join": "round" }, paint: { "line-color": "#c4553f", "line-width": 1.1, "line-opacity": 0.65, "line-dasharray": [3, 2] } },
        { id: "patrimoine-mh", type: "fill", source: "patrimoine", filter: ["==", ["get", "genre"], "mh"], layout: { visibility: "none" }, paint: { "fill-color": "#9b2d20", "fill-opacity": 0.8, "fill-outline-color": "#6e1d14" } },
        {
          id: "patrimoine-noms",
          type: "symbol",
          source: "patrimoine",
          filter: ["==", ["get", "genre"], "mh"],
          minzoom: 15,
          layout: {
            visibility: "none",
            "text-field": ["get", "nom"],
            "text-font": ["Source Sans Pro Regular"],
            "text-size": 10.5,
            "text-max-width": 9,
            "text-offset": [0, 1.1],
            "text-optional": true,
          },
          paint: { "text-color": "#7a2318", "text-halo-color": "rgba(255,255,255,0.92)", "text-halo-width": 1.5 },
        },
        {
          id: "equipements",
          type: "circle",
          source: "equipements",
          layout: { visibility: "none" },
          paint: {
            "circle-color": ["get", "couleur"],
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 3, 17, 6],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 1.2,
            "circle-opacity": 1,
          },
        },
        {
          id: "courbes",
          type: "line",
          source: "courbes",
          layout: { visibility: "none", "line-join": "round" },
          paint: {
            "line-color": "#6b4a2c",
            "line-opacity": 0.85,
            "line-width": ["case", ["get", "maitresse"], 1.7, 1],
            "line-dasharray": [3, 2],
          },
        },
        {
          id: "courbes-cotes",
          type: "symbol",
          source: "courbes",
          filter: ["get", "maitresse"],
          layout: {
            visibility: "none",
            "symbol-placement": "line",
            "symbol-spacing": 260,
            "text-field": ["get", "label"],
            "text-font": ["Source Sans Pro Regular"],
            "text-size": 11,
            "text-max-angle": 35,
            "text-keep-upright": true,
          },
          paint: { "text-color": "#6b4e32", "text-halo-color": "rgba(255,255,255,0.9)", "text-halo-width": 1.5 },
        },
        {
          id: "carroyage",
          type: "line",
          source: "carroyage",
          layout: { visibility: "none" },
          paint: { "line-color": "#3a3a3c", "line-opacity": 0.45, "line-width": ["case", ["get", "majeur"], 1, 0.5] },
        },
        { id: "perimetre", type: "line", source: "perimetre", paint: { "line-color": "#3a3a3c", "line-width": 1.5, "line-dasharray": [3, 2] } },
        // Périmètre de projet : trait épais, même rouge que la carte du diagnostic.
        // Parcelles en cours de choix (pendant la sélection seulement).
        { id: "perimetre-selection-fond", type: "fill", source: "perimetre-selection", paint: { "fill-color": "#c4322b", "fill-opacity": 0.22 } },
        { id: "perimetre-selection-ligne", type: "line", source: "perimetre-selection", paint: { "line-color": "#c4322b", "line-width": 1.5 } },
        { id: "perimetre-projet", type: "line", source: "perimetre-projet", layout: { "line-join": "round" }, paint: { "line-color": "#c4322b", "line-width": 3 } },
        // Coupe de terrain : trait A–B (posé sur le relief en 3D), points clés, curseur du profil.
        { id: "coupe-halo", type: "line", source: "coupe", filter: ["==", ["geometry-type"], "LineString"], layout: { "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": 5, "line-opacity": 0.85 } },
        { id: "coupe-ligne", type: "line", source: "coupe", filter: ["==", ["geometry-type"], "LineString"], layout: { "line-cap": "round" }, paint: { "line-color": "#1d1d1f", "line-width": 2, "line-opacity": ["case", ["get", "apercu"], 0.5, 1] } },
        { id: "coupe-points", type: "circle", source: "coupe", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": ["case", ["==", ["get", "role"], "curseur"], 5, 4], "circle-color": ["case", ["==", ["get", "role"], "curseur"], "#f5b301", "#1d1d1f"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5 } },
        {
          id: "coupe-etiquettes",
          type: "symbol",
          source: "coupe",
          filter: ["all", ["==", ["geometry-type"], "Point"], ["has", "label"]],
          layout: { "text-field": ["get", "label"], "text-font": ["Source Sans Pro Regular"], "text-size": 11, "text-offset": [0, -1.2], "text-allow-overlap": true },
          paint: { "text-color": "#1d1d1f", "text-halo-color": "rgba(255,255,255,0.92)", "text-halo-width": 1.5 },
        },
      ],
    },
    center: [2.5, 46.6],
    zoom: 5,
    maxPitch: 75,
    attributionControl: { compact: true },
    canvasContextAttributes: { preserveDrawingBuffer: true }, // exports (mise en page)
    // Export de la vue 3D : la carte est rendue à haute résolution le temps de la capture.
    maxCanvasSize: [8192, 8192],
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 140 }), "bottom-right");
  // Arbres en volume (three.js), sous le carroyage et le périmètre.
  const coucheArbres = creerCoucheArbres3D("arbres-3d");
  const coucheCanopee3D = creerCoucheCanopee3D("canopee-3d");
  const coucheBati3D = creerCoucheBati3D("bati-lidar-3d");
  const coucheCourse = creerCoucheCourseSoleil("course-3d");
  coucheCourse.setPlan(true); // l'atelier s'ouvre en 2D
  const coucheCoupe3D = creerCoucheCoupe3D("coupe-3d");
  const pret = new Promise<void>((r) =>
    map.once("load", () => {
      map.addLayer(coucheArbres, "carroyage");
      map.setLayoutProperty("arbres-3d", "visibility", "none");
      map.addLayer(coucheCanopee3D, "carroyage");
      map.setLayoutProperty("canopee-3d", "visibility", "none");
      // Avant les arbres et la canopée : semi-transparents, ils n'écrivent pas la
      // profondeur ; dessinés avant eux, les bâtiments masquaient les arbres situés devant.
      map.addLayer(coucheBati3D, "arbres-3d");
      map.setLayoutProperty("bati-lidar-3d", "visibility", "none");
      map.addLayer(coucheCourse, "carroyage");
      map.setLayoutProperty("course-3d", "visibility", "none");
      map.addLayer(coucheCoupe3D, "carroyage");
      map.setLayoutProperty("coupe-3d", "visibility", "none");
      r();
    }),
  );

  // Perte du contexte WebGL (carte graphique saturée ou réinitialisée par le
  // navigateur) : MapLibre restaure sa carte, mais pas les couches three.js ;
  // on les ré-ajoute. Message tant que la carte n'est pas revenue.
  const perte = document.createElement("div");
  perte.className = "at-perte";
  perte.hidden = true;
  perte.innerHTML = `La carte graphique a interrompu l'affichage. Restauration en cours…
    <button type="button">Recharger l'atelier</button>`;
  perte.querySelector("button")!.addEventListener("click", () => location.reload());
  canvasEl.parentElement?.appendChild(perte);
  map.on("webglcontextlost", () => {
    perte.hidden = false;
  });
  map.on("webglcontextrestored", () => {
    for (const [id, c] of [["arbres-3d", coucheArbres], ["canopee-3d", coucheCanopee3D], ["bati-lidar-3d", coucheBati3D], ["course-3d", coucheCourse], ["coupe-3d", coucheCoupe3D]] as const) {
      if (map.getLayer(id)) map.removeLayer(id);
      const avant = id === "bati-lidar-3d" && map.getLayer("arbres-3d") ? "arbres-3d" : map.getLayer("carroyage") ? "carroyage" : undefined;
      map.addLayer(c, avant);
    }
    majCoupe3D(true);
    appliquer("bati");
    appliquer("arbres");
    appliquer("course");
    perte.hidden = true;
    map.triggerRepaint();
  });

  // --- Application de l'état aux couches ---------------------------------------
  const PROP: Record<string, string> = { hillshade: "hillshade-exaggeration", raster: "raster-opacity", fill: "fill-opacity", circle: "circle-opacity", line: "line-opacity", "fill-extrusion": "fill-extrusion-opacity" };
  function couchesMap(id: string): string[] {
    if (id === "fond") return [];
    if (id === "cadastre") return ["cadastre", "cadastre-numeros"];
    if (id === "bati") return ["bati-2d", "bati-3d", "bati-lidar-3d"];
    if (id === "arbres") return ["arbres", "arbres-3d", "canopee-3d"];
    if (id === "repere") return [];
    if (id === "course") return ["course-3d"];
    if (id === "courbes") return ["courbes", "courbes-cotes"];
    if (id === "isochrones") return ["isochrones", "isochrones-ligne", "isochrones-cotes"];
    if (id === "equipements") return ["equipements"];
    if (id === "patrimoine-mh") return ["patrimoine-abords", "patrimoine-mh", "patrimoine-noms"];
    if (id === "patrimoine-sites") return ["patrimoine-sites", "patrimoine-sites-ligne"];
    if (id === "patrimoine-spr") return ["patrimoine-spr", "patrimoine-spr-ligne"];
    if (id === "ensoleillement") return ["ensoleillement"];
    return [id];
  }
  function appliquer(id: string): void {
    const e = etat.get(id)!;
    if (id === "fond") {
      map.setLayoutProperty("fond-plan", "visibility", e.actif && fond === "plan" ? "visible" : "none");
      map.setLayoutProperty("fond-photo", "visibility", e.actif && (fond === "photo" || (fond === "compose" && photoDessous)) ? "visible" : "none");
      map.setPaintProperty("fond-plan", "raster-opacity", e.opacite);
      // Photo sous le fond composé : photo pleine, la réglette règle le Plan IGN posé dessus.
      map.setPaintProperty("fond-photo", "raster-opacity", fond === "compose" && photoDessous ? photo.opacite : e.opacite);
      // Effet sobre sur mesure : désaturation (noir et blanc à 0 %) et éclaircissement.
      map.setPaintProperty("fond-photo", "raster-saturation", photo.couleurs - 1);
      map.setPaintProperty("fond-photo", "raster-brightness-min", photo.eclaircir * 0.85);
      const photoVisible = fond === "photo" || (fond === "compose" && photoDessous);
      root.querySelector<HTMLElement>(".at-photo-reglages")!.hidden = !photoVisible;
      // En mode « Photo », la réglette principale règle déjà l'opacité.
      root.querySelector<HTMLElement>("[data-ligne-photo-opacite]")!.hidden = fond === "photo";
      root.querySelector<HTMLElement>(".at-themes-ign")!.hidden = fond !== "compose";
      if (fond === "compose" && !couchesIgn) void chargerFondIgn();
      for (const c of couchesIgn ?? []) {
        if (!map.getLayer(c.layer.id)) continue;
        const theme = themesIgn.get(c.theme) && !(photoDessous && c.theme === "fond");
        map.setLayoutProperty(c.layer.id, "visibility", e.actif && fond === "compose" && theme ? "visible" : "none");
        for (const prop of OPACITE[c.layer.type] ?? []) map.setPaintProperty(c.layer.id, prop, e.opacite);
      }
    }
    for (const lid of couchesMap(id)) {
      const layer = map.getLayer(lid);
      if (!layer) continue;
      let visible = e.actif;
      if (lid === "bati-2d") visible = e.actif && !mode3d;
      if (lid === "bati-3d") visible = e.actif && mode3d && batiRendu === "extrude";
      if (lid === "bati-lidar-3d") visible = e.actif && mode3d && batiRendu !== "extrude";
      // Arbres en volume dans les deux vues (vus en plan en 2D), ou en points.
      if (lid === "arbres") visible = e.actif && rendu === "point";
      if (lid === "arbres-3d") visible = e.actif && rendu === "volume";
      if (lid === "canopee-3d") visible = e.actif && rendu === "canopee";
      if (lid === "cadastre-numeros") visible = e.actif && numerosCadastre;
      map.setLayoutProperty(lid, "visibility", visible ? "visible" : "none");
      const prop = PROP[layer.type];
      // Isochrones : la réglette règle le remplissage ; les contours restent nets.
      // Patrimoine : aplats légers pour les sites et SPR, contours et noms toujours nets.
      const aplatLeger = lid === "patrimoine-sites" || lid === "patrimoine-spr";
      const net = lid === "isochrones-ligne" || lid === "patrimoine-abords" || lid.endsWith("-ligne") || lid === "patrimoine-noms";
      if (prop && !net) map.setPaintProperty(lid, prop, aplatLeger ? e.opacite * 0.3 : e.opacite);
      if (lid === "arbres-3d") coucheArbres.setOpacite(e.opacite);
      if (lid === "canopee-3d") coucheCanopee3D.setOpacite(e.opacite);
      if (lid === "bati-lidar-3d") coucheBati3D.setOpacite(e.opacite);
      if (lid === "course-3d") coucheCourse.setOpacite(e.opacite);
      if (lid === "arbres") map.setPaintProperty(lid, "circle-stroke-opacity", e.opacite);
      if (lid === "courbes-cotes") map.setPaintProperty(lid, "text-opacity", e.opacite);
      if (lid === "equipements") map.setPaintProperty(lid, "circle-stroke-opacity", e.opacite);
      if (lid === "cadastre-numeros") map.setPaintProperty(lid, "text-opacity", e.opacite);
    }
    if (id === "bati" && e.actif && mode3d && batiRendu !== "extrude") void chargerBatiLidar();
    if (id === "relief") {
      texteRelief = "";
      majTerrain();
    }
    if (id === "courbes" && e.actif) void dessinerCourbes();
    if (id === "isochrones" && e.actif) void dessinerIsochrones();
    if (id === "equipements" && e.actif) void dessinerEquipements();
    if (id.startsWith("patrimoine-") && e.actif) void dessinerPatrimoine();
    if (id === "repere" && marker) {
      const el = marker.getElement();
      el.style.display = e.actif ? "" : "none";
      el.style.opacity = String(e.opacite);
    }
    if (id === "carroyage" && e.actif) dessinerCarroyage();
    if (id === "ombres" || id === "arbres") {
      const o = etat.get("ombres")!;
      if (map.getLayer("ombres-arbres")) {
        map.setLayoutProperty("ombres-arbres", "visibility", o.actif && etat.get("arbres")!.actif ? "visible" : "none");
        map.setPaintProperty("ombres-arbres", "fill-opacity", o.opacite * 0.8);
      }
    }
    if (id === "ombres" && !e.actif) eclairer(null);
    if (id === "ombres" || id === "course") {
      // Le panneau date / heure sert aux ombres et à la course du soleil.
      soleilPanel.hidden = !(etat.get("ombres")!.actif || etat.get("course")!.actif || etat.get("ensoleillement")!.actif);
      if (e.actif) demanderOmbres();
    }
    if (id === "ensoleillement") {
      soleilPanel.hidden = !(etat.get("ombres")!.actif || etat.get("course")!.actif || e.actif);
      if (e.actif) void chargerCouche("bati").then(demanderCumul);
    }
  }
  function compter(): void {
    const n = [...etat.values()].filter((e) => e.actif).length;
    q<HTMLElement>(".at-compte").textContent = `${n} active${n > 1 ? "s" : ""}`;
    // Par thème : couches actives, utile quand le thème est replié.
    for (const f of FAMILLES) {
      const cs = COUCHES.filter((c) => c.famille === f);
      const a = cs.filter((c) => etat.get(c.id)!.actif).length;
      const el = root.querySelector<HTMLElement>(`[data-famille="${f}"] .at-famille-n`);
      if (el) el.textContent = a ? `${a}/${cs.length}` : "";
    }
  }
  // Thèmes repliables ; l'état est retenu dans ce navigateur.
  root.querySelectorAll<HTMLButtonElement>(".at-famille-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const sec = b.closest<HTMLElement>(".at-famille")!;
      const f = sec.dataset.famille!;
      const replie = !sec.classList.contains("repliee");
      sec.classList.toggle("repliee", replie);
      b.setAttribute("aria-expanded", String(!replie));
      if (replie) famillesRepliees.add(f);
      else famillesRepliees.delete(f);
      try {
        localStorage.setItem(CLE_REPLIEES, JSON.stringify([...famillesRepliees]));
      } catch {
        /* stockage indisponible : l'état vaut pour la session */
      }
    }),
  );

  // --- Coloration du bâti ----------------------------------------------------------
  function couleurBati(): maplibregl.DataDrivenPropertyValueSpecification<string> {
    if (coloration === "neutre") return NEUTRE;
    if (coloration === "usage") {
      return ["match", ["get", "usage"], ...USAGES.flatMap((u) => [u.valeur, u.color]), USAGE_AUTRE] as unknown as maplibregl.ExpressionSpecification;
    }
    return [
      "case",
      ["!", ["get", "connue"]],
      INCONNU,
      ["step", ["get", "h"], HAUTEURS[0].color, ...HAUTEURS.slice(0, -1).flatMap((c, i) => [c.max, HAUTEURS[i + 1].color])],
    ] as maplibregl.ExpressionSpecification;
  }
  /** Couleur de chaque bâtiment, mêmes règles que couleurBati(), pour les volumes LiDAR. */
  function couleursBatiLidar(data: BuildingsResult): number[] {
    const hex = (c: string) => parseInt(c.slice(1), 16);
    return data.buildings.map((b) => {
      if (coloration === "neutre") return hex(NEUTRE);
      if (coloration === "usage") return hex(USAGES.find((u) => u.valeur === (b.info?.usage ?? ""))?.color ?? USAGE_AUTRE);
      if (b.heightM === null) return hex(INCONNU);
      return hex((HAUTEURS.find((h) => b.heightM! < h.max) ?? HAUTEURS[HAUTEURS.length - 1]).color);
    });
  }

  // --- Bâti en volumes mesurés (LiDAR HD) --------------------------------------------
  let batiLidarPour: BuildingsResult | null = null;
  let dernierBilanBati: { bilan: BilanBati3D; couverture: number } | null = null;
  function afficherBilanBati(): void {
    if (!dernierBilanBati || batiRendu === "extrude") return;
    const { bilan, couverture } = dernierBilanBati;
    const fr = (v: number) => v.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
    texteBatiLidar(
      bilan.mesures === 0
        ? "LiDAR HD pas encore publié ici : volumes extrudés à la hauteur BD TOPO, toit plat."
        : (batiRendu === "plans"
            ? `Toits reconstruits en ${bilan.pans ?? 0} pans plans à partir du LiDAR HD (maille de ${fr(bilan.pixelM)} m) pour ${bilan.mesures} bâtiments sur ${bilan.batiments}`
            : `Volumes mesurés par le LiDAR HD (maille de ${fr(bilan.pixelM)} m) pour ${bilan.mesures} bâtiments sur ${bilan.batiments}`) +
            (bilan.mesures < bilan.batiments ? " ; les autres, peu couverts, extrudés à leur hauteur BD TOPO (toit plat)." : ".") +
            " Houppiers (CoSIA) et pixels au-dessus du faîtage BD TOPO écartés." +
            (couverture < 1 ? ` ${Math.round((1 - couverture) * 100)} % des tuiles LiDAR refusées par l'IGN : réactiver le bâti pour compléter.` : ""),
    );
  }
  function texteBatiLidar(t: string): void {
    const p = q<HTMLElement>("[data-bati-lidar]");
    p.hidden = !t;
    p.textContent = t;
  }
  async function chargerBatiLidar(): Promise<void> {
    if (!site || !dernierBatiData || batiLidarPour === dernierBatiData) return;
    const ctx = site, data = dernierBatiData;
    batiLidarPour = data;
    texteBatiLidar("Lecture du LiDAR HD pour les volumes…");
    coucheBati3D.setMode(batiRendu === "plans" ? "plans" : "brut");
    try {
      const g = await grilleSursol(ctx.lat, ctx.lon, ctx.radiusM ?? 150, (f, t) => texteBatiLidar(`Lecture du LiDAR HD pour les volumes : ${f} / ${t} tuiles…`));
      if (site !== ctx || dernierBatiData !== data) return;
      const couleurs = couleursBatiLidar(data);
      const bilan = coucheBati3D.setBati(
        g,
        data.buildings.map((b, k) => ({ ring: b.polygon.map((p) => [p.lon, p.lat] as [number, number]), hRepli: b.heightM ?? DEFAULT_HEIGHT_M, faitage: b.info?.faitageM, couleur: couleurs[k] })),
        ctx.lat,
        ctx.lon,
      );
      dernierBilanBati = { bilan, couverture: g.couverture };
      afficherBilanBati();
    } catch {
      if (dernierBatiData !== data) return;
      batiLidarPour = null;
      texteBatiLidar("LiDAR HD indisponible (service de l'IGN muet ou pas encore publié ici) : volumes extrudés BD TOPO.");
      batiRendu = "extrude";
      root.querySelectorAll("[data-bati-rendu]").forEach((x) => x.setAttribute("aria-pressed", String(x.getAttribute("data-bati-rendu") === batiRendu)));
      appliquer("bati");
    }
  }
  root.querySelectorAll<HTMLButtonElement>("[data-bati-rendu]").forEach((b) =>
    b.addEventListener("click", async () => {
      batiRendu = b.dataset.batiRendu as typeof batiRendu;
      root.querySelectorAll("[data-bati-rendu]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      try {
        localStorage.setItem("atelier:bati-rendu", batiRendu);
      } catch {
        /* rien */
      }
      await pret;
      if (batiRendu === "extrude") texteBatiLidar("");
      else {
        const b = coucheBati3D.setMode(batiRendu === "plans" ? "plans" : "brut");
        if (dernierBilanBati) {
          dernierBilanBati.bilan = b;
          afficherBilanBati();
        }
        if (!mode3d) texteBatiLidar("Volumes mesurés visibles en vue 3D.");
      }
      appliquer("bati");
    }),
  );

  function legendeBati(): string {
    const pastille = (color: string, label: string) => `<span><i style="background:${color}"></i>${esc(label)}</span>`;
    if (coloration === "neutre") return "";
    if (coloration === "usage") return USAGES.map((u) => pastille(u.color, u.valeur)).join("") + pastille(USAGE_AUTRE, "Annexe, autre ou inconnu");
    return HAUTEURS.map((h) => pastille(h.color, `${h.label} m`)).join("") + pastille(INCONNU, `inconnue (${DEFAULT_HEIGHT_M} m supposés)`);
  }
  function appliquerColoration(): void {
    if (etat.get("ombres")!.actif && dernierSoleil) eclairer(dernierSoleil);
    map.setPaintProperty("bati-2d", "fill-color", couleurBati());
    map.setPaintProperty("bati-3d", "fill-extrusion-color", couleurBati());
    if (dernierBatiData) coucheBati3D.setCouleurs(couleursBatiLidar(dernierBatiData));
    q<HTMLElement>("[data-legende-bati]").innerHTML = legendeBati();
    root.querySelectorAll<HTMLButtonElement>("[data-cosia]").forEach((b) =>
    b.addEventListener("click", async () => {
      millesime = b.dataset.cosia as MillesimeCosia;
      root.querySelectorAll("[data-cosia]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      await pret;
      (map.getSource("cosia") as maplibregl.RasterTileSource).setTiles([tuilesCosia(millesime)]);
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-arbres-src]").forEach((b) =>
    b.addEventListener("click", async () => {
      sourceArbres = b.dataset.arbresSrc as typeof sourceArbres;
      root.querySelectorAll("[data-arbres-src]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      await pret;
      charge.delete("arbres");
      if (etat.get("arbres")!.actif) void chargerCouche("arbres");
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-rendu]").forEach((b) =>
    b.addEventListener("click", async () => {
      rendu = b.dataset.rendu as typeof rendu;
      root.querySelectorAll("[data-rendu]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      await pret;
      appliquer("arbres");
      if (rendu === "canopee") void chargerCanopee3D();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-pas]").forEach((b) =>
    b.addEventListener("click", async () => {
      pas = Number(b.dataset.pas) as typeof pas;
      root.querySelectorAll("[data-pas]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      await pret;
      dessinerCarroyage();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-colo]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.colo === coloration)));
  }

  // --- Interactions du panneau ---------------------------------------------------
  root.querySelectorAll<HTMLElement>(".at-couche").forEach((el) => {
    const id = el.dataset.couche!;
    const e = etat.get(id)!;
    const sw = el.querySelector<HTMLInputElement>(".switch")!;
    const range = el.querySelector<HTMLInputElement>(':scope > .at-reglages > .at-opacite input[type="range"]')!;
    const out = el.querySelector(":scope > .at-reglages > .at-opacite output")!;
    sw.addEventListener("change", async () => {
      e.actif = sw.checked;
      el.classList.toggle("on", e.actif);
      compter();
      await pret;
      appliquer(id);
      if (e.actif) void chargerCouche(id);
    });
    range.addEventListener("input", async () => {
      e.opacite = Number(range.value) / 100;
      out.textContent = `${range.value} %`;
      await pret;
      appliquer(id);
    });
  });
  // --- Fond composé (Plan IGN vectoriel par thèmes) -------------------------------------
  async function chargerFondIgn(): Promise<void> {
    try {
      const { source, couches } = await chargerStylePlanIgn();
      await pret;
      if (!map.getSource("plan_ign")) map.addSource("plan_ign", source as maplibregl.SourceSpecification);
      // Sous l'ombrage du relief et toutes nos couches, au-dessus des fonds raster ;
      // sauf les noms, toujours lisibles : au-dessus du bâti et des couches
      // thématiques, juste sous la coupe et le repère du site.
      for (const c of couches)
        if (!map.getLayer(c.layer.id)) map.addLayer(c.layer as unknown as maplibregl.LayerSpecification, c.theme === "noms" ? "coupe-halo" : "relief");
      couchesIgn = couches;
      appliquer("fond");
    } catch {
      etatCouche("fond", "Plan IGN vectoriel indisponible pour le moment.");
    }
  }
  // Mode de fusion des ombrages LiDAR : « produit » (voile multiplicatif) ou normal.
  root.querySelectorAll<HTMLButtonElement>("[data-produit]").forEach((b) =>
    b.addEventListener("click", async () => {
      const c = COUCHES.find((x) => x.id === b.dataset.produit)!;
      root.querySelectorAll(`[data-produit="${c.id}"]`).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      await pret;
      (map.getSource(c.id) as maplibregl.RasterTileSource).setTiles([b.dataset.fusion === "produit" ? enProduit(c.tuiles!) : c.tuiles!]);
    }),
  );
  root.querySelectorAll<HTMLInputElement>("[data-photo]").forEach((r) =>
    r.addEventListener("input", async () => {
      photo[r.dataset.photo as keyof typeof photo] = Number(r.value) / 100;
      r.parentElement!.querySelector("output")!.textContent = `${r.value} %`;
      await pret;
      appliquer("fond");
    }),
  );
  root.querySelector<HTMLInputElement>("[data-photo-dessous]")!.addEventListener("change", async (ev) => {
    photoDessous = (ev.target as HTMLInputElement).checked;
    // Le thème « Fond » (aplat opaque) masquerait la photo : décoché avec elle.
    const fondCb = root.querySelector<HTMLInputElement>('[data-theme-ign="fond"]')!;
    fondCb.disabled = photoDessous;
    await pret;
    appliquer("fond");
  });
  root.querySelectorAll<HTMLInputElement>("[data-theme-ign]").forEach((cb) =>
    cb.addEventListener("change", async () => {
      themesIgn.set(cb.dataset.themeIgn as ThemeIgn, cb.checked);
      await pret;
      appliquer("fond");
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-numeros]").forEach((b) =>
    b.addEventListener("click", async () => {
      numerosCadastre = b.dataset.numeros === "oui";
      root.querySelectorAll("[data-numeros]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      await pret;
      appliquer("cadastre");
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-fond]").forEach((b) =>
    b.addEventListener("click", async () => {
      fond = b.dataset.fond as Fond;
      root.querySelectorAll("[data-fond]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      await pret;
      appliquer("fond");
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-colo]").forEach((b) =>
    b.addEventListener("click", async () => {
      coloration = b.dataset.colo as Coloration;
      await pret;
      appliquerColoration();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>(".at-mode button").forEach((b) =>
    b.addEventListener("click", () => {
      mode3d = b.dataset.mode === "3d";
      coucheCourse.setPlan(!mode3d);
      // Focale en 3D seulement : le plan 2D garde la perspective par défaut.
      focaleEl.hidden = !mode3d;
      map.setVerticalFieldOfView(mode3d ? champVertical(focale) : FOV_DEFAUT);
      root.querySelectorAll(".at-mode button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      map.easeTo({ pitch: mode3d ? 55 : 0, bearing: mode3d ? -20 : 0, duration: 600 });
      appliquer("bati");
      appliquer("arbres");
      majTerrain();
      majCoupe3D(true);
    }),
  );

  // --- Focale de la vue 3D -----------------------------------------------------------
  // MapLibre garde l'échelle au centre de la vue : changer la focale rapproche ou
  // éloigne la caméra (effet « travelling compensé ») ; courte focale = profondeur accentuée.
  const FOV_DEFAUT = map.getVerticalFieldOfView();
  let focale: number = FOCALE_DEFAUT;
  const focaleEl = q<HTMLElement>(".at-focale");
  const focaleRange = q<HTMLInputElement>(".at-focale-reglette");
  const focaleBtn = q<HTMLButtonElement>(".at-focale-btn");
  function setFocale(f: number): void {
    const i = FOCALES.reduce((m, v, k) => (Math.abs(v - f) < Math.abs(FOCALES[m] - f) ? k : m), 0);
    focale = FOCALES[i];
    focaleRange.value = String(i);
    focaleBtn.querySelector("span")!.textContent = `${focale} mm`;
    if (mode3d) map.setVerticalFieldOfView(champVertical(focale));
  }
  focaleRange.addEventListener("input", () => setFocale(FOCALES[Number(focaleRange.value)]));
  // Réglette repliée dans le bouton : elle se déplie à côté de 2D / 3D au clic.
  focaleBtn.addEventListener("click", () => {
    const ouvrir = focaleRange.hidden;
    focaleRange.hidden = !ouvrir;
    focaleBtn.setAttribute("aria-expanded", String(ouvrir));
  });

  // --- Vues enregistrées ---------------------------------------------------------------
  // L'état est lu sur les commandes du panneau et rejoué en les actionnant : une vue
  // passe par les mêmes chemins qu'un clic, sans logique en double.
  const GROUPES = ["fond", "colo", "exag", "courbes", "alt", "arbres-src", "pas", "cosia", "rendu", "numeros", "mode"] as const;
  const vuesEl = q<HTMLElement>(".at-vues");
  const listeVues = q<HTMLElement>(".at-vues-liste");
  const formVue = q<HTMLFormElement>(".at-vues-form");
  const nomVue = formVue.querySelector("input")!;
  const menuVues = q<HTMLElement>(".at-vues-menu");
  const menuVue = q<HTMLElement>(".at-vue-menu");
  const msgVues = q<HTMLElement>(".at-vues-msg");
  const fichierVues = q<HTMLInputElement>(".at-vues-fichier");
  const idsCouches = COUCHES.map((c) => c.id);
  let vues: Vue[] = lireVues() ?? vuesDeDepart(idsCouches);
  let vueActive: number | null = null;
  let vueMenu = -1; // vue dont le menu est ouvert
  let renommage: number | null = null; // null : nouvelle vue

  function capturerVue(nom: string): Vue {
    const reglages: Record<string, string> = {};
    for (const g of GROUPES) {
      const b = root.querySelector<HTMLElement>(`[data-${g}][aria-pressed="true"]`);
      if (b) reglages[g] = b.getAttribute(`data-${g}`)!;
    }
    root.querySelectorAll<HTMLElement>('[data-produit][aria-pressed="true"]').forEach((b) => (reglages[`produit:${b.dataset.produit}`] = b.dataset.fusion!));
    reglages.envergure = q<HTMLInputElement>("[data-envergure]").value;
    const coches: Record<string, boolean> = { "photo-dessous": q<HTMLInputElement>("[data-photo-dessous]").checked };
    root.querySelectorAll<HTMLInputElement>("[data-theme-ign]").forEach((cb) => (coches[`theme-ign:${cb.dataset.themeIgn}`] = cb.checked));
    return {
      nom,
      couches: Object.fromEntries([...etat].map(([id, e]) => [id, [e.actif, Math.round(e.opacite * 100) / 100]])),
      reglages,
      coches,
      photo: { ...photo },
      camera: mode3d ? { pitch: Math.round(map.getPitch()), bearing: Math.round(map.getBearing()), focale } : undefined,
    };
  }
  const actionner = (el: HTMLInputElement, type: "change" | "input") => el.dispatchEvent(new Event(type, { bubbles: true }));
  function appliquerVue(v: Vue): void {
    for (const [g, val] of Object.entries(v.reglages ?? {})) {
      if (g === "mode") continue;
      if (g === "envergure") {
        const r = q<HTMLInputElement>("[data-envergure]");
        if (r.value !== val) {
          r.value = val;
          actionner(r, "input");
        }
        continue;
      }
      const sel = g.startsWith("produit:") ? `[data-produit="${g.slice(8)}"][data-fusion="${val}"]` : `[data-${g}="${val}"]`;
      const b = root.querySelector<HTMLButtonElement>(sel);
      if (b && b.getAttribute("aria-pressed") !== "true") b.click();
    }
    const coches = v.coches ?? {};
    const dessous = q<HTMLInputElement>("[data-photo-dessous]");
    if ("photo-dessous" in coches && dessous.checked !== coches["photo-dessous"]) {
      dessous.checked = coches["photo-dessous"];
      actionner(dessous, "change");
    }
    root.querySelectorAll<HTMLInputElement>("[data-theme-ign]").forEach((cb) => {
      const val = coches[`theme-ign:${cb.dataset.themeIgn}`];
      if (val !== undefined && cb.checked !== val) {
        cb.checked = val;
        actionner(cb, "change");
      }
    });
    root.querySelectorAll<HTMLInputElement>("[data-photo]").forEach((r) => {
      const val = v.photo?.[r.dataset.photo!];
      if (typeof val === "number" && Number(r.value) !== Math.round(val * 100)) {
        r.value = String(Math.round(val * 100));
        actionner(r, "input");
      }
    });
    for (const [id, [actif, opacite]] of Object.entries(v.couches)) {
      const el = root.querySelector<HTMLElement>(`.at-couche[data-couche="${id}"]`);
      if (!el) continue;
      const sw = el.querySelector<HTMLInputElement>(".switch")!;
      const range = el.querySelector<HTMLInputElement>(':scope > .at-reglages > .at-opacite input[type="range"]')!;
      if (opacite >= 0 && Number(range.value) !== Math.round(opacite * 100)) {
        range.value = String(Math.round(opacite * 100));
        actionner(range, "input");
      }
      if (sw.checked !== actif) {
        sw.checked = actif;
        actionner(sw, "change");
      }
    }
    const mode = v.reglages?.mode;
    const bMode = mode ? root.querySelector<HTMLButtonElement>(`.at-mode [data-mode="${mode}"]`) : null;
    if (bMode && bMode.getAttribute("aria-pressed") !== "true") bMode.click();
    if (v.camera && mode3d) {
      setFocale(v.camera.focale);
      map.easeTo({ pitch: v.camera.pitch, bearing: v.camera.bearing, duration: 700 });
    }
  }
  function dessinerVues(): void {
    listeVues.innerHTML = vues.length
      ? vues
          .map(
            (v, i) => `<span class="at-vue">
              <button type="button" class="at-vue-btn" data-vue-i="${i}" aria-pressed="${i === vueActive}">${esc(v.nom)}${v.camera ? '<span class="at-vue-3d">3D</span>' : ""}</button>
              <button type="button" class="at-vue-plus" data-vue-menu="${i}" aria-label="Actions sur la vue ${esc(v.nom)}" aria-haspopup="menu">⋯</button>
            </span>`,
          )
          .join("")
      : '<p class="at-note">Aucune vue : réglez les couches, puis « Enregistrer ».</p>';
    // Thème replié : la vue active reste lisible dans l'en-tête.
    q<HTMLElement>(".at-vues-active").textContent = vueActive !== null && vues[vueActive] ? ` · ${vues[vueActive].nom}` : "";
  }
  q<HTMLButtonElement>(".at-vues-titre").addEventListener("click", (ev) => {
    const replie = !vuesEl.classList.contains("repliee");
    vuesEl.classList.toggle("repliee", replie);
    (ev.currentTarget as HTMLElement).setAttribute("aria-expanded", String(!replie));
    if (replie) fermerMenus();
    try {
      localStorage.setItem(CLE_VUES_REPLIEES, replie ? "1" : "0");
    } catch {
      /* stockage indisponible */
    }
  });
  function memoriser(): void {
    ecrireVues(vues);
    dessinerVues();
  }
  let minuterieMsg = 0;
  function message(texte: string, annuler?: () => void): void {
    msgVues.innerHTML = esc(texte) + (annuler ? ' <button type="button" class="at-lien">Annuler</button>' : "");
    msgVues.hidden = false;
    msgVues.querySelector("button")?.addEventListener("click", () => {
      annuler!();
      msgVues.hidden = true;
    });
    clearTimeout(minuterieMsg);
    minuterieMsg = window.setTimeout(() => (msgVues.hidden = true), 6000);
  }
  function fermerMenus(): void {
    menuVues.hidden = menuVue.hidden = true;
    q<HTMLElement>(".at-vues-menu-btn").setAttribute("aria-expanded", "false");
  }
  function ouvrirFormulaire(nom: string, index: number | null): void {
    renommage = index;
    formVue.hidden = false;
    nomVue.value = nom;
    nomVue.focus();
    nomVue.select();
  }
  q<HTMLButtonElement>(".at-vues-plus").addEventListener("click", () => {
    fermerMenus();
    if (vuesEl.classList.contains("repliee")) q<HTMLButtonElement>(".at-vues-titre").click();
    ouvrirFormulaire(`Vue ${vues.length + 1}`, null);
  });
  formVue.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const nom = nomVue.value.trim();
    if (!nom) return;
    if (renommage === null) {
      vues.push(capturerVue(nom));
      vueActive = vues.length - 1;
      message(`Vue « ${nom} » enregistrée.`);
    } else vues[renommage].nom = nom;
    formVue.hidden = true;
    memoriser();
  });
  q<HTMLButtonElement>("[data-vues-annuler]").addEventListener("click", () => (formVue.hidden = true));
  listeVues.addEventListener("click", (ev) => {
    const cible = ev.target as HTMLElement;
    const b = cible.closest<HTMLElement>("[data-vue-i]");
    const m = cible.closest<HTMLElement>("[data-vue-menu]");
    if (b) {
      fermerMenus();
      const i = Number(b.dataset.vueI);
      appliquerVue(vues[i]);
      vueActive = i;
      dessinerVues();
    } else if (m) {
      const i = Number(m.dataset.vueMenu);
      const ouvert = !menuVue.hidden && vueMenu === i;
      fermerMenus();
      if (ouvert) return;
      vueMenu = i;
      menuVue.querySelector<HTMLButtonElement>('[data-vue-action="gauche"]')!.disabled = i === 0;
      const r = m.getBoundingClientRect(), base = vuesEl.getBoundingClientRect();
      menuVue.style.top = `${r.bottom - base.top + 4}px`;
      menuVue.style.left = `${Math.max(8, Math.min(r.left - base.left, base.width - 230))}px`;
      menuVue.hidden = false;
    }
  });
  menuVue.addEventListener("click", (ev) => {
    const action = (ev.target as HTMLElement).closest<HTMLElement>("[data-vue-action]")?.dataset.vueAction;
    const i = vueMenu;
    fermerMenus();
    if (!action || !vues[i]) return;
    if (action === "maj") {
      vues[i] = capturerVue(vues[i].nom);
      vueActive = i;
      message(`Vue « ${vues[i].nom} » mise à jour.`);
    } else if (action === "renommer") return ouvrirFormulaire(vues[i].nom, i);
    else if (action === "gauche" && i > 0) {
      [vues[i - 1], vues[i]] = [vues[i], vues[i - 1]];
      if (vueActive === i) vueActive = i - 1;
      else if (vueActive === i - 1) vueActive = i;
    } else if (action === "supprimer") {
      const [retiree] = vues.splice(i, 1);
      if (vueActive === i) vueActive = null;
      else if (vueActive !== null && vueActive > i) vueActive--;
      message(`Vue « ${retiree.nom} » supprimée.`, () => {
        vues.splice(i, 0, retiree);
        memoriser();
      });
    }
    memoriser();
  });
  q<HTMLButtonElement>(".at-vues-menu-btn").addEventListener("click", (ev) => {
    const ouvert = menuVues.hidden;
    fermerMenus();
    menuVues.hidden = !ouvert;
    (ev.currentTarget as HTMLElement).setAttribute("aria-expanded", String(ouvert));
  });
  menuVues.addEventListener("click", (ev) => {
    const action = (ev.target as HTMLElement).closest<HTMLElement>("[data-vues-action]")?.dataset.vuesAction;
    fermerMenus();
    if (action === "exporter") {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(exporterVues(vues));
      a.download = `vues-atelier-${today()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } else if (action === "importer") fichierVues.click();
    else if (action === "depart") {
      const noms = new Set(vues.map((v) => v.nom));
      const ajout = vuesDeDepart(idsCouches).filter((v) => !noms.has(v.nom));
      vues.push(...ajout);
      memoriser();
      message(ajout.length ? `${ajout.length} vue${ajout.length > 1 ? "s" : ""} de départ ajoutée${ajout.length > 1 ? "s" : ""}.` : "Les vues de départ sont déjà là.");
    }
  });
  fichierVues.addEventListener("change", async () => {
    const f = fichierVues.files?.[0];
    fichierVues.value = "";
    if (!f) return;
    try {
      const lues = lireExport(await f.text());
      // Même nom : la vue importée remplace l'ancienne.
      for (const v of lues) {
        const k = vues.findIndex((x) => x.nom === v.nom);
        if (k >= 0) vues[k] = v;
        else vues.push(v);
      }
      memoriser();
      message(`${lues.length} vue${lues.length > 1 ? "s" : ""} importée${lues.length > 1 ? "s" : ""}.`);
    } catch {
      message("Fichier non reconnu : exportez-le depuis l'atelier (format JSON).");
    }
  });
  document.addEventListener("click", (ev) => {
    if (!(ev.target as HTMLElement).closest(".at-vues-menu, .at-vue-menu, .at-vues-menu-btn, [data-vue-menu]")) fermerMenus();
  });
  // Un réglage fait à la main fait quitter la vue active (les actions rejouées par une vue ne sont pas « de confiance »).
  const quitterVue = (ev: Event) => {
    if (!ev.isTrusted || vueActive === null || (ev.target as HTMLElement).closest(".at-vues, .at-famille-btn, .at-leg")) return;
    vueActive = null;
    dessinerVues();
  };
  for (const zone of [q<HTMLElement>(".at-familles"), q<HTMLElement>(".at-mode"), focaleEl, q<HTMLElement>(".at-coupe")]) {
    zone.addEventListener("change", quitterVue);
    zone.addEventListener("click", quitterVue);
    zone.addEventListener("input", quitterVue);
  }
  dessinerVues();

  // --- Relief 3D -----------------------------------------------------------------
  // Terrain en vue 3D seulement : en 2D le plan reste orthogonal et l'ombrage suffit.
  function majTerrain(): void {
    const actif = etat.get("relief")!.actif && mode3d;
    const courant = map.getTerrain();
    if (actif && (!courant || courant.exaggeration !== exag)) map.setTerrain({ source: "dem", exaggeration: exag });
    if (!actif && courant) map.setTerrain(null);
    poserSurSol();
  }
  /** Arbres et course du soleil posés sur le terrain (altitudes lues une fois les tuiles chargées). */
  let minuterieSol = 0;
  let cleSol = "";
  function poserSurSol(): void {
    clearTimeout(minuterieSol);
    if (!map.getTerrain()) {
      if (cleSol === "") return;
      cleSol = "";
      coucheArbres.setSol(null);
      coucheCanopee3D.setSol(null);
      coucheBati3D.setSol(null);
      coucheCourse.setAltitude(0);
      return;
    }
    minuterieSol = window.setTimeout(() => {
      if (!map.getTerrain() || !site) return;
      const alt = (lon: number, lat: number) => map.queryTerrainElevation([lon, lat]);
      // On ne repose que si le terrain chargé a changé (sinon boucle : reposer redessine, donc « idle »).
      const d = 0.002;
      const cle = [[0, 0], [d, 0], [-d, 0], [0, d], [0, -d]].map(([a, b]) => Math.round((alt(site!.lon + a, site!.lat + b) ?? 0) * 2)).join(",") + `|${exag}`;
      if (cle === cleSol) return;
      cleSol = cle;
      coucheArbres.setSol(alt);
      coucheCanopee3D.setSol(alt);
      coucheBati3D.setSol(alt);
      coucheCourse.setAltitude(alt(site.lon, site.lat) ?? 0);
    }, 300);
  }
  /** Source réellement utilisée par le terrain et l'ombrage, d'après les tuiles fines reçues. */
  function majTexteRelief(): void {
    if (!etat.get("relief")!.actif) return;
    const { tuiles, lidar } = statsRelief;
    const part = tuiles ? lidar / tuiles : 0;
    const t =
      sourceAlt === "rgealti"
        ? "Terrain et ombrage : RGE ALTI 1 m."
        : !tuiles
          ? "Terrain et ombrage : LiDAR HD 50 cm (complété par le RGE ALTI hors couverture)."
          : part > 0.995
            ? "Terrain et ombrage : LiDAR HD 50 cm (grille de ≈ 0,9 m au zoom le plus fin)."
            : part > 0.005
              ? `Terrain et ombrage : LiDAR HD sur ${Math.round(part * 100)} % de la vue, complété par le RGE ALTI 1 m.`
              : "LiDAR HD pas encore publié ici : terrain et ombrage sur le RGE ALTI 1 m.";
    if (t !== texteRelief) etatCouche("relief", (texteRelief = t));
  }
  map.on("idle", () => {
    if (map.getTerrain()) poserSurSol();
    majCoupe3D();
    majTexteRelief();
  });
  root.querySelectorAll<HTMLButtonElement>("[data-exag]").forEach((b) =>
    b.addEventListener("click", async () => {
      exag = Number(b.dataset.exag) as typeof exag;
      root.querySelectorAll("[data-exag]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      await pret;
      majTerrain();
    }),
  );

  // --- Courbes de niveau -------------------------------------------------------------
  let demandeCourbes = 0;
  async function dessinerCourbes(): Promise<void> {
    if (!site || !etat.get("courbes")!.actif) return;
    const ctx = site;
    const n = ++demandeCourbes;
    etatCouche("courbes", "Calcul…");
    try {
      const demi = Math.min(1500, Math.max(400, (ctx.radiusM ?? 150) * 1.5));
      const c = await calculerCourbes(ctx.lat, ctx.lon, demi, pasCourbes, sourceAlt);
      if (n !== demandeCourbes || site !== ctx) return;
      (map.getSource("courbes") as maplibregl.GeoJSONSource).setData(c.geojson);
      const fr = (v: number) => v.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
      etatCouche(
        "courbes",
        c.geojson.features.length
          ? `Équidistance ${fr(c.equidistance)} m · altitudes de ${fr(c.min)} à ${fr(c.max)} m sur un carré de ${fr((2 * demi) / 1000)} km de côté · ` +
            (sourceAlt === "lidar"
              ? c.partLidar > 0.995
                ? `LiDAR HD, grille de ${fr(c.pasM)} m.`
                : c.partLidar > 0.005
                  ? `LiDAR HD sur ${Math.round(c.partLidar * 100)} % de l'emprise, complété par le RGE ALTI, grille de ${fr(c.pasM)} m.`
                  : "LiDAR HD pas encore publié ici : RGE ALTI."
              : `RGE ALTI, grille de ${fr(c.pasM)} m.`) +
            (c.manquantes ? ` Courbes incomplètes : ${c.manquantes} tuile(s) d'altitudes refusée(s) par l'IGN, réactiver la couche pour compléter.` : "")
          : "Pas d'altitude disponible ici.",
      );
    } catch {
      if (n === demandeCourbes) etatCouche("courbes", "Altitudes indisponibles (service de l'IGN). Réessayer en réactivant la couche.");
    }
  }
  root.querySelectorAll<HTMLButtonElement>("[data-courbes]").forEach((b) =>
    b.addEventListener("click", async () => {
      const v = b.dataset.courbes!;
      pasCourbes = (v === "auto" ? "auto" : Number(v)) as typeof pasCourbes;
      root.querySelectorAll("[data-courbes]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      await pret;
      void dessinerCourbes();
    }),
  );

  // Source des altitudes (terrain 3D, ombrage, courbes et coupes) : trois jeux de boutons, synchronisés.
  root.querySelectorAll<HTMLButtonElement>("[data-alt]").forEach((b) =>
    b.addEventListener("click", async () => {
      const avant = sourceAlt;
      sourceAlt = b.dataset.alt as SourceAlt;
      root.querySelectorAll("[data-alt]").forEach((x) => x.setAttribute("aria-pressed", String(x.getAttribute("data-alt") === sourceAlt)));
      await pret;
      if (sourceAlt !== avant) {
        // Terrain et ombrage rechargés depuis la nouvelle source ; arbres reposés sur le nouveau sol.
        statsRelief.tuiles = statsRelief.lidar = 0;
        texteRelief = "";
        for (const id of ["dem", "dem-ombrage"]) (map.getSource(id) as maplibregl.RasterDEMTileSource | undefined)?.setTiles([tuilesRelief(sourceAlt)]);
        cleSol = "";
        majTexteRelief();
      }
      void dessinerCourbes();
      if (profil) void tracerCoupe();
    }),
  );

  // --- Coupe de terrain ---------------------------------------------------------------
  const coupeBtn = q<HTMLButtonElement>(".at-coupe-btn");
  const coupeAide = q<HTMLElement>(".at-coupe-aide");
  const coupeEl = q<HTMLElement>(".at-coupe");
  const coupeProfil = q<HTMLElement>(".at-coupe-profil");
  const coupeBulle = q<HTMLElement>(".at-coupe-bulle");
  let trace: "aucun" | "A" | "B" = "aucun";
  /** Clic qui vient de poser un point de coupe : pas de fiche d'information pour lui. */
  let evtCoupe: Event | null = null;
  let ptA: [number, number] | null = null, ptB: [number, number] | null = null;
  let profil: Profil | null = null;
  let dessin: ReturnType<typeof dessinerProfil> | null = null;
  let exagCoupe: ExagCoupe = "auto";
  let batiCoupe = true;
  let sursolCoupe = true;
  let profondeurCoupe = 30;
  let hauteurProfil = 200;
  try {
    hauteurProfil = Math.max(140, Math.min(900, Number(localStorage.getItem("atelier:coupe-hauteur")) || 200));
  } catch {
    /* valeur par défaut */
  }
  let demandeCoupe = 0;
  const marqueur = (lettre: string) => {
    const el = document.createElement("div");
    el.className = "at-coupe-pt";
    el.textContent = lettre;
    const mk = new maplibregl.Marker({ element: el, draggable: true });
    mk.on("dragend", () => {
      const { lng, lat } = mk.getLngLat();
      if (lettre === "A") ptA = [lng, lat];
      else ptB = [lng, lat];
      void tracerCoupe();
    });
    return mk;
  };
  const mkA = marqueur("A"), mkB = marqueur("B");
  const frc = (v: number, dec = 1) => v.toLocaleString("fr-FR", { maximumFractionDigits: dec });
  const signe = (v: number, dec = 1) => `${v >= 0 ? "+" : "−"}${frc(Math.abs(v), dec)}`;

  function donneesCoupe(curseur?: [number, number]): GeoJSON.FeatureCollection {
    const f: GeoJSON.Feature[] = [];
    if (ptA && ptB) f.push({ type: "Feature", properties: { apercu: !profil }, geometry: { type: "LineString", coordinates: [ptA, ptB] } });
    if (profil) {
      const ok = profil.points.filter((p) => Number.isFinite(p.z));
      const zA = ok[0].z, zB = ok[ok.length - 1].z;
      // Comme sur le profil : pas d'étiquette collée à A ou à B.
      const loin = (q: { d: number }) => q.d > profil!.longueur * 0.08 && q.d < profil!.longueur * 0.92;
      if (loin(profil.haut) && profil.haut.z - Math.max(zA, zB) > 0.2) f.push({ type: "Feature", properties: { role: "haut", label: `▲ ${frc(profil.haut.z)} m` }, geometry: { type: "Point", coordinates: [profil.haut.lon, profil.haut.lat] } });
      if (loin(profil.bas) && Math.min(zA, zB) - profil.bas.z > 0.2) f.push({ type: "Feature", properties: { role: "bas", label: `▼ ${frc(profil.bas.z)} m` }, geometry: { type: "Point", coordinates: [profil.bas.lon, profil.bas.lat] } });
    }
    if (curseur) f.push({ type: "Feature", properties: { role: "curseur" }, geometry: { type: "Point", coordinates: curseur } });
    return { type: "FeatureCollection", features: f };
  }
  const majCarteCoupe = (curseur?: [number, number]) => (map.getSource("coupe") as maplibregl.GeoJSONSource | undefined)?.setData(donneesCoupe(curseur));

  function placerPanneauCoupe(): void {
    // Au-dessus du panneau du soleil quand il est ouvert.
    coupeEl.style.bottom = soleilPanel.hidden ? "" : `${soleilPanel.offsetHeight + 46}px`;
  }
  new MutationObserver(placerPanneauCoupe).observe(soleilPanel, { attributes: true, attributeFilter: ["hidden"] });

  function commencerCoupe(): void {
    fermerCoupe();
    trace = "A";
    coupeBtn.setAttribute("aria-pressed", "true");
    coupeAide.hidden = false;
    coupeAide.firstChild!.textContent = "Cliquez le point A ";
    map.getCanvas().style.cursor = "crosshair";
  }
  /** Plan de coupe dressé en 3D, posé sur le terrain affiché (re-posé quand le relief change). */
  let cleCoupe3D = "";
  function majCoupe3D(forcer = false): void {
    const visible = !!profil && mode3d && !coupeEl.hidden;
    if (map.getLayer("coupe-3d")) map.setLayoutProperty("coupe-3d", "visibility", visible ? "visible" : "none");
    if (!visible || !profil) {
      if (cleCoupe3D) coucheCoupe3D.setCoupe(null);
      cleCoupe3D = "";
      return;
    }
    const p = profil;
    const n = Math.min(240, p.points.length);
    const relief = !!map.getTerrain();
    const pts = Array.from({ length: n }, (_, k) => {
      const q = p.points[Math.round((k * (p.points.length - 1)) / (n - 1))];
      return { lon: q.lon, lat: q.lat, d: q.d, sol: relief ? (map.queryTerrainElevation([q.lon, q.lat]) ?? 0) : 0 };
    });
    const cle = `${p.a}|${p.b}|${batiCoupe}|${pts.filter((_, k) => k % 30 === 0).map((x) => Math.round(x.sol * 2)).join(",")}`;
    if (!forcer && cle === cleCoupe3D) return; // évite la boucle « idle » → redessin → « idle »
    cleCoupe3D = cle;
    const brut = p.longueur / 8;
    const puiss = 10 ** Math.floor(Math.log10(brut));
    const pasR = [1, 2, 2.5, 5, 10].map((m) => m * puiss).find((v) => v >= brut) ?? 10 * puiss;
    coucheCoupe3D.setCoupe({ points: pts, longueur: p.longueur, batiments: batiCoupe ? p.batiments.map((b) => ({ d0: b.d0, d1: b.d1, h: b.h })) : [], pas: pasR });
  }

  function fermerCoupe(): void {
    trace = "aucun";
    ptA = ptB = null;
    profil = dessin = null;
    demandeCoupe++;
    mkA.remove();
    mkB.remove();
    coupeEl.hidden = true;
    majCoupe3D();
    coupeAide.hidden = true;
    coupeBtn.setAttribute("aria-pressed", "false");
    map.getCanvas().style.cursor = "";
    majCarteCoupe();
  }
  coupeBtn.addEventListener("click", () => (trace !== "aucun" || profil || ptA ? fermerCoupe() : commencerCoupe()));
  q<HTMLButtonElement>("[data-coupe-nouvelle]").addEventListener("click", commencerCoupe);
  q<HTMLButtonElement>("[data-coupe-fermer]").addEventListener("click", fermerCoupe);
  q<HTMLButtonElement>("[data-coupe-reduire]").addEventListener("click", (ev) => {
    const reduite = coupeEl.classList.toggle("reduite");
    const b = ev.currentTarget as HTMLButtonElement;
    b.textContent = reduite ? "+" : "–";
    b.setAttribute("aria-expanded", String(!reduite));
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && trace !== "aucun") fermerCoupe();
  });
  map.on("click", (ev) => {
    if (choixParcelles && trace === "aucun") {
      choixParcelles(ev.lngLat.lat, ev.lngLat.lng);
      return;
    }
    if (trace !== "aucun") evtCoupe = ev.originalEvent;
    if (trace === "A") {
      ptA = [ev.lngLat.lng, ev.lngLat.lat];
      mkA.setLngLat(ptA).addTo(map);
      trace = "B";
      coupeAide.firstChild!.textContent = "Cliquez le point B ";
    } else if (trace === "B") {
      ptB = [ev.lngLat.lng, ev.lngLat.lat];
      if (distanceM(ptA!, ptB) < 2) return;
      mkB.setLngLat(ptB).addTo(map);
      trace = "aucun";
      coupeAide.hidden = true;
      map.getCanvas().style.cursor = "";
      void tracerCoupe();
    }
  });
  map.on("mousemove", (ev) => {
    if (trace !== "B" || !ptA) return;
    ptB = [ev.lngLat.lng, ev.lngLat.lat];
    majCarteCoupe();
  });

  async function tracerCoupe(): Promise<void> {
    if (!ptA || !ptB) return;
    const n = ++demandeCoupe;
    profil = null;
    majCarteCoupe();
    coupeEl.hidden = false;
    placerPanneauCoupe();
    q<HTMLElement>(".at-coupe-chiffres").innerHTML = `<span class="at-note">Lecture des altitudes…</span>`;
    coupeProfil.querySelector("svg")?.remove();
    try {
      // Bâtiments : ceux du périmètre, chargés au besoin.
      if (!dernierBati && site) void chargerCouche("bati");
      if (!derniersArbres && site) void chargerCouche("arbres");
      const p = await calculerProfil(ptA, ptB, sourceAlt, dernierBati);
      if (n !== demandeCoupe) return;
      profil = p;
      afficherCoupe();
      majCarteCoupe();
      majCoupe3D(true);
    } catch (e) {
      if (n !== demandeCoupe) return;
      q<HTMLElement>(".at-coupe-chiffres").innerHTML = `<span class="at-note">${esc(e instanceof Error && e.message === "Coupe trop courte" ? "Coupe trop courte." : "Altitudes indisponibles (service de l'IGN). Déplacez un point pour réessayer.")}</span>`;
    }
  }
  function afficherCoupe(): void {
    if (!profil) return;
    const p = profil;
    const chiffre = (titre: string, valeur: string, detail = "") => `<div><span>${titre}</span><b>${valeur}</b>${detail ? `<i>${detail}</i>` : ""}</div>`;
    const ok = p.points.filter((x) => Number.isFinite(x.z));
    q<HTMLElement>(".at-coupe-chiffres").innerHTML = [
      chiffre("Longueur", p.longueur >= 1000 ? `${frc(p.longueur / 1000, 2)} km` : `${frc(p.longueur, 0)} m`),
      chiffre("Dénivelé A → B", `${signe(p.denivele)} m`, `${frc(ok[0].z)} → ${frc(ok[ok.length - 1].z)} m`),
      chiffre("Montée · descente", `${signe(p.montee, 0)} · ${signe(-p.descente, 0)} m`, "cumulées"),
      chiffre("Pente moyenne", `${signe(p.penteMoy)} %`),
      chiffre("Pente max", `${frc(p.penteMax.pct)} %`, `à ${frc(p.penteMax.d, 0)} m de A`),
      chiffre("Point haut · bas", `${frc(p.haut.z)} · ${frc(p.bas.z)} m`, `écart ${frc(p.haut.z - p.bas.z)} m`),
    ].join("");
    const lidarTxt =
      p.source === "rgealti"
        ? "RGE ALTI® (IGN, 1 m)"
        : p.partLidar > 0.995
          ? "LiDAR HD (IGN, MNT 50 cm)"
          : p.partLidar > 0.005
            ? `LiDAR HD sur ${Math.round(p.partLidar * 100)} % du tracé, complété par le RGE ALTI®`
            : "LiDAR HD pas encore publié ici : RGE ALTI® (1 m)";
    const nb = p.batiments.length;
    q<HTMLElement>(".at-coupe-source").textContent =
      `Altitudes : ${lidarTxt}, un point tous les ${frc(p.pas, 2)} m. ` +
      (batiCoupe
        ? dernierBati
          ? `${nb} bâtiment${nb > 1 ? "s" : ""} coupé${nb > 1 ? "s" : ""} (BD TOPO®, hauteur depuis le point bas du terrain ; pointillés : hauteur supposée). Bâti chargé dans le périmètre d'analyse seulement.`
          : "Bâti : activez la couche Bâtiments (périmètre d'analyse)."
        : "") +
      (sursolCoupe && p.source === "lidar"
        ? p.sursol
          ? " Vert : sursol LiDAR HD (MNS) de plus de 2 m hors bâti coupé, surtout la végétation haute."
          : " Sursol LiDAR pas encore publié ici."
        : "") +
      (profondeurCoupe
        ? ` Au-delà du plan (${profondeurCoupe} m, estompés avec la distance) : bâti BD TOPO® du périmètre${derniersArbres ? ", arbres OpenStreetMap (pointillés : taille supposée)" : ""}.`
        : "") +
      (p.manquantes ? ` ${p.manquantes} tuile(s) d'altitudes refusée(s) : profil incomplet.` : "");
    // Sens du regard : à gauche de A → B.
    const cosA = Math.cos((p.a[1] * Math.PI) / 180);
    const az = (Math.atan2((p.b[0] - p.a[0]) * cosA, p.b[1] - p.a[1]) * 180) / Math.PI;
    const regard = (((az - 90) % 360) + 360) % 360;
    const DIRS = ["le nord", "le nord-est", "l'est", "le sud-est", "le sud", "le sud-ouest", "l'ouest", "le nord-ouest"];
    q<HTMLElement>(".at-coupe-regard").textContent = `Regard vers ${DIRS[Math.round(regard / 45) % 8]}`;
    redessinerProfil();
  }
  function redessinerProfil(): void {
    if (!profil) return;
    const W = Math.max(320, coupeProfil.clientWidth), H = hauteurProfil;
    dessin = dessinerProfil(profil, W, H, optionsDessin(), COULEURS_ECRAN);
    coupeProfil.querySelector("svg")?.remove();
    coupeProfil.insertAdjacentHTML("afterbegin", dessin.svg);
  }
  function optionsDessin() {
    const arriere = profil && (profondeurCoupe || derniersArbres) ? vuAuDela(profil, profondeurCoupe, dernierBati, derniersArbres?.arbres) : null;
    return { exag: exagCoupe, bati: batiCoupe, sursol: sursolCoupe, arriere };
  }
  new ResizeObserver(() => redessinerProfil()).observe(coupeProfil);
  // Hauteur du profil : poignée en haut du panneau (retenue).
  coupeProfil.style.height = `${hauteurProfil}px`;
  q<HTMLElement>(".at-coupe-poignee").addEventListener("pointerdown", (ev) => {
    const poignee = ev.currentTarget as HTMLElement;
    poignee.setPointerCapture(ev.pointerId);
    const y0 = ev.clientY, h0 = hauteurProfil;
    const max = Math.max(200, (canvasEl.parentElement?.clientHeight ?? 800) * 0.75 - 140);
    const bouger = (e: PointerEvent) => {
      hauteurProfil = Math.round(Math.max(140, Math.min(max, h0 + (y0 - e.clientY))));
      coupeProfil.style.height = `${hauteurProfil}px`;
    };
    const finir = () => {
      poignee.removeEventListener("pointermove", bouger);
      try {
        localStorage.setItem("atelier:coupe-hauteur", String(hauteurProfil));
      } catch {
        /* rien */
      }
    };
    poignee.addEventListener("pointermove", bouger);
    poignee.addEventListener("pointerup", finir, { once: true });
  });
  coupeProfil.addEventListener("mousemove", (ev) => {
    if (!profil || !dessin) return;
    const r = coupeProfil.getBoundingClientRect();
    const d = dessin.xVersD(ev.clientX - r.left);
    if (d < 0 || d > profil.longueur) {
      coupeBulle.hidden = true;
      majCarteCoupe();
      return;
    }
    const pt = profil.points[Math.min(profil.points.length - 1, Math.round(d / profil.pas))];
    if (!Number.isFinite(pt.z)) return;
    const pente = penteEn(profil, pt.d);
    coupeBulle.hidden = false;
    coupeBulle.innerHTML = `<b>${frc(pt.z)} m</b> · à ${frc(pt.d, 0)} m de A${Number.isFinite(pente) ? ` · pente ${signe(pente)} %` : ""}`;
    const x = dessin.dVersX(pt.d);
    coupeBulle.style.left = `${Math.min(r.width - coupeBulle.offsetWidth - 4, Math.max(4, x - coupeBulle.offsetWidth / 2))}px`;
    coupeBulle.style.top = `${Math.max(2, dessin.zVersY(pt.z) - 34)}px`;
    coupeProfil.style.setProperty("--curseur", `${x}px`);
    coupeProfil.classList.add("survol");
    majCarteCoupe([pt.lon, pt.lat]);
  });
  coupeProfil.addEventListener("mouseleave", () => {
    coupeBulle.hidden = true;
    coupeProfil.classList.remove("survol");
    majCarteCoupe();
  });
  root.querySelectorAll<HTMLButtonElement>("[data-coupe-exag]").forEach((b) =>
    b.addEventListener("click", () => {
      const v = b.dataset.coupeExag!;
      exagCoupe = (v === "auto" ? "auto" : Number(v)) as ExagCoupe;
      root.querySelectorAll("[data-coupe-exag]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      redessinerProfil();
    }),
  );
  q<HTMLInputElement>("[data-coupe-sursol]").addEventListener("change", (ev) => {
    sursolCoupe = (ev.target as HTMLInputElement).checked;
    afficherCoupe();
  });
  root.querySelectorAll<HTMLButtonElement>("[data-coupe-prof]").forEach((b) =>
    b.addEventListener("click", () => {
      profondeurCoupe = Number(b.dataset.coupeProf);
      root.querySelectorAll("[data-coupe-prof]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      afficherCoupe();
    }),
  );
  q<HTMLButtonElement>("[data-coupe-inverser]").addEventListener("click", () => {
    if (!ptA || !ptB) return;
    [ptA, ptB] = [ptB, ptA];
    mkA.setLngLat(ptA);
    mkB.setLngLat(ptB);
    void tracerCoupe();
  });
  q<HTMLInputElement>("[data-coupe-bati]").addEventListener("change", (ev) => {
    batiCoupe = (ev.target as HTMLInputElement).checked;
    majCoupe3D(true);
    afficherCoupe();
  });
  const telecharger = (blob: Blob, nom: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = nom;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  root.querySelectorAll<HTMLButtonElement>("[data-coupe-export]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!profil) return;
      const nom = `coupe-${today()}`;
      if (b.dataset.coupeExport === "csv") telecharger(new Blob(["﻿" + profilCsv(profil)], { type: "text/csv" }), `${nom}.csv`);
      else telecharger(new Blob([dessinerProfil(profil, 1400, Math.round(1400 * (hauteurProfil / Math.max(320, coupeProfil.clientWidth))), optionsDessin(), COULEURS_EXPORT).svg], { type: "image/svg+xml" }), `${nom}.svg`);
    }),
  );

  // --- Isochrones à pied ----------------------------------------------------------------
  let isoPour: SiteContext | null = null;
  async function dessinerIsochrones(): Promise<void> {
    if (!site || !etat.get("isochrones")!.actif || isoPour === site) return;
    const ctx = site;
    isoPour = ctx;
    etatCouche("isochrones", "Calcul des itinéraires…");
    try {
      const r = await calculerIsochrones(ctx.lat, ctx.lon);
      if (site !== ctx) return;
      (map.getSource("isochrones") as maplibregl.GeoJSONSource).setData(r.geojson);
      const fr = (v: number) => v.toLocaleString("fr-FR");
      const parts = DUREES_MIN.map((m) =>
        r.surfaces[m] != null ? `<i style="background:${COULEURS_ISO[m]}"></i>${m} min : ${fr(r.surfaces[m]!)} ha` : `${m} min : non calculé`,
      );
      const p = root.querySelector<HTMLElement>('[data-couche="isochrones"] .at-etat');
      if (p) {
        p.innerHTML = `<span class="at-legende">${parts.map((x) => `<span>${x}</span>`).join("")}</span>Surface atteinte à pied depuis le site.`;
        p.hidden = false;
      }
    } catch {
      isoPour = null;
      if (site === ctx) etatCouche("isochrones", "Service d'itinéraire de l'IGN indisponible. Réessayer en réactivant la couche.");
    }
  }

  // --- Ville du quart d'heure : équipements dans les isochrones --------------------------
  let equipPour: SiteContext | null = null;
  async function dessinerEquipements(): Promise<void> {
    if (!site || !etat.get("equipements")!.actif || equipPour === site) return;
    const ctx = site;
    equipPour = ctx;
    const p = root.querySelector<HTMLElement>('[data-couche="equipements"] .at-etat');
    etatCouche("equipements", "Calcul des isochrones et recensement des équipements…");
    try {
      const iso = await calculerIsochrones(ctx.lat, ctx.lon);
      const r = await recenserEquipements(iso.geojson);
      if (site !== ctx) return;
      (map.getSource("equipements") as maplibregl.GeoJSONSource).setData(r.geojson);
      const presentes = FONCTIONS.filter((f) => r.comptes[f.id][15] > 0).length;
      const a10 = FONCTIONS.filter((f) => r.comptes[f.id][10] > 0).length;
      const lignes = FONCTIONS.map((f) => {
        const c = r.comptes[f.id];
        return `<tr><th><i style="background:${f.couleur}"></i>${f.titre}</th><td>${c[5]}</td><td>${c[10]}</td><td>${c[15]}</td></tr>`;
      }).join("");
      if (p) {
        p.innerHTML =
          `<strong>${presentes} fonction${presentes > 1 ? "s" : ""} sur 6</strong> à moins de 15 min à pied, ${a10} à moins de 10 min.` +
          `<table class="at-quart"><thead><tr><th></th><th>5 min</th><th>10 min</th><th>15 min</th></tr></thead><tbody>${lignes}</tbody></table>` +
          `Nombre d'équipements recensés (cumulé).` +
          (r.manques.includes("OSM") ? ` <strong>OpenStreetMap n'a pas répondu</strong> : commerces, pharmacies, médecins, aires de jeux et arrêts manquent ; réactiver la couche plus tard.` : "") +
          (r.manques.includes("IGN") ? ` <strong>La BD TOPO n'a pas répondu</strong> : écoles, santé, sport, culture, mairies et postes manquent ; réactiver la couche plus tard.` : "");
        p.hidden = false;
      }
    } catch {
      equipPour = null;
      if (site === ctx) etatCouche("equipements", "Isochrones ou OpenStreetMap indisponibles. Réessayer en réactivant la couche.");
    }
  }
  map.on("click", "equipements", (ev) => {
      if (choixParcelles || trace !== "aucun" || ev.originalEvent === evtCoupe) return; // tracé d'une coupe en cours
    const f = ev.features?.[0];
    if (!f) return;
    const pr = f.properties as { nom: string; titre: string; minutes: number };
    new maplibregl.Popup({ closeButton: false, maxWidth: "240px" })
      .setLngLat(ev.lngLat)
      .setHTML(`<strong>${pr.nom ? pr.nom.replace(/[<>&]/g, "") : "Sans nom"}</strong><br>${pr.titre} · moins de ${pr.minutes} min à pied<br><small>${(f.properties as { source: string }).source}</small>`)
      .addTo(map);
  });
  map.on("mouseenter", "equipements", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "equipements", () => (map.getCanvas().style.cursor = ""));

  // --- Patrimoine (servitudes AC1, AC2, AC4 du GPU) -----------------------------------
  let patrimoinePour: SiteContext | null = null;
  async function dessinerPatrimoine(): Promise<void> {
    if (!site || patrimoinePour === site) return;
    const ctx = site;
    patrimoinePour = ctx;
    const ids = ["patrimoine-mh", "patrimoine-sites", "patrimoine-spr"];
    ids.forEach((c) => etatCouche(c, "Chargement…"));
    try {
      const demi = Math.min(2000, Math.max(800, (ctx.radiusM ?? 150) + 600));
      const r = await fetchPatrimoine(ctx.lat, ctx.lon, demi);
      if (site !== ctx) return;
      (map.getSource("patrimoine") as maplibregl.GeoJSONSource).setData(r.geojson);
      const n = (g: string) => r.geojson.features.filter((f) => f.properties?.genre === g).length;
      const km = (demi * 2) / 1000;
      const zone = `sur un carré de ${km.toLocaleString("fr-FR")} km de côté`;
      etatCouche(
        "patrimoine-mh",
        n("mh")
          ? `${n("mh")} monument(s) historique(s) ${zone}` + (r.plusProche ? `, le plus proche à ${r.plusProche.distanceM} m (${r.plusProche.nom}).` : ".")
          : `Aucun monument historique publié ${zone} (publication sur le GPU encore incomplète).`,
      );
      etatCouche("patrimoine-sites", n("site") ? `${n("site")} site(s) ${zone}.` : `Aucun site classé ou inscrit publié ${zone}.`);
      etatCouche("patrimoine-spr", n("spr") ? `${n("spr")} périmètre(s) ${zone}.` : `Aucun site patrimonial remarquable publié ${zone}.`);
    } catch {
      patrimoinePour = null;
      if (site === ctx) ids.forEach((c) => etatCouche(c, "Géoportail de l'Urbanisme indisponible. Réessayer en réactivant la couche."));
    }
  }
  for (const lid of ["patrimoine-mh", "patrimoine-abords", "patrimoine-sites", "patrimoine-spr"]) {
    map.on("click", lid, (ev) => {
      if (choixParcelles || trace !== "aucun" || ev.originalEvent === evtCoupe) return; // tracé d'une coupe en cours
      const f = ev.features?.[0];
      if (!f) return;
      const pr = f.properties as { nom: string; titre: string; type: string };
      const esc = (t: string) => t.replace(/[<>&]/g, "");
      new maplibregl.Popup({ closeButton: false, maxWidth: "260px" })
        .setLngLat(ev.lngLat)
        .setHTML(`<strong>${esc(pr.nom || "Sans nom")}</strong><br>${esc(pr.titre)}${pr.type && pr.type !== pr.titre ? ` · ${esc(pr.type)}` : ""}<br><small>Géoportail de l'Urbanisme</small>`)
        .addTo(map);
    });
  }

  // --- Carroyage Lambert-93 ----------------------------------------------------------
  function dessinerCarroyage(): void {
    if (!site) return;
    const demi = Math.max(600, (site.radiusM ?? 150) * 3);
    (map.getSource("carroyage") as maplibregl.GeoJSONSource).setData(carroyage(site.lat, site.lon, demi, pas));
  }

  // --- Ombres (worker) ------------------------------------------------------------
  const worker = new Worker(new URL("../map3d/shadow-worker.ts", import.meta.url), { type: "module" });
  let site: SiteContext | null = null;
  let demande = 0;
  let enCours = false;
  let enAttente = false;
  let batimentsEnvoyes = false;

  function soleil() {
    if (!site) return null;
    const h = Number(hourInput.value);
    const sun = sunAtLegalTime(site.lat, site.lon, dateInput.value || today(), h);
    coucheCourse.setMoment(dateInput.value || today(), h);
    const tz = sun.utcOffset === 2 ? "heure d'été" : "heure d'hiver";
    const nuit = sun.elevationDeg <= 0.5;
    const l10 = nuit ? 0 : Math.min(10 / Math.tan((sun.elevationDeg * Math.PI) / 180), MAX_SHADOW_M);
    sunInfo.innerHTML = nuit
      ? `<strong>${formatHour(h)}</strong> (${tz}) — soleil sous l'horizon`
      : `<strong>${formatHour(h)}</strong> (${tz}) · soleil à ${sun.elevationDeg.toFixed(0)}° de hauteur,
         azimut ${sun.azimuthDeg.toFixed(0)}° · un bâtiment de 10 m porte ${l10.toFixed(0)} m d'ombre`;
    return sun;
  }
  /**
   * Lumière de la carte calée sur le soleil (ombres actives) : les façades
   * éclairées suivent l'heure et la saison, lumière chaude et rasante au lever,
   * au coucher et en hiver, sombre la nuit. null : éclairage neutre par défaut.
   */
  /**
   * Lumière de la carte calée sur le soleil (ombres actives) : la direction
   * suit toujours le soleil (faces éclairées / à l'ombre). La teinte chaude du
   * soleil bas ne s'applique qu'en coloration « Neutre » : avec Hauteur ou
   * Usage, la lumière reste blanche pour ne pas fausser les couleurs de la
   * légende. Réglages choisis à l'œil dans le Chrome de Cédric le 13/11.
   */
  let dernierSoleil: { azimuthDeg: number; elevationDeg: number } | null = null;
  function eclairer(sun: { azimuthDeg: number; elevationDeg: number } | null): void {
    dernierSoleil = sun;
    if (!sun) {
      map.setLight({ anchor: "viewport", position: [1.15, 210, 30], color: "#ffffff", intensity: 0.5 });
      coucheArbres.setSoleil(null);
      coucheCanopee3D.setSoleil(null);
      coucheBati3D.setSoleil(null);
      return;
    }
    const neutre = coloration === "neutre";
    const el = sun.elevationDeg;
    if (el <= 0.5) {
      map.setLight({ anchor: "map", position: [1.5, sun.azimuthDeg, 80], color: neutre ? "#8a93b8" : "#ffffff", intensity: neutre ? 0.45 : 0.3 });
      coucheArbres.setSoleil({ azimut: sun.azimuthDeg, hauteur: 0, couleur: 0x8a93b8, intensite: 0 });
      coucheCanopee3D.setSoleil({ azimut: sun.azimuthDeg, hauteur: 0, couleur: 0x8a93b8, intensite: 0 });
      coucheBati3D.setSoleil({ azimut: sun.azimuthDeg, hauteur: 0, couleur: 0x8a93b8, intensite: 0 });
      return;
    }
    const t = Math.min(1, el / 45); // 0 : soleil rasant, 1 : soleil haut
    // Teinte douce : orangé clair au soleil rasant, presque blanc au soleil haut.
    const g = Math.round(214 + 30 * t);
    const b = Math.round(170 + 68 * t);
    const hex = (255 << 16) | (g << 8) | b;
    map.setLight({
      anchor: "map",
      position: [1.5, sun.azimuthDeg, Math.max(5, 90 - el)],
      color: neutre ? `#${hex.toString(16).padStart(6, "0")}` : "#ffffff",
      intensity: neutre ? 0.72 + 0.13 * t : 0.6,
    });
    coucheArbres.setSoleil({ azimut: sun.azimuthDeg, hauteur: el, couleur: hex, intensite: t });
    coucheCanopee3D.setSoleil({ azimut: sun.azimuthDeg, hauteur: el, couleur: hex, intensite: t });
    coucheBati3D.setSoleil({ azimut: sun.azimuthDeg, hauteur: el, couleur: hex, intensite: t });
  }

  function demanderOmbres(): void {
    const actif = etat.get("ombres")!.actif;
    const s0 = soleil();
    if (actif && s0) {
      eclairer(s0);
      (map.getSource("ombres-arbres") as maplibregl.GeoJSONSource | undefined)?.setData(
        ombresArbres(derniersArbres?.arbres ?? [], s0.azimuthDeg, s0.elevationDeg),
      );
    }
    if (!actif || !batimentsEnvoyes) return;
    const sun = s0;
    if (!sun) return;
    if (enCours) {
      enAttente = true;
      return;
    }
    enCours = true;
    worker.postMessage({ kind: "compute", id: ++demande, elevationDeg: sun.elevationDeg, azimuthDeg: sun.azimuthDeg } satisfies ShadowRequest);
  }
  worker.onmessage = (e: MessageEvent<ShadowResponse>) => {
    if (!("result" in e.data)) return;
    enCours = false;
    if (e.data.id === demande) {
      (map.getSource("ombres") as maplibregl.GeoJSONSource).setData({
        type: "Feature",
        properties: {},
        geometry: { type: "MultiPolygon", coordinates: e.data.result.multiPolygon },
      });
    }
    if (enAttente) {
      enAttente = false;
      demanderOmbres();
    }
  };
  // --- Heures de soleil au sol (second worker : le curseur d'heure reste fluide) ---
  const workerCumul = new Worker(new URL("../map3d/shadow-worker.ts", import.meta.url), { type: "module" });
  let demandeCumul = 0;
  let minuterieCumul = 0;
  function demanderCumul(): void {
    if (!site || !batimentsEnvoyes || !etat.get("ensoleillement")!.actif) return;
    clearTimeout(minuterieCumul);
    minuterieCumul = window.setTimeout(() => {
      if (!site) return;
      const jour = dateInput.value || today();
      const pas: PasSoleil[] = [];
      for (let h = 3; h <= 23; h += 0.25) {
        const s = sunAtLegalTime(site.lat, site.lon, jour, h + 0.125);
        if (s.elevationDeg > 0.5) pas.push({ azimuthDeg: s.azimuthDeg, elevationDeg: s.elevationDeg, dureeH: 0.25 });
      }
      etatCouche("ensoleillement", "Calcul…");
      workerCumul.postMessage({ kind: "cumul", id: ++demandeCumul, rayonM: Math.min(site.radiusM ?? 150, 500), pas } satisfies ShadowRequest);
    }, 250);
  }
  workerCumul.onmessage = (e: MessageEvent<ShadowResponse>) => {
    if (!("cumul" in e.data) || e.data.id !== demandeCumul || !site) return;
    afficherEnsoleillement(e.data.cumul, site);
  };
  function afficherEnsoleillement(c: CarteEnsoleillement, ctx: SiteContext): void {
    const toile = document.createElement("canvas");
    toile.width = c.nx;
    toile.height = c.ny;
    const g = toile.getContext("2d")!;
    const img = g.createImageData(c.nx, c.ny);
    const rgb = CLASSES_SOLEIL.map((k) => [1, 3, 5].map((o) => parseInt(k.couleur.slice(o, o + 2), 16)));
    let libre = 0, moins2 = 0, plus2 = 0;
    for (let i = 0; i < c.heures.length; i++) {
      const h = c.heures[i];
      if (Number.isNaN(h)) continue;
      libre++;
      if (h < 2) moins2++;
      else plus2++;
      const k = CLASSES_SOLEIL.findIndex((cl) => h < cl.max);
      const [r, v, b] = rgb[k < 0 ? rgb.length - 1 : k];
      img.data.set([r, v, b, 255], i * 4);
    }
    g.putImageData(img, 0, 0);
    const mLon = 111_320 * Math.cos((ctx.lat * Math.PI) / 180);
    const coin = (x: number, y: number): [number, number] => [ctx.lon + x / mLon, ctx.lat + y / 110_540];
    const d = c.demiCote;
    const coords: [[number, number], [number, number], [number, number], [number, number]] = [coin(-d, d), coin(d, d), coin(d, -d), coin(-d, -d)];
    const src = map.getSource("ensoleillement") as maplibregl.ImageSource | undefined;
    if (src) src.updateImage({ url: toile.toDataURL(), coordinates: coords });
    else {
      map.addSource("ensoleillement", { type: "image", url: toile.toDataURL(), coordinates: coords });
      map.addLayer({ id: "ensoleillement", type: "raster", source: "ensoleillement", paint: { "raster-opacity": etat.get("ensoleillement")!.opacite, "raster-resampling": "nearest", "raster-fade-duration": 0 } }, "cadastre");
      appliquer("ensoleillement");
    }
    const jour = new Date(`${dateInput.value || today()}T12:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
    const pct = (n: number) => (libre ? Math.round((n / libre) * 100) : 0);
    etatCouche(
      "ensoleillement",
      `Le ${jour} (jour de ${c.jourH.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} h) : ${pct(plus2)} % du sol libre du périmètre reçoit au moins 2 h de soleil, ${pct(moins2)} % moins de 2 h. Repère : le guide britannique BRE 209 vise au moins 2 h de soleil le 21 mars sur la moitié d'un espace extérieur.`,
    );
  }

  hourInput.addEventListener("input", demanderOmbres);
  dateInput.addEventListener("change", demanderOmbres);
  dateInput.addEventListener("change", demanderCumul);
  root.querySelectorAll<HTMLButtonElement>(".m3d-presets button").forEach((b) =>
    b.addEventListener("click", () => {
      dateInput.value = `${(dateInput.value || today()).slice(0, 4)}-${b.dataset.md}`;
      demanderOmbres();
      demanderCumul();
    }),
  );

  // --- Données dépendant du site ---------------------------------------------------
  const charge = new Set<string>();
  function etatCouche(id: string, texte: string): void {
    const p = root.querySelector<HTMLElement>(`[data-couche="${id}"] .at-etat`);
    if (!p) return;
    p.hidden = !texte;
    p.textContent = texte;
  }

  async function chargerCouche(id: string): Promise<void> {
    if (!site || charge.has(id)) return;
    const ctx = site;
    const r = ctx.radiusM ?? 150;
    charge.add(id);
    try {
      if (id === "bati") {
        etatCouche(id, "Chargement…");
        const data = await fetchBuildingsWithHeight(ctx, r);
        if (site !== ctx) return;
        dernierBati = batiGeoJSON(data);
        dernierBatiData = data;
        if (etat.get("bati")!.actif && mode3d && batiRendu !== "extrude") void chargerBatiLidar();
        (map.getSource("bati") as maplibregl.GeoJSONSource).setData(dernierBati);
        if (profil) void tracerCoupe();
        const connues = data.buildings.filter((b) => b.heightM !== null).length;
        q<HTMLElement>("[data-bati-source]").textContent =
          data.source === "indisponible"
            ? "Bâtiments indisponibles (BD TOPO et OpenStreetMap n'ont pas répondu)."
            : `${data.buildings.length} bâtiments · ${BUILDING_SOURCE_LABEL[data.source]} · hauteur connue pour ${
                data.buildings.length ? Math.round((connues / data.buildings.length) * 100) : 0
              } %`;
        etatCouche(id, "");
        if (data.source === "indisponible") charge.delete(id);
        const sb: ShadowBuilding[] = data.buildings.map((b) => ({ ring: b.polygon.map((p) => [p.lon, p.lat] as [number, number]), heightM: b.heightM }));
        worker.postMessage({ kind: "buildings", buildings: sb, lat0: ctx.lat, lon0: ctx.lon } satisfies ShadowRequest);
        workerCumul.postMessage({ kind: "buildings", buildings: sb, lat0: ctx.lat, lon0: ctx.lon } satisfies ShadowRequest);
        batimentsEnvoyes = true;
        demanderOmbres();
        demanderCumul();
      } else if (id === "ombres") {
        await chargerCouche("bati");
        demanderOmbres();
      } else if (id === "arbres") {
        etatCouche(id, sourceArbres === "lidar" ? "Détection des arbres dans le LiDAR HD…" : "Chargement…");
        let arbres: ArbreOsm[];
        let texte: string;
        const fr = (v: number) => v.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
        if (sourceArbres === "lidar") {
          try {
            const c = await canopeePour(ctx);
            if (!c.arbresDetectes) throw new Error("cercle trop grand");
            arbres = c.arbres;
            texte = `${arbres.length} arbres détectés dans le LiDAR HD (${fr(c.densiteHa)} / ha), hauteur et houppier mesurés.` + (c.couverturePct < 95 ? ` LiDAR ou CoSIA sur ${fr(c.couverturePct)} % du cercle seulement.` : "");
          } catch {
            arbres = await fetchTrees(ctx, r);
            texte = `Arbres LiDAR non détectés (LiDAR HD pas encore publié, service muet, ou cercle de plus de 1,1 km : canopée seule) : ${arbres.length} arbres OpenStreetMap.`;
          }
        } else {
          arbres = await fetchTrees(ctx, r);
          texte = arbres.length ? `${arbres.length} arbres recensés dans OpenStreetMap.` : "Aucun arbre recensé dans OpenStreetMap ici (inventaire souvent incomplet).";
        }
        if (site !== ctx) return;
        (map.getSource("arbres") as maplibregl.GeoJSONSource).setData({
          type: "FeatureCollection",
          features: arbres.map((a) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [a.lon, a.lat] } })),
        });
        arbresBruts = { arbres, lat0: ctx.lat, lon0: ctx.lon };
        poserArbres();
        if (arbres.length > MAX_ARBRES)
          texte += ` Volumes 3D limités aux ${MAX_ARBRES.toLocaleString("fr-FR")} arbres les plus proches du centre (ombres et canopée : tous les arbres).`;
        etatCouche(id, texte);
        if (rendu === "canopee") void chargerCanopee3D();
      } else if (id === "canopee") {
        etatCouche(id, "Lecture du LiDAR HD et de CoSIA…");
        const c = await canopeePour(ctx);
        if (site !== ctx) return;
        const toile = document.createElement("canvas");
        toile.width = c.image.largeur;
        toile.height = c.image.hauteur;
        toile.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(c.image.rgba), c.image.largeur, c.image.hauteur), 0, 0);
        const [o, su, e, n] = c.image.emprise;
        const coords: [[number, number], [number, number], [number, number], [number, number]] = [[o, n], [e, n], [e, su], [o, su]];
        const url = toile.toDataURL("image/png");
        const src = map.getSource("canopee") as maplibregl.ImageSource | undefined;
        if (src) src.updateImage({ url, coordinates: coords });
        else {
          map.addSource("canopee", { type: "image", url, coordinates: coords });
          map.addLayer({ id: "canopee", type: "raster", source: "canopee", paint: { "raster-opacity": etat.get("canopee")!.opacite, "raster-resampling": "nearest" } }, "arbres");
        }
        appliquer("canopee");
        const fr = (v: number) => v.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
        etatCouche(
          id,
          `Canopée ${fr(c.canopeePct)} % du cercle de ${c.rayonM} m · hauteur moyenne ${fr(c.hMoy)} m, 90 % sous ${fr(c.hP90)} m · ` +
            (c.arbresDetectes ? `${c.arbres.length} arbres détectés. ` : "cercle trop grand pour détecter les arbres un à un. ") + `LiDAR HD × CoSIA ${c.millesimeCosia}, pixels de ${fr(c.pixelM)} m` +
            (c.couverturePct < 95 ? ` ; données sur ${fr(c.couverturePct)} % du cercle.` : "."),
        );
      } else if (id === "vegetation") {
        etatCouche(id, "Chargement…");
        const fc = await fetchVegetation(ctx, r);
        if (site !== ctx) return;
        (map.getSource("vegetation") as maplibregl.GeoJSONSource).setData(fc);
        etatCouche(id, fc.features?.length ? "" : "Aucune zone de végétation BD TOPO dans le périmètre.");
      }
    } catch (err) {
      charge.delete(id);
      if (id === "canopee") canopee = null; // nouvel essai à la réactivation
      etatCouche(
        id,
        id === "canopee" && err instanceof Error && /pas encore publié/.test(err.message)
          ? "LiDAR HD pas encore publié sur ce secteur (ou CoSIA absent) : canopée non mesurable ici."
          : "Source indisponible pour le moment — ce n'est pas une absence de donnée.",
      );
    }
  }

  // --- Fiche d'un bâtiment ----------------------------------------------------------
  for (const lid of ["bati-2d", "bati-3d"]) {
    map.on("click", lid, (e) => {
      if (choixParcelles || trace !== "aucun" || e.originalEvent === evtCoupe) return; // tracé d'une coupe en cours
      const p = e.features?.[0]?.properties as Record<string, unknown> | undefined;
      if (!p) return;
      const lignes = [
        `<strong>Hauteur :</strong> ${p.connue ? `${Number(p.h).toFixed(1)} m` : `inconnue (${DEFAULT_HEIGHT_M} m supposés)`}`,
        p.usage ? `<strong>Usage :</strong> ${esc(String(p.usage))}` : "",
        p.etages ? `<strong>Étages :</strong> ${p.etages}` : "",
        p.logements ? `<strong>Logements :</strong> ${p.logements}` : "",
      ].filter(Boolean);
      new maplibregl.Popup({ maxWidth: "240px" }).setLngLat(e.lngLat).setHTML(`<div class="m3d-popup">${lignes.join("<br>")}</div>`).addTo(map);
    });
    map.on("mouseenter", lid, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", lid, () => (map.getCanvas().style.cursor = ""));
  }

  // --- Périmètre de projet : choix des parcelles dans l'atelier ----------------------------
  // Même panneau que sous la carte du diagnostic, branché sur MapLibre ; le
  // périmètre appliqué vaut pour tout l'outil (options.onPerimetre).
  let choixParcelles: ((lat: number, lon: number) => void) | null = null;
  let cadastreAvantChoix: boolean | null = null;
  function basculerCouche(id: string, actif: boolean): void {
    const sw = root.querySelector<HTMLInputElement>(`.at-couche[data-couche="${id}"] .switch`);
    if (!sw || sw.checked === actif) return;
    sw.checked = actif;
    sw.dispatchEvent(new Event("change"));
  }
  const panneauAtelier = attachPerimetrePanel(
    q<HTMLElement>("[data-at-perimetre]"),
    {
      setSelection(onClic) {
        choixParcelles = onClic;
        map.getCanvas().style.cursor = onClic ? "crosshair" : "";
        if (onClic) {
          // Le cadastre s'affiche le temps du choix, puis revient à son état.
          cadastreAvantChoix ??= etat.get("cadastre")!.actif;
          basculerCouche("cadastre", true);
          if (map.getZoom() < 17) map.easeTo({ zoom: 17.5 });
        } else {
          if (cadastreAvantChoix !== null) basculerCouche("cadastre", cadastreAvantChoix);
          cadastreAvantChoix = null;
          (map.getSource("perimetre-selection") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] });
        }
      },
      afficherSelection(parcelles) {
        (map.getSource("perimetre-selection") as maplibregl.GeoJSONSource | undefined)?.setData({
          type: "FeatureCollection",
          features: parcelles.map((x) => ({ type: "Feature", properties: { court: x.court }, geometry: { type: "MultiPolygon", coordinates: x.geometrie } })),
        });
      },
      cadrer(contour) {
        const pts = contour.flatMap((poly) => poly[0]);
        const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
        map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 80, maxZoom: 19, duration: 600 });
      },
    },
    async (p) => {
      await options.onPerimetre?.(p);
    },
  );

  // --- Disponibilité du LiDAR HD au site ------------------------------------------------
  async function afficherDispoLidar(ctx: SiteContext): Promise<void> {
    const texte = q<HTMLElement>("[data-lidar-dispo]");
    const pastille = q<HTMLElement>("[data-lidar-pastille]");
    texte.textContent = "Disponibilité du LiDAR HD : vérification…";
    texte.dataset.etat = "";
    pastille.hidden = true;
    const d = await disponibiliteLidar(ctx.lat, ctx.lon, ctx.radiusM ?? 150);
    if (site !== ctx) return;
    texte.dataset.etat = d.etat;
    pastille.dataset.etat = d.etat;
    pastille.hidden = false;
    pastille.textContent = LIBELLE_DISPO_COURT[d.etat];
    texte.textContent = texteDispoLidar(d);
  }

  // --- Site ----------------------------------------------------------------------------
  let marker: maplibregl.Marker | null = null;
  async function setSite(ctx: SiteContext): Promise<void> {
    await pret;
    const memePoint = site && site.lat === ctx.lat && site.lon === ctx.lon;
    site = ctx;
    vide.hidden = true;
    panneauAtelier.setSite(ctx);
    void afficherDispoLidar(ctx);
    const pp = ctx.perimetre;
    q<HTMLElement>(".at-site").textContent =
      `${ctx.label}${pp ? ` · périmètre de projet ${pp.surfaceM2.toLocaleString("fr-FR")} m²` : ""}${ctx.radiusM !== null ? ` · rayon ${ctx.radiusM} m` : " · échelle parcelle"}`;
    (map.getSource("perimetre-projet") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: pp ? [{ type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: pp.contour } }] : [],
    });
    etatCouche(
      "perimetre-projet",
      pp
        ? pp.source === "import"
          ? "Contour importé."
          : `${pp.parcelles.length} parcelle${pp.parcelles.length > 1 ? "s" : ""} : ${pp.parcelles.map((x) => x.court).join(", ")}.`
        : "Aucun périmètre de projet : choisissez des parcelles dans l'onglet Diagnostic, sous la carte.",
    );
    (map.getSource("perimetre") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: ctx.radiusM !== null ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: cercle(ctx.lat, ctx.lon, ctx.radiusM) } }] : [],
    });
    coucheCourse.setSite(ctx.lat, ctx.lon, ctx.radiusM ?? 150);
    coucheCourse.setMoment(dateInput.value || today(), Number(hourInput.value));
    marker?.remove();
    marker = new maplibregl.Marker({ element: repere() }).setLngLat([ctx.lon, ctx.lat]).addTo(map);
    appliquer("repere");
    if (etat.get("carroyage")!.actif) dessinerCarroyage();
    if (!memePoint) {
      const r = ctx.radiusM ?? 150;
      map.jumpTo({ center: [ctx.lon, ctx.lat], zoom: r > 450 ? 15.3 : r > 200 ? 16.2 : 17, pitch: mode3d ? 55 : 0, bearing: mode3d ? -20 : 0 });
    }
    // Les données vectorielles dépendent du point et du rayon : on recharge.
    charge.clear();
    batimentsEnvoyes = false;
    for (const id of ["bati", "arbres", "vegetation", "ombres", "canopee"]) if (etat.get(id)!.actif) void chargerCouche(id);
    if (etat.get("ensoleillement")!.actif) void chargerCouche("bati");
    if (etat.get("courbes")!.actif) void dessinerCourbes();
    if (etat.get("isochrones")!.actif) void dessinerIsochrones();
    if (etat.get("equipements")!.actif) void dessinerEquipements();
    if (["patrimoine-mh", "patrimoine-sites", "patrimoine-spr"].some((c) => etat.get(c)!.actif)) void dessinerPatrimoine();
  }

  void pret.then(() => {
    COUCHES.forEach((c) => appliquer(c.id));
    appliquerColoration();
    compter();
    if (!site) vide.hidden = false;
  });

  /** Arbres avec l'envergure choisie : volumes 3D, ombres portées et coupe. */
  function poserArbres(): void {
    if (!arbresBruts) return;
    const f = envergure;
    const arbres = f === 1 ? arbresBruts.arbres : arbresBruts.arbres.map((a) => (a.couronne ? { ...a, couronne: a.couronne * f } : a));
    coucheArbres.setArbres(arbres, arbresBruts.lat0, arbresBruts.lon0);
    derniersArbres = { arbres, lat0: arbresBruts.lat0, lon0: arbresBruts.lon0 };
    if (profil) afficherCoupe();
    demanderOmbres();
  }
  {
    const r = q<HTMLInputElement>("[data-envergure]");
    let attente = 0;
    r.addEventListener("input", () => {
      envergure = Number(r.value) / 100;
      r.nextElementSibling!.textContent = `×${envergure.toLocaleString("fr-FR", { minimumFractionDigits: 2 })}`;
      try {
        localStorage.setItem("atelier:envergure", String(envergure));
      } catch {
        /* rien */
      }
      clearTimeout(attente);
      attente = window.setTimeout(poserArbres, 120); // ombres recalculées à la fin du geste
    });
  }

  /** Canopée en volume : surface LiDAR du site, posée sur le terrain. */
  let canopee3DPour: SiteContext | null = null;
  async function chargerCanopee3D(): Promise<void> {
    if (!site || canopee3DPour === site) return;
    const ctx = site;
    etatCouche("arbres", "Lecture de la canopée LiDAR…");
    try {
      const c = await canopeePour(ctx);
      if (site !== ctx) return;
      coucheCanopee3D.setCanopee(c.surface, ctx.lat, ctx.lon);
      canopee3DPour = ctx;
      etatCouche("arbres", `Canopée mesurée en volume (LiDAR HD, maille de ${c.surface.pasM.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} m) : ${c.canopeePct.toLocaleString("fr-FR")} % du cercle, jusqu'à ${c.hMax.toLocaleString("fr-FR")} m.`);
    } catch {
      etatCouche("arbres", "Canopée LiDAR indisponible ici (LiDAR HD pas encore publié ou service muet) : rendu « Arbres » conseillé.");
    }
  }

  // --- Mise en page et export ------------------------------------------------------
  brancherMiseEnPage({
    map,
    carte: q<HTMLElement>(".at-carte"),
    site: () => site,
    arbres3d: () => (etat.get("arbres")!.actif && rendu === "volume" ? derniersArbres : null),
    passer2D: () => q<HTMLButtonElement>('.at-mode button[data-mode="2d"]').click(),
    passer3D: () => {
      if (!mode3d) q<HTMLButtonElement>('.at-mode button[data-mode="3d"]').click();
    },
    focale: () => focale,
    // Calques de l'export SVG : une couche de l'atelier = un calque nommé.
    calque: (lid) => {
      if (lid === "fond-uni") return { cle: "fond-uni", titre: "Fond — teinte" };
      if (lid === "fond-plan") return { cle: "fond-plan", titre: "Fond — Plan IGN" };
      if (lid === "fond-photo") return { cle: "fond-photo", titre: "Fond — photo aérienne" };
      const ign = couchesIgn?.find((c) => c.layer.id === lid);
      if (ign) {
        const t = THEMES_IGN.find((x) => x.id === ign.theme)!;
        return { cle: `ign-${t.id}`, titre: `Fond composé — ${t.titre}` };
      }
      if (lid === "ombres-arbres") return { cle: "ombres", titre: "Ombres des arbres" };
      if (lid.startsWith("coupe-")) return { cle: "coupe", titre: "Coupe de terrain" };
      const c = COUCHES.find((x) => x.id === lid || couchesMap(x.id).includes(lid));
      if (!c) return null;
      if (c.id === "bati") return { cle: "bati", titre: coloration === "hauteur" ? "Bâtiments par hauteur" : coloration === "usage" ? "Bâtiments par usage" : "Bâtiments" };
      if (c.id === "cadastre" && lid === "cadastre-numeros") return { cle: "cadastre-numeros", titre: "Cadastre — numéros" };
      return { cle: c.id, titre: c.id === "cosia" ? `CoSIA ${millesime}` : c.titre };
    },
    legende: () => {
      const items: ElementLegende[] = [];
      for (const c of COUCHES) {
        const e = etat.get(c.id)!;
        if (!e.actif || c.id === "repere") continue;
        if (c.id === "fond") {
          if (fond !== "aucun")
            items.push({
              titre: `Fond : ${FONDS[fond].titre}${fond === "compose" && photoDessous ? " sur photo aérienne" : ""}`,
              source: fond === "plan" ? "IGN Plan" : fond === "compose" ? `Plan IGN vecteur${photoDessous ? ", IGN BD ORTHO®" : ""}` : "IGN BD ORTHO®",
            });
          continue;
        }
        const it: ElementLegende = { titre: c.titre, source: c.source.replace(/ \(repli.*\)$/, "") };
        if (c.id === "bati") {
          if (coloration === "hauteur") it.pastilles = [...HAUTEURS.map((h) => ({ couleur: h.color, libelle: `${h.label} m` })), { couleur: INCONNU, libelle: "hauteur inconnue" }];
          else if (coloration === "usage") it.pastilles = [...USAGES.map((u) => ({ couleur: u.color, libelle: u.valeur })), { couleur: USAGE_AUTRE, libelle: "annexe, autre" }];
          else it.pastilles = [{ couleur: NEUTRE, libelle: "bâtiment" }];
          it.titre = coloration === "hauteur" ? "Bâtiments par hauteur" : coloration === "usage" ? "Bâtiments par usage" : "Bâtiments";
        }
        if (c.id === "arbres") it.pastilles = [{ couleur: rendu === "volume" ? "#3a7a30" : "#3f8f3a", libelle: sourceArbres === "lidar" ? "arbre détecté (LiDAR HD)" : "arbre recensé (OSM)" }];
        if (c.id === "vegetation") it.pastilles = [{ couleur: "#5f9e4b", libelle: "zone de végétation" }];
        if (c.id === "canopee") it.pastilles = CLASSES_HAUTEUR.map((h) => ({ couleur: h.couleur, libelle: `végétation ${h.titre}` }));
        if (c.id === "ombres") it.pastilles = [{ couleur: "#1f2a44", libelle: `ombres, ${dateInput.value} ${hourInput.value.replace(".25", "h15").replace(".5", "h30").replace(".75", "h45")} h` }];
        if (c.id === "perimetre") it.pastilles = [{ couleur: "#3a3a3c", libelle: `rayon d'analyse${site?.radiusM ? ` (${site.radiusM} m)` : ""}` }];
        if (c.id === "perimetre-projet") {
          if (!site?.perimetre) continue; // rien à légender
          it.pastilles = [{ couleur: "#c4322b", libelle: "périmètre de projet" }];
        }
        if (c.id === "cosia") it.titre = `CoSIA ${millesime}`;
        if (c.id === "carroyage") it.titre = `Carroyage Lambert-93, pas de ${pas} m`;
        items.push(it);
      }
      return items;
    },
  });

  // Accès pour les tests automatiques (lecture seule de l'état de la carte).
  (root as HTMLElement & { __carte?: maplibregl.Map }).__carte = map;

  return { setSite, resize: () => map.resize() };
}
