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
import type { SiteContext } from "../core/types";
import { fetchTrees } from "../modules/soleil/fetch";
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
import { DEM_TUILES, enregistrerProtocoleRelief } from "./relief-dem";
import { THEMES_IGN, SPRITE_PLAN_IGN, OPACITE, chargerStylePlanIgn, type ThemeIgn, type CoucheIgn } from "./fond-ign";
import { carroyage } from "./lambert93";
import { creerCoucheArbres3D } from "./arbres3d";
import { ombresArbres } from "./ombres-arbres";
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

export function createAtelier(root: HTMLElement): Atelier {
  const famillesRepliees = new Set<string>();
  try {
    for (const f of JSON.parse(localStorage.getItem(CLE_REPLIEES) ?? "[]") as string[]) famillesRepliees.add(f);
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
  let rendu: "volume" | "point" = "volume";
  let derniersArbres: { arbres: import("../modules/soleil/fetch").ArbreOsm[]; lat0: number; lon0: number } | null = null;
  let millesime: MillesimeCosia = "2021-2023";
  let pas: (typeof PAS_CARROYAGE)[number] = 100;
  let exag: (typeof EXAGERATIONS)[number] = 1.5;
  let pasCourbes: (typeof PAS_COURBES)[number] = "auto";
  let numerosCadastre = false;
  /** Fond composé posé sur la photo aérienne (le fond opaque IGN s'efface). */
  let photoDessous = false;
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
          ? `<div class="segmented seg-sm" role="group" aria-label="Rendu des arbres">
              <button type="button" data-rendu="volume" aria-pressed="true">Volume</button>
              <button type="button" data-rendu="point" aria-pressed="false">Point</button>
            </div>`
        : c.id === "relief"
          ? `<div class="segmented seg-sm" role="group" aria-label="Exagération du relief en 3D">
              ${EXAGERATIONS.map((v) => `<button type="button" data-exag="${v}" aria-pressed="${v === exag}">×${String(v).replace(".", ",")}</button>`).join("")}
            </div>`
        : c.id === "courbes"
          ? `<div class="segmented seg-sm" role="group" aria-label="Équidistance des courbes">
              ${PAS_COURBES.map((v) => `<button type="button" data-courbes="${v}" aria-pressed="${v === pasCourbes}">${v === "auto" ? "Auto" : `${v} m`}</button>`).join("")}
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
            <div class="at-legende" data-legende-bati></div>
            <p class="at-note" data-bati-source></p>`
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
      <div class="at-familles">
        ${FAMILLES.map(
          (f) =>
            `<section class="at-famille${famillesRepliees.has(f) ? " repliee" : ""}" data-famille="${f}">
              <h3><button type="button" class="at-famille-btn" aria-expanded="${!famillesRepliees.has(f)}">
                <svg class="at-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
                <span>${f}</span><span class="at-famille-n"></span>
              </button></h3>
              <div class="at-famille-corps">${COUCHES.filter((c) => c.famille === f).map(ligne).join("")}</div>
            </section>`,
        ).join("")}
      </div>
      <p class="at-sources">Sources : IGN (Plan, BD ORTHO®, BD TOPO®, Parcellaire Express), Géoportail de
        l'Urbanisme, Géorisques, INPN, OpenStreetMap.</p>
    </aside>
    <div class="at-carte">
      <div class="at-canvas"></div>
      <button type="button" class="at-ouvrir icon-btn" aria-label="Afficher les couches" title="Afficher les couches">☰</button>
      <div class="segmented at-mode" role="group" aria-label="Vue">
        <button type="button" data-mode="2d" aria-pressed="true">2D</button>
        <button type="button" data-mode="3d" aria-pressed="false">3D</button>
      </div>
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
          rasters.map((c) => [c.id, { type: "raster", tiles: [c.tuiles!], tileSize: 256, maxzoom: c.zoomMax ?? 20, attribution: c.source }]),
        ),
        bati: vecteur(),
        vegetation: vecteur(),
        arbres: vecteur(),
        ombres: vecteur(),
        "ombres-arbres": vecteur(),
        perimetre: vecteur(),
        carroyage: vecteur(),
        courbes: vecteur(),
        isochrones: vecteur(),
        equipements: vecteur(),
        patrimoine: vecteur(),
        // Deux sources pour les mêmes tuiles : MapLibre conseille de séparer terrain et ombrage.
        // Terrain jusqu'au zoom 15 (environ 3 m par pixel, assez pour le volume) ; ombrage au
        // zoom 14, plus doux : au mètre près, il dessine chaque talus et chaque mur.
        // Parcellaire Express en tuiles vectorielles (traits fins, numéros à la demande).
        pci: { type: "vector", tiles: ["https://data.geopf.fr/tms/1.0.0/PCI/{z}/{x}/{y}.pbf"], minzoom: 5, maxzoom: 19, attribution: "© IGN Parcellaire Express" },
        dem: { type: "raster-dem", tiles: [DEM_TUILES], tileSize: 256, encoding: "terrarium", maxzoom: 15, attribution: "© IGN RGE ALTI®" },
        "dem-ombrage": { type: "raster-dem", tiles: [DEM_TUILES], tileSize: 256, encoding: "terrarium", maxzoom: 14 },
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
      ],
    },
    center: [2.5, 46.6],
    zoom: 5,
    maxPitch: 75,
    attributionControl: { compact: true },
    canvasContextAttributes: { preserveDrawingBuffer: true }, // exports à venir (mise en page)
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 140 }), "bottom-right");
  // Arbres en volume (three.js), sous le carroyage et le périmètre.
  const coucheArbres = creerCoucheArbres3D("arbres-3d");
  const coucheCourse = creerCoucheCourseSoleil("course-3d");
  coucheCourse.setPlan(true); // l'atelier s'ouvre en 2D
  const pret = new Promise<void>((r) =>
    map.once("load", () => {
      map.addLayer(coucheArbres, "carroyage");
      map.setLayoutProperty("arbres-3d", "visibility", "none");
      map.addLayer(coucheCourse, "carroyage");
      map.setLayoutProperty("course-3d", "visibility", "none");
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
    for (const [id, c] of [["arbres-3d", coucheArbres], ["course-3d", coucheCourse]] as const) {
      if (map.getLayer(id)) map.removeLayer(id);
      map.addLayer(c, map.getLayer("carroyage") ? "carroyage" : undefined);
    }
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
    if (id === "bati") return ["bati-2d", "bati-3d"];
    if (id === "arbres") return ["arbres", "arbres-3d"];
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
      map.setPaintProperty("fond-photo", "raster-opacity", fond === "compose" && photoDessous ? 1 : e.opacite);
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
      if (lid === "bati-3d") visible = e.actif && mode3d;
      // Arbres en volume dans les deux vues (vus en plan en 2D), ou en points.
      if (lid === "arbres") visible = e.actif && rendu === "point";
      if (lid === "arbres-3d") visible = e.actif && rendu === "volume";
      if (lid === "cadastre-numeros") visible = e.actif && numerosCadastre;
      map.setLayoutProperty(lid, "visibility", visible ? "visible" : "none");
      const prop = PROP[layer.type];
      // Isochrones : la réglette règle le remplissage ; les contours restent nets.
      // Patrimoine : aplats légers pour les sites et SPR, contours et noms toujours nets.
      const aplatLeger = lid === "patrimoine-sites" || lid === "patrimoine-spr";
      const net = lid === "isochrones-ligne" || lid === "patrimoine-abords" || lid.endsWith("-ligne") || lid === "patrimoine-noms";
      if (prop && !net) map.setPaintProperty(lid, prop, aplatLeger ? e.opacite * 0.3 : e.opacite);
      if (lid === "arbres-3d") coucheArbres.setOpacite(e.opacite);
      if (lid === "course-3d") coucheCourse.setOpacite(e.opacite);
      if (lid === "arbres") map.setPaintProperty(lid, "circle-stroke-opacity", e.opacite);
      if (lid === "courbes-cotes") map.setPaintProperty(lid, "text-opacity", e.opacite);
      if (lid === "equipements") map.setPaintProperty(lid, "circle-stroke-opacity", e.opacite);
      if (lid === "cadastre-numeros") map.setPaintProperty(lid, "text-opacity", e.opacite);
    }
    if (id === "relief") majTerrain();
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
    q<HTMLElement>("[data-legende-bati]").innerHTML = legendeBati();
    root.querySelectorAll<HTMLButtonElement>("[data-cosia]").forEach((b) =>
    b.addEventListener("click", async () => {
      millesime = b.dataset.cosia as MillesimeCosia;
      root.querySelectorAll("[data-cosia]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      await pret;
      (map.getSource("cosia") as maplibregl.RasterTileSource).setTiles([tuilesCosia(millesime)]);
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-rendu]").forEach((b) =>
    b.addEventListener("click", async () => {
      rendu = b.dataset.rendu as typeof rendu;
      root.querySelectorAll("[data-rendu]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      await pret;
      appliquer("arbres");
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
    const range = el.querySelector<HTMLInputElement>('input[type="range"]')!;
    const out = el.querySelector("output")!;
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
      // Sous l'ombrage du relief et toutes nos couches, au-dessus des fonds raster.
      for (const c of couches) if (!map.getLayer(c.layer.id)) map.addLayer(c.layer as unknown as maplibregl.LayerSpecification, "relief");
      couchesIgn = couches;
      appliquer("fond");
    } catch {
      etatCouche("fond", "Plan IGN vectoriel indisponible pour le moment.");
    }
  }
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
      root.querySelectorAll(".at-mode button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      map.easeTo({ pitch: mode3d ? 55 : 0, bearing: mode3d ? -20 : 0, duration: 600 });
      appliquer("bati");
      appliquer("arbres");
      majTerrain();
    }),
  );

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
      coucheCourse.setAltitude(alt(site.lon, site.lat) ?? 0);
    }, 300);
  }
  map.on("idle", () => {
    if (map.getTerrain()) poserSurSol();
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
      const c = await calculerCourbes(ctx.lat, ctx.lon, demi, pasCourbes);
      if (n !== demandeCourbes || site !== ctx) return;
      (map.getSource("courbes") as maplibregl.GeoJSONSource).setData(c.geojson);
      const fr = (v: number) => v.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
      etatCouche(
        "courbes",
        c.geojson.features.length
          ? `Équidistance ${fr(c.equidistance)} m · altitudes de ${fr(c.min)} à ${fr(c.max)} m sur un carré de ${fr((2 * demi) / 1000)} km de côté.` +
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
      return;
    }
    const neutre = coloration === "neutre";
    const el = sun.elevationDeg;
    if (el <= 0.5) {
      map.setLight({ anchor: "map", position: [1.5, sun.azimuthDeg, 80], color: neutre ? "#8a93b8" : "#ffffff", intensity: neutre ? 0.45 : 0.3 });
      coucheArbres.setSoleil({ azimut: sun.azimuthDeg, hauteur: 0, couleur: 0x8a93b8, intensite: 0 });
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
        (map.getSource("bati") as maplibregl.GeoJSONSource).setData(batiGeoJSON(data));
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
        etatCouche(id, "Chargement…");
        const arbres = await fetchTrees(ctx, r);
        if (site !== ctx) return;
        (map.getSource("arbres") as maplibregl.GeoJSONSource).setData({
          type: "FeatureCollection",
          features: arbres.map((a) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [a.lon, a.lat] } })),
        });
        coucheArbres.setArbres(arbres, ctx.lat, ctx.lon);
        derniersArbres = { arbres, lat0: ctx.lat, lon0: ctx.lon };
        demanderOmbres();
        etatCouche(id, arbres.length ? `${arbres.length} arbres recensés dans le périmètre.` : "Aucun arbre recensé dans OpenStreetMap ici (inventaire souvent incomplet).");
      } else if (id === "vegetation") {
        etatCouche(id, "Chargement…");
        const fc = await fetchVegetation(ctx, r);
        if (site !== ctx) return;
        (map.getSource("vegetation") as maplibregl.GeoJSONSource).setData(fc);
        etatCouche(id, fc.features?.length ? "" : "Aucune zone de végétation BD TOPO dans le périmètre.");
      }
    } catch {
      charge.delete(id);
      etatCouche(id, "Source indisponible pour le moment — ce n'est pas une absence de donnée.");
    }
  }

  // --- Fiche d'un bâtiment ----------------------------------------------------------
  for (const lid of ["bati-2d", "bati-3d"]) {
    map.on("click", lid, (e) => {
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

  // --- Site ----------------------------------------------------------------------------
  let marker: maplibregl.Marker | null = null;
  async function setSite(ctx: SiteContext): Promise<void> {
    await pret;
    const memePoint = site && site.lat === ctx.lat && site.lon === ctx.lon;
    site = ctx;
    vide.hidden = true;
    q<HTMLElement>(".at-site").textContent = `${ctx.label}${ctx.radiusM !== null ? ` · périmètre ${ctx.radiusM} m` : " · échelle parcelle"}`;
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
    for (const id of ["bati", "arbres", "vegetation", "ombres"]) if (etat.get(id)!.actif) void chargerCouche(id);
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

  // --- Mise en page et export ------------------------------------------------------
  brancherMiseEnPage({
    map,
    carte: q<HTMLElement>(".at-carte"),
    site: () => site,
    arbres3d: () => (etat.get("arbres")!.actif && rendu === "volume" ? derniersArbres : null),
    passer2D: () => q<HTMLButtonElement>('.at-mode button[data-mode="2d"]').click(),
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
        if (c.id === "arbres") it.pastilles = [{ couleur: rendu === "volume" ? "#3a7a30" : "#3f8f3a", libelle: "arbre recensé" }];
        if (c.id === "vegetation") it.pastilles = [{ couleur: "#5f9e4b", libelle: "zone de végétation" }];
        if (c.id === "ombres") it.pastilles = [{ couleur: "#1f2a44", libelle: `ombres, ${dateInput.value} ${hourInput.value.replace(".25", "h15").replace(".5", "h30").replace(".75", "h45")} h` }];
        if (c.id === "perimetre") it.pastilles = [{ couleur: "#3a3a3c", libelle: "périmètre d'analyse" }];
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
