// Carte Leaflet avec fonds IGN Géoplateforme (WMTS libre, sans clé).
import L from "leaflet";
import { IGN_WMTS, IGN_LAYERS, IGN_CADASTRE_WMTS } from "../api/endpoints";
import type { MultiPolygone } from "../core/perimetre";
import type { SiteContext } from "../core/types";

function ignLayer(def: { layer: string; format: string }): L.TileLayer {
  const url = IGN_WMTS.replace("{layer}", def.layer).replace("{format}", def.format);
  return L.tileLayer(url, {
    attribution: "© IGN / Géoplateforme",
    maxZoom: 19,
    tileSize: 256,
  });
}

let map: L.Map | null = null;
let marker: L.Marker | null = null;
let onMarkerMoved: ((lat: number, lon: number) => void) | null = null;

/** Rappel appelé quand l'utilisateur fait glisser le repère du site. */
export function setMarkerMovedHandler(fn: (lat: number, lon: number) => void): void {
  onMarkerMoved = fn;
}

/** Replace le repère à une position (annulation d'un déplacement). */
export function resetMarker(lat: number, lon: number): void {
  marker?.setLatLng([lat, lon]);
}

/** Repère du site : point plein cerclé et croix de visée, dessiné en CSS/SVG
 * (pas d'image à charger, net à toutes les résolutions). */
const SITE_ICON = L.divIcon({
  className: "site-marker",
  html: `<svg viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
    <line x1="18" y1="1" x2="18" y2="11" /><line x1="18" y1="25" x2="18" y2="35" />
    <line x1="1" y1="18" x2="11" y2="18" /><line x1="25" y1="18" x2="35" y2="18" />
    <circle cx="18" cy="18" r="7" class="ring" /><circle cx="18" cy="18" r="3" class="dot" />
  </svg>`,
  iconSize: [36, 36],
  iconAnchor: [18, 18],
  popupAnchor: [0, -16],
});
let analysisCircle: L.Circle | null = null;
let parcelleLayer: L.Polygon | null = null;

export function initMap(el: HTMLElement): L.Map {
  if (map) return map;

  const plan = ignLayer(IGN_LAYERS.plan);
  const ortho = ignLayer(IGN_LAYERS.ortho);

  map = L.map(el, { center: [46.6, 2.5], zoom: 6, layers: [plan] });
  L.control.layers({ "Plan IGN": plan, "Photo aérienne": ortho }).addTo(map);
  // La hauteur de la carte change avec le panneau du périmètre : Leaflet doit le savoir.
  new ResizeObserver(() => map?.invalidateSize()).observe(el);
  return map;
}

export function focusSite(ctx: SiteContext): void {
  if (!map) return;
  map.setView([ctx.lat, ctx.lon], 17);
  if (marker) marker.remove();
  marker = L.marker([ctx.lat, ctx.lon], {
    icon: SITE_ICON,
    title: `${ctx.label} — faites glisser pour déplacer le point d'analyse`,
    draggable: true,
    autoPan: true,
  })
    .addTo(map)
    .bindPopup(ctx.label)
    .openPopup();
  marker.on("dragstart", () => marker?.closePopup());
  marker.on("dragend", () => {
    const ll = marker!.getLatLng();
    onMarkerMoved?.(ll.lat, ll.lng);
  });
  updateAnalysisCircle(ctx);
  updateParcelleLayer(ctx);
}

/** Dessine (ou retire) le cercle de rayon d'analyse "quartier". */
export function updateAnalysisCircle(ctx: SiteContext): void {
  if (!map) return;
  if (analysisCircle) {
    analysisCircle.remove();
    analysisCircle = null;
  }
  if (ctx.radiusM !== null) {
    analysisCircle = L.circle([ctx.lat, ctx.lon], {
      radius: ctx.radiusM,
      color: "#3A3A3C",
      dashArray: "5 5",
      weight: 1.5,
      fillOpacity: 0.05,
    }).addTo(map);
  }
}

/** Dessine (ou retire) le contour de la vraie parcelle cadastrale, si trouvée. */
export function updateParcelleLayer(ctx: SiteContext): void {
  if (!map) return;
  if (parcelleLayer) {
    parcelleLayer.remove();
    parcelleLayer = null;
  }
  if (ctx.parcelle) {
    const latLngs = ctx.parcelle.polygon.map((p) => [p.lat, p.lon] as [number, number]);
    parcelleLayer = L.polygon(latLngs, {
      color: "#d35400",
      weight: 2,
      dashArray: "6 4",
      fillOpacity: 0.03,
    }).addTo(map);
    if (ctx.parcelle.reference) {
      parcelleLayer.bindTooltip(`Parcelle ${ctx.parcelle.reference}`);
    }
  }
}

export function getMapElement(): HTMLElement | null {
  return map ? map.getContainer() : null;
}

// --- Périmètre de projet -------------------------------------------------------

/** Couleur du périmètre de projet (identique dans l'atelier et les exports). */
export const COULEUR_PERIMETRE = "#c4322b";

let perimetreLayer: L.Polygon | null = null;
let selectionLayer: L.LayerGroup | null = null;
let cadastreLayer: L.TileLayer | null = null;
let clicSelection: ((lat: number, lon: number) => void) | null = null;

function versLatLngs(mp: MultiPolygone): L.LatLngExpression[][][] {
  return mp.map((poly) => poly.map((ring) => ring.map(([lon, lat]) => [lat, lon] as [number, number])));
}

/** Dessine (ou retire) le périmètre de projet appliqué au diagnostic. */
export function updatePerimetreLayer(contour: MultiPolygone | null, titre?: string): void {
  if (!map) return;
  perimetreLayer?.remove();
  perimetreLayer = null;
  if (!contour) return;
  perimetreLayer = L.polygon(versLatLngs(contour), {
    color: COULEUR_PERIMETRE,
    weight: 3,
    fillColor: COULEUR_PERIMETRE,
    fillOpacity: 0.06,
  }).addTo(map); // les clics remontent à la carte (sélection des parcelles)
  if (titre) perimetreLayer.bindTooltip(titre, { sticky: true });
}

/** Cadre la carte sur le périmètre. */
export function cadrerPerimetre(contour: MultiPolygone): void {
  if (!map) return;
  const b = L.latLngBounds(contour.flatMap((poly) => poly[0].map(([lon, lat]) => [lat, lon] as [number, number])));
  if (b.isValid()) map.fitBounds(b, { padding: [40, 40], maxZoom: 19 });
}

/** Replace le repère du site sur un point (recentrage sur le périmètre). */
export function moveSiteMarker(lat: number, lon: number): void {
  marker?.setLatLng([lat, lon]);
}

/**
 * Mode de sélection des parcelles : affiche le cadastre et transmet chaque
 * clic sur la carte. `null` quitte le mode.
 */
export function setSelectionParcelles(onClic: ((lat: number, lon: number) => void) | null): void {
  if (!map) return;
  if (clicSelection) map.off("click", relaisClic);
  clicSelection = onClic;
  const el = map.getContainer();
  el.classList.toggle("map-selection", !!onClic);
  if (onClic) {
    map.on("click", relaisClic);
    if (!cadastreLayer) cadastreLayer = ignLayer(IGN_CADASTRE_WMTS).setZIndex(5);
    cadastreLayer.addTo(map);
    if ((map.getZoom() ?? 0) < 17) map.setZoom(17);
    marker?.closePopup();
  } else {
    cadastreLayer?.remove();
    afficherSelection([]);
  }
}

function relaisClic(e: L.LeafletMouseEvent): void {
  clicSelection?.(e.latlng.lat, e.latlng.lng);
}

/** Parcelles en cours de sélection (aplat léger, trait fin). */
export function afficherSelection(parcelles: { geometrie: MultiPolygone; court: string }[]): void {
  if (!map) return;
  selectionLayer?.remove();
  selectionLayer = null;
  if (parcelles.length === 0) return;
  selectionLayer = L.layerGroup(
    parcelles.map((p) =>
      L.polygon(versLatLngs(p.geometrie), {
        color: COULEUR_PERIMETRE,
        weight: 1.5,
        fillColor: COULEUR_PERIMETRE,
        fillOpacity: 0.25,
        interactive: false,
      }).bindTooltip(p.court, { permanent: false }),
    ),
  ).addTo(map);
}
