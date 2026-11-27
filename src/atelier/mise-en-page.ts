// Mise en page et export de l'Atelier cartographique.
//
// Un cadre posé sur la carte montre l'emprise exacte de la feuille au sol,
// pour le format et l'échelle choisis (échelle saisie librement). L'export
// redessine la carte à la résolution d'impression dans une carte hors écran,
// par morceaux pour les grands formats (les navigateurs limitent la taille
// d'une image), puis compose la planche : PDF (habillage vectoriel : nord,
// échelle graphique, légende, cartouche, sources) ou PNG.
//
// Vue imprimée : nord en haut, sans inclinaison (2D) ; les arbres y sont des
// points.
//
// SVG à calques (svg-planche.ts, chargé à la demande) : un groupe par couche,
// vecteurs redessinés et images calées, pour Illustrator ou Inkscape ; en
// ZIP, un SVG par calque.

import { nordSolaire, encombrement } from "./nord-solaire";
import maplibregl from "maplibre-gl";
import { jsPDF } from "jspdf";
import { creerCoucheArbres3D } from "./arbres3d";
import type { ArbreOsm } from "../modules/soleil/fetch";

export const MERC = 40075016.686; // circonférence équatoriale (m), Web Mercator
const TUILE = 2048; // côté d'un morceau rendu hors écran (px)
const PNG_MAX_PX = 16_000_000; // limite d'image de Safari iOS (~16,7 Mpx)

export const FORMATS = {
  A4: [210, 297],
  A3: [297, 420],
  A2: [420, 594],
  A1: [594, 841],
  A0: [841, 1189],
} as const;
type NomFormat = keyof typeof FORMATS | "libre";

export interface ElementLegende {
  titre: string;
  source: string;
  /** Pastilles de couleur (bâtiments par hauteur, par usage…). */
  pastilles?: { couleur: string; libelle: string }[];
}

export interface OptionsMiseEnPage {
  map: maplibregl.Map;
  /** Conteneur de la carte, où placer le bouton et le panneau. */
  carte: HTMLElement;
  legende(): ElementLegende[];
  site(): { label: string; lat: number } | null;
  /** Arbres en volume à redessiner sur la planche (null : rendu en points ou couche éteinte). */
  arbres3d(): { arbres: ArbreOsm[]; lat0: number; lon0: number } | null;
  /** Bascule la vue en 2D (la planche est imprimée nord en haut, à plat). */
  passer2D(): void;
  /** Bascule la vue en 3D (planche en perspective). */
  passer3D(): void;
  /** Focale de la caméra 3D (mm, équivalent 24 × 36). */
  focale(): number;
  /** Couche de l'atelier d'une couche de style (calques de l'export SVG). */
  calque?(layerId: string): { cle: string; titre: string } | null;
}

/** Caméra d'une planche en perspective, pour l'habillage. */
export interface Camera3D {
  pitch: number;
  bearing: number;
  focale: number;
}

export interface Reglages {
  format: NomFormat;
  libre: [number, number];
  paysage: boolean;
  echelle: number;
  dpi: number;
  titre: string;
  /** « plan » : à l'échelle, nord en haut ; « 3d » : vue en perspective, sans échelle. */
  vue?: "plan" | "3d";
}

/** Géométrie de la planche (mm) : page, marges, bandeau, zone carte. */
export function gabarit(r: Reglages) {
  const [a, b] = r.format === "libre" ? r.libre : FORMATS[r.format];
  const [w, h] = r.paysage ? [Math.max(a, b), Math.min(a, b)] : [Math.min(a, b), Math.max(a, b)];
  const court = Math.min(w, h);
  const marge = Math.max(8, Math.round(court * 0.04));
  // Bandeau proportionnel au facteur de taille des textes (f = 1 en A4).
  const f = Math.max(1, court / 210);
  // Bandeau réduit de 20 % (retours du 24/11 : plus de place pour la carte).
  const bandeau = Math.round(29 * f);
  return { w, h, marge, bandeau, carteW: w - 2 * marge, carteH: h - 2 * marge - bandeau - marge / 2 };
}

export const ll2merc = (lon: number, lat: number): [number, number] => [
  (lon * MERC) / 360,
  (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * MERC) / (2 * Math.PI),
];
export const merc2ll = (x: number, y: number): [number, number] => [
  (x * 360) / MERC,
  (Math.atan(Math.exp((y * 2 * Math.PI) / MERC)) * 360) / Math.PI - 90,
];

/** Emprise au sol de la zone carte, en mètres Mercator, centrée sur `centre`. */
export function emprise(r: Reglages, centre: maplibregl.LngLat) {
  const g = gabarit(r);
  const k = 1 / Math.cos((centre.lat * Math.PI) / 180); // dilatation Mercator
  const [cx, cy] = ll2merc(centre.lng, centre.lat);
  const larg = ((g.carteW * r.echelle) / 1000) * k;
  const haut = ((g.carteH * r.echelle) / 1000) * k;
  return { cx, cy, larg, haut, solW: (g.carteW * r.echelle) / 1000, solH: (g.carteH * r.echelle) / 1000 };
}

/** Aperçu de la planche sur la carte : la feuille entière à l'échelle (vraies
 * proportions A4, A3…), la zone carte dedans et le bandeau du cartouche. */
function polygoneCadre(r: Reglages, centre: maplibregl.LngLat): GeoJSON.FeatureCollection {
  const g = gabarit(r);
  const e = emprise(r, centre);
  const s = e.larg / g.carteW; // mètres Mercator par mm de papier
  // Zone carte (centrée sur le centre de la vue) puis feuille autour.
  const cO = e.cx - e.larg / 2, cE = e.cx + e.larg / 2, cS = e.cy - e.haut / 2, cN = e.cy + e.haut / 2;
  const pO = cO - g.marge * s, pE = cE + g.marge * s, pN = cN + g.marge * s, pS = pN - g.h * s;
  const bN = cS - (g.marge / 2) * s, bS = bN - g.bandeau * s;
  const ll = (x: number, y: number) => merc2ll(x, y);
  const anneau = (x1: number, y1: number, x2: number, y2: number) => [ll(x1, y1), ll(x2, y1), ll(x2, y2), ll(x1, y2), ll(x1, y1)];
  const [ouest, sud] = ll(pO, pS);
  const [est, nord] = ll(pE, pN);
  // Voile hors feuille : quatre bandes autour (plus sûr qu'un polygone troué).
  const W = ouest - 0.5, E = est + 0.5, S = sud - 0.3, N = nord + 0.3;
  const rect = (role: string, x1: number, y1: number, x2: number, y2: number): GeoJSON.Feature => ({
    type: "Feature",
    properties: { role },
    geometry: { type: "Polygon", coordinates: [[[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]] },
  });
  const ligne = (role: string, c: [number, number][]): GeoJSON.Feature => ({ type: "Feature", properties: { role }, geometry: { type: "LineString", coordinates: c } });
  // Marges blanches de la feuille autour de la zone carte (comme sur le papier).
  const [cOl, cSl] = ll(cO, cS);
  const [cEl, cNl] = ll(cE, cN);
  return {
    type: "FeatureCollection",
    features: [
      rect("masque", W, nord, E, N), rect("masque", W, S, E, sud), rect("masque", W, sud, ouest, nord), rect("masque", est, sud, E, nord),
      rect("papier", ouest, cNl, est, nord), rect("papier", ouest, sud, est, cSl), rect("papier", ouest, cSl, cOl, cNl), rect("papier", cEl, cSl, est, cNl),
      { type: "Feature", properties: { role: "bandeau" }, geometry: { type: "Polygon", coordinates: [anneau(cO, bS, cE, bN)] } },
      ligne("page", anneau(pO, pS, pE, pN)),
      ligne("cadre", anneau(cO, cS, cE, cN)),
    ],
  };
}

/** Emprise de la feuille entière (mètres Mercator), pour cadrer la vue. */
/** Centre de la zone carte quand la feuille entière est centrée sur `vue` :
 * le bandeau occupe le bas de la feuille, la zone carte est donc un peu au-dessus. */
function centreZoneCarte(r: Reglages, vue: maplibregl.LngLat): maplibregl.LngLat {
  const g = gabarit(r);
  const k = 1 / Math.cos((vue.lat * Math.PI) / 180);
  const decalMm = g.h / 2 - (g.marge + g.carteH / 2);
  const [x, y] = ll2merc(vue.lng, vue.lat);
  const [lng, lat] = merc2ll(x, y + ((decalMm * r.echelle) / 1000) * k);
  return new maplibregl.LngLat(lng, lat);
}

const COUCHES_CADRE = ["cadre-masque", "cadre-papier", "cadre-bandeau", "cadre-page", "cadre-ligne"];

function empriseFeuille(r: Reglages, centre: maplibregl.LngLat) {
  const g = gabarit(r);
  const e = emprise(r, centre);
  const s = e.larg / g.carteW;
  const n = e.cy + e.haut / 2 + g.marge * s;
  return { o: e.cx - e.larg / 2 - g.marge * s, e: e.cx + e.larg / 2 + g.marge * s, n, s: n - g.h * s };
}

/** Longueur « ronde » de l'échelle graphique (m) pour environ `cible` mètres. */
export function longueurRonde(cible: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(cible)));
  for (const f of [5, 2, 1]) if (f * p <= cible) return f * p;
  return p;
}

/** Rend la carte à l'emprise demandée, morceau par morceau. `garder` : ne
 * dessine que ces couches (calques séparés de l'export SVG, fond transparent). */
export async function rendre(
  arbres: { arbres: ArbreOsm[]; lat0: number; lon0: number } | null,
  map: maplibregl.Map,
  r: Reglages,
  centre: maplibregl.LngLat,
  pxW: number,
  pxH: number,
  surMorceau: (img: HTMLCanvasElement, x: number, y: number) => void,
  progres: (fait: number, total: number) => void,
  garder?: (l: maplibregl.LayerSpecification) => boolean,
): Promise<void> {
  const e = emprise(r, centre);
  const mppMerc = e.larg / pxW;
  const zoom = Math.log2(MERC / (512 * mppMerc));
  const style = map.getStyle();
  style.layers = style.layers.filter((l) => (l.type as string) !== "custom" && !l.id.startsWith("cadre-") && (!garder || garder(l)));
  delete (style.sources as Record<string, unknown>)["cadre"];
  // Planche en plan : pas de terrain 3D (l'ombrage du relief reste).
  delete (style as { terrain?: unknown }).terrain;

  const div = document.createElement("div");
  div.style.cssText = `position:fixed;left:-${TUILE * 2}px;top:0;width:${TUILE}px;height:${TUILE}px;pointer-events:none;`;
  document.body.appendChild(div);
  const hors = new maplibregl.Map({
    container: div,
    style,
    center: centre,
    zoom,
    pitch: 0,
    bearing: 0,
    interactive: false,
    attributionControl: false,
    pixelRatio: 1,
    fadeDuration: 0,
    canvasContextAttributes: { preserveDrawingBuffer: true },
  });
  try {
    await new Promise<void>((ok) => hors.once("load", () => ok()));
    if (arbres) {
      // La couche three.js n'est pas dans le style : on la recrée sur la carte hors écran.
      const couche = creerCoucheArbres3D("arbres-3d-impression");
      hors.addLayer(couche, hors.getLayer("carroyage") ? "carroyage" : undefined);
      couche.setArbres(arbres.arbres, arbres.lat0, arbres.lon0);
    }
    const nx = Math.ceil(pxW / TUILE);
    const ny = Math.ceil(pxH / TUILE);
    let fait = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        // Centre du morceau en Mercator (y Mercator vers le nord, image vers le bas).
        const px = i * TUILE + TUILE / 2;
        const py = j * TUILE + TUILE / 2;
        const mx = e.cx - e.larg / 2 + px * mppMerc;
        const my = e.cy + e.haut / 2 - py * mppMerc;
        hors.jumpTo({ center: merc2ll(mx, my), zoom });
        await new Promise<void>((ok) => {
          const t = setTimeout(ok, 20_000); // ne bloque pas sur une tuile perdue
          hors.once("idle", () => {
            clearTimeout(t);
            ok();
          });
          hors.triggerRepaint();
        });
        const c = document.createElement("canvas");
        c.width = Math.min(TUILE, pxW - i * TUILE);
        c.height = Math.min(TUILE, pxH - j * TUILE);
        c.getContext("2d")!.drawImage(hors.getCanvas(), 0, 0, c.width, c.height, 0, 0, c.width, c.height);
        surMorceau(c, i * TUILE, j * TUILE);
        progres(++fait, nx * ny);
      }
    }
  } finally {
    hors.remove();
    div.remove();
  }
}

// --- Habillage PDF (vectoriel) -------------------------------------------------------

function habillagePdf(doc: jsPDF, r: Reglages, g: ReturnType<typeof gabarit>, solW: number, legende: ElementLegende[], site: string, lat: number, cam: Camera3D | null = null): void {
  const x0 = g.marge;
  const y0 = g.marge;
  const f = Math.max(1, Math.min(g.w, g.h) / 210); // facteur de taille des textes
  doc.setDrawColor(40);
  doc.setLineWidth(0.3 * f);
  doc.rect(x0, y0, g.carteW, g.carteH);

  // Vue en perspective : flèche du nord au centre de l'image, ni nord solaire ni échelle.
  if (cam) {
    const R = 6 * f;
    const cx = x0 + g.carteW - R - 4 * f, cy = y0 + R + 4 * f;
    const a = (-cam.bearing * Math.PI) / 180;
    const rot = (x: number, y: number): [number, number] => [cx + x * Math.cos(a) - y * Math.sin(a), cy + x * Math.sin(a) + y * Math.cos(a)];
    const [p1, p2, p3, p4] = [rot(0, -R), rot(R * 0.38, R * 0.55), rot(0, R * 0.25), rot(-R * 0.38, R * 0.55)];
    doc.setFillColor(29, 29, 31);
    doc.setDrawColor(29, 29, 31);
    doc.setLineWidth(0.25 * f);
    doc.triangle(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1], "F");
    doc.triangle(p1[0], p1[1], p3[0], p3[1], p4[0], p4[1], "S");
    const [nx, ny] = rot(0, -R - 2.2 * f);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7 * f);
    doc.setTextColor(29, 29, 31);
    doc.text("N", nx, ny + 1 * f, { align: "center" });
    doc.setLineWidth(0.3 * f);
    doc.setDrawColor(40);
  }
  // Nord solaire (haut droit de la carte), calculé pour la latitude du site.
  if (!cam) {
    const R = 8 * f;
    const [ga, ha, dr, ba] = encombrement(R);
    const cx = x0 + g.carteW - dr - 2.5 * f;
    const cy = y0 + ha + 2.5 * f;
    // Sans fond, en mode produit : seul le trait noir est posé sur la carte.
    void ga; void ba;
    doc.setDrawColor(29, 29, 31);
    doc.setFillColor(29, 29, 31);
    doc.setTextColor(29, 29, 31);
    for (const p of nordSolaire(lat, R)) {
      if (p.t === "ligne") {
        doc.setLineWidth(p.e);
        const pts = p.ferme ? [...p.pts, p.pts[0]] : p.pts;
        for (let i = 1; i < pts.length; i++) doc.line(cx + pts[i - 1][0], cy + pts[i - 1][1], cx + pts[i][0], cy + pts[i][1]);
      } else if (p.t === "plein") {
        const [a, b, c] = p.pts;
        doc.triangle(cx + a[0], cy + a[1], cx + b[0], cy + b[1], cx + c[0], cy + c[1], "F");
      } else if (p.t === "disque") doc.circle(cx + p.x, cy + p.y, p.r, "F");
      else {
        doc.setFont("helvetica", p.gras ? "bold" : "normal");
        doc.setFontSize(p.taille / 0.3528);
        doc.text(p.s, cx + p.x, cy + p.y, { align: p.align });
      }
    }
    doc.setLineWidth(0.3 * f);
    doc.setDrawColor(40);
  }

  // Échelle graphique (bas gauche de la carte)
  const mParMm = r.echelle / 1000;
  const L = longueurRonde((g.carteW * 0.22) * mParMm);
  const lmm = L / mParMm;
  const sx = x0 + 5 * f;
  const sy = y0 + g.carteH - 7 * f;
  if (!cam) {
  // Sans fond, en mode produit : cases noires pleines, cases claires en simple contour.
  doc.setDrawColor(29, 29, 31);
  doc.setFillColor(29, 29, 31);
  doc.setLineWidth(0.2 * f);
  for (let k = 0; k < 4; k++) doc.rect(sx + (k * lmm) / 4, sy - 1.2 * f, lmm / 4, 1.6 * f, k % 2 === 0 ? "FD" : "S");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.5 * f);
  doc.text("0", sx, sy - 2.2 * f, { align: "center" });
  doc.text(`${L >= 1000 ? `${L / 1000} km` : `${L} m`}`, sx + lmm, sy - 2.2 * f, { align: "center" });
  doc.text(`1/${r.echelle.toLocaleString("fr-FR").replace(/ | /g, " ")}`, sx + lmm + 4 * f, sy + 0.4 * f);
  }

  // Bandeau : cartouche à gauche, légende à droite
  const by = y0 + g.carteH + g.marge / 2;
  const bh = g.bandeau;
  doc.setLineWidth(0.2 * f);
  doc.line(x0, by, x0 + g.carteW, by);
  const colCart = g.carteW * 0.42;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11 * f);
  const titre = doc.splitTextToSize(r.titre || "Plan", colCart - 4 * f).slice(0, 2) as string[];
  doc.text(titre, x0, by + 6 * f);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5 * f);
  doc.setTextColor(72, 72, 77);
  const nomFormat = r.format === "libre" ? `${g.w} × ${g.h} mm` : `${r.format} ${r.paysage ? "paysage" : "portrait"}`;
  const lignes = (cam
    ? [site, `Vue en perspective, sans échelle · ${nomFormat} · focale ${cam.focale} mm · inclinaison ${Math.round(cam.pitch)}°`, `Édité le ${new Date().toLocaleDateString("fr-FR")}`]
    : [
        site,
        `Échelle 1/${r.echelle} · ${nomFormat} · emprise ${Math.round(solW)} m de large`,
        `Édité le ${new Date().toLocaleDateString("fr-FR")} · Lambert-93 / Web Mercator, nord en haut, heures solaires`,
      ]
  ).filter(Boolean);
  doc.text(lignes.flatMap((l) => doc.splitTextToSize(l, colCart - 4 * f)).slice(0, 3), x0, by + (titre.length > 1 ? 15 : 11.5) * f, { lineHeightFactor: 1.3 });
  doc.setFontSize(5.8 * f);
  doc.setTextColor(110, 110, 115);
  const sources = `Sources : ${[...new Set(legende.map((l) => l.source))].join(" · ")}. Diagnostic de site, données ouvertes.`;
  doc.text(doc.splitTextToSize(sources, colCart - 4 * f).slice(0, 2), x0, by + bh - 4 * f);

  // Légende en colonnes
  const lx0 = x0 + colCart + 4 * f;
  const lw = g.carteW - colCart - 4 * f;
  const nCol = lw > 160 * f ? 3 : 2;
  const cw = lw / nCol;
  let col = 0;
  let ly = by + 5 * f;
  const pas = 3.6 * f;
  doc.setTextColor(29, 29, 31);
  for (const el of legende) {
    const hauteur = pas * (1 + (el.pastilles ? Math.ceil(el.pastilles.length / 2) : 0));
    if (ly + hauteur > by + bh - 1 * f) {
      col++;
      ly = by + 5 * f;
      if (col >= nCol) break;
    }
    const lx = lx0 + col * cw;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.8 * f);
    doc.text(doc.splitTextToSize(el.titre, cw - 3 * f)[0], lx, ly);
    ly += pas;
    if (el.pastilles) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6 * f);
      el.pastilles.forEach((p, k) => {
        const px = lx + (k % 2) * (cw / 2);
        const py = ly + Math.floor(k / 2) * pas;
        doc.setFillColor(p.couleur);
        // Liseré gris fin : une pastille blanche (bâti neutre) reste visible.
        doc.setDrawColor(160, 160, 160);
        doc.setLineWidth(0.1);
        doc.rect(px, py - 2.4 * f, 3 * f, 2.4 * f, "FD");
        doc.text(doc.splitTextToSize(p.libelle, cw / 2 - 5 * f)[0], px + 4 * f, py - 0.3 * f);
      });
      ly += Math.ceil(el.pastilles.length / 2) * pas;
    }
  }
}

// --- Habillage PNG (canevas) ------------------------------------------------------------

function habillageCanvas(ctx: CanvasRenderingContext2D, r: Reglages, g: ReturnType<typeof gabarit>, pxParMm: number, solW: number, legende: ElementLegende[], site: string, lat: number, cam: Camera3D | null = null): void {
  const mm = (v: number) => v * pxParMm;
  const f = Math.max(1, Math.min(g.w, g.h) / 210);
  const x0 = mm(g.marge);
  const y0 = mm(g.marge);
  ctx.strokeStyle = "#28282a";
  ctx.lineWidth = mm(0.3 * f);
  ctx.strokeRect(x0, y0, mm(g.carteW), mm(g.carteH));
  const police = (taille: number, gras = false) => `${gras ? "600 " : ""}${mm(taille * 0.3528 * f)}px -apple-system, "Helvetica Neue", Arial, sans-serif`;

  // Vue en perspective : flèche du nord au centre de l'image.
  if (cam) {
    const R = mm(6 * f);
    const cx = x0 + mm(g.carteW) - R - mm(4 * f), cy = y0 + R + mm(4 * f);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((-cam.bearing * Math.PI) / 180);
    ctx.fillStyle = ctx.strokeStyle = "#1d1d1f";
    ctx.lineWidth = mm(0.25 * f);
    ctx.beginPath(); ctx.moveTo(0, -R); ctx.lineTo(R * 0.38, R * 0.55); ctx.lineTo(0, R * 0.25); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, -R); ctx.lineTo(0, R * 0.25); ctx.lineTo(-R * 0.38, R * 0.55); ctx.closePath(); ctx.stroke();
    ctx.font = police(7, true); ctx.textAlign = "center";
    ctx.fillText("N", 0, -R - mm(1.2 * f));
    ctx.restore();
  }
  // Nord solaire
  if (!cam) {
    const R = 8 * f;
    const [ga, ha, dr, ba] = encombrement(R);
    const cx = x0 + mm(g.carteW - dr - 2.5 * f);
    const cy = y0 + mm(ha + 2.5 * f);
    // Sans fond, en mode produit.
    void ga; void ba;
    ctx.strokeStyle = ctx.fillStyle = "#1d1d1f";
    ctx.lineCap = ctx.lineJoin = "round";
    for (const p of nordSolaire(lat, R)) {
      if (p.t === "ligne" || p.t === "plein") {
        ctx.beginPath();
        p.pts.forEach(([x, y], i) => (i ? ctx.lineTo(cx + mm(x), cy + mm(y)) : ctx.moveTo(cx + mm(x), cy + mm(y))));
        if (p.t === "plein") {
          ctx.closePath();
          ctx.fill();
        } else {
          if (p.ferme) ctx.closePath();
          ctx.lineWidth = mm(p.e);
          ctx.stroke();
        }
      } else if (p.t === "disque") {
        ctx.beginPath();
        ctx.arc(cx + mm(p.x), cy + mm(p.y), mm(p.r), 0, 2 * Math.PI);
        ctx.fill();
      } else {
        ctx.font = `${p.gras ? "600 " : ""}${mm(p.taille)}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
        ctx.textAlign = p.align;
        ctx.fillText(p.s, cx + mm(p.x), cy + mm(p.y));
      }
    }
    ctx.strokeStyle = "#28282a";
    ctx.lineWidth = mm(0.3 * f);
  }

  // Échelle graphique
  const mParMm = r.echelle / 1000;
  const L = longueurRonde(g.carteW * 0.22 * mParMm);
  const lmm = L / mParMm;
  const sx = x0 + mm(5 * f);
  const sy = y0 + mm(g.carteH - 7 * f);
  if (!cam) {
  // Sans fond, en mode produit : cases noires pleines, cases claires en simple contour.
  ctx.strokeStyle = ctx.fillStyle = "#1d1d1f"; ctx.lineWidth = mm(0.2 * f);
  for (let k = 0; k < 4; k++) {
    if (k % 2 === 0) ctx.fillRect(sx + mm((k * lmm) / 4), sy - mm(1.2 * f), mm(lmm / 4), mm(1.6 * f));
    ctx.strokeRect(sx + mm((k * lmm) / 4), sy - mm(1.2 * f), mm(lmm / 4), mm(1.6 * f));
  }
  ctx.fillStyle = "#1d1d1f"; ctx.font = police(6.5);
  ctx.fillText("0", sx, sy - mm(2.2 * f));
  ctx.fillText(L >= 1000 ? `${L / 1000} km` : `${L} m`, sx + mm(lmm), sy - mm(2.2 * f));
  ctx.textAlign = "left";
  ctx.fillText(`1/${r.echelle}`, sx + mm(lmm + 4 * f), sy + mm(0.4 * f));
  }

  // Bandeau (cartouche à gauche, légende à droite ; textes coupés à leur colonne).
  const by = y0 + mm(g.carteH + g.marge / 2);
  const colCart = g.carteW * 0.42;
  const largCart = mm(colCart - 4 * f);
  /** Découpe un texte en lignes tenant dans `larg` px (police courante). */
  const couper = (t: string, larg: number): string[] => {
    const lignes: string[] = [];
    let cour = "";
    for (const mot of t.split(" ")) {
      const essai = cour ? `${cour} ${mot}` : mot;
      if (ctx.measureText(essai).width > larg && cour) {
        lignes.push(cour);
        cour = mot;
      } else cour = essai;
    }
    if (cour) lignes.push(cour);
    return lignes;
  };
  /** Une seule ligne : tronquée avec « … » si besoin. */
  const tenir = (t: string, larg: number): string => {
    if (ctx.measureText(t).width <= larg) return t;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > larg) t = t.slice(0, -1);
    return `${t}…`;
  };
  ctx.textAlign = "left";
  ctx.fillStyle = "#1d1d1f"; ctx.font = police(11, true);
  const titre = couper(r.titre || "Plan", largCart).slice(0, 2);
  titre.forEach((l, k) => ctx.fillText(l, x0, by + mm((6 + k * 4.6) * f)));
  ctx.font = police(7.5); ctx.fillStyle = "#48484d";
  const nomFormat = r.format === "libre" ? `${g.w} × ${g.h} mm` : `${r.format} ${r.paysage ? "paysage" : "portrait"}`;
  const debut = titre.length > 1 ? 15 : 11.5;
  (cam
    ? [site, `Vue en perspective, sans échelle · ${nomFormat} · focale ${cam.focale} mm · inclinaison ${Math.round(cam.pitch)}°`, `Édité le ${new Date().toLocaleDateString("fr-FR")}`]
    : [site, `Échelle 1/${r.echelle} · ${nomFormat} · emprise ${Math.round(solW)} m de large`, `Édité le ${new Date().toLocaleDateString("fr-FR")} · nord en haut`])
    .filter(Boolean)
    .slice(0, 3)
    .forEach((l, k) => ctx.fillText(tenir(l, largCart), x0, by + mm((debut + k * 3.4) * f)));
  ctx.font = police(5.8); ctx.fillStyle = "#6e6e73";
  couper(`Sources : ${[...new Set(legende.map((l) => l.source))].join(" · ")}`, largCart)
    .slice(0, 2)
    .forEach((l, k, t) => ctx.fillText(l, x0, by + mm(g.bandeau - (4 + (t.length - 1 - k) * 2.4) * f)));

  const lw = g.carteW - colCart - 4 * f;
  const nCol = lw > 160 * f ? 3 : 2;
  const colW = mm(lw / nCol);
  const pas = mm(3.6 * f);
  const haut0 = by + mm(5 * f), bas = by + mm(g.bandeau - 1 * f);
  let col = 0;
  let ly = haut0;
  for (const el of legende) {
    const hauteur = pas * (1 + (el.pastilles ? Math.ceil(el.pastilles.length / 2) : 0));
    if (ly + hauteur > bas) {
      col++;
      ly = haut0;
      if (col >= nCol) break;
    }
    const lx = x0 + mm(colCart + 4 * f) + col * colW;
    ctx.fillStyle = "#1d1d1f"; ctx.font = police(6.8, true);
    ctx.fillText(tenir(el.titre, colW - mm(3 * f)), lx, ly);
    ly += pas;
    if (el.pastilles) {
      ctx.font = police(6);
      el.pastilles.forEach((p, k) => {
        const px = lx + (k % 2) * (colW / 2);
        const py = ly + Math.floor(k / 2) * pas;
        ctx.fillStyle = p.couleur; ctx.fillRect(px, py - mm(2.4 * f), mm(3 * f), mm(2.4 * f));
        ctx.strokeStyle = "#a0a0a0"; ctx.lineWidth = Math.max(1, mm(0.1)); ctx.strokeRect(px, py - mm(2.4 * f), mm(3 * f), mm(2.4 * f));
        ctx.fillStyle = "#1d1d1f"; ctx.fillText(tenir(p.libelle, colW / 2 - mm(5 * f)), px + mm(4 * f), py - mm(0.3 * f));
      });
      ly += Math.ceil(el.pastilles.length / 2) * pas;
    }
  }
}

// --- Cadrages enregistrés -------------------------------------------------------------
// Comme les vues de l'atelier : format, orientation, échelle, résolution,
// titre et position du cadre, rappelés d'un clic. Stockés dans ce navigateur.

interface Cadrage extends Reglages {
  nom: string;
  /** Centre de la vue (la feuille entière y est centrée). */
  centre: [number, number];
  /** Vue en perspective : zoom, inclinaison et orientation de la caméra. */
  camera?: { zoom: number; pitch: number; bearing: number };
}
const CLE_CADRAGES = "atelier:cadrages";
function lireCadrages(): Cadrage[] {
  try {
    const v = JSON.parse(localStorage.getItem(CLE_CADRAGES) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((c: Cadrage) => c && typeof c.nom === "string" && Array.isArray(c.centre) && typeof c.echelle === "number") : [];
  } catch {
    return [];
  }
}
function ecrireCadrages(c: Cadrage[]): void {
  try {
    localStorage.setItem(CLE_CADRAGES, JSON.stringify(c));
  } catch {
    /* stockage indisponible : valables pour la session */
  }
}

// --- Interface --------------------------------------------------------------------------

export function brancherMiseEnPage(o: OptionsMiseEnPage): void {
  const { map, carte } = o;
  const r: Reglages = { format: "A3", libre: [500, 700], paysage: true, echelle: 2000, dpi: 150, titre: "" };

  const bouton = document.createElement("button");
  bouton.type = "button";
  bouton.className = "mp-bouton";
  bouton.textContent = "Mise en page";
  carte.appendChild(bouton);

  const panneau = document.createElement("div");
  panneau.className = "mp-panneau m3d-panel";
  panneau.hidden = true;
  panneau.innerHTML = `
    <div class="mp-tete"><strong>Mise en page</strong>
      <button type="button" class="icon-btn mp-fermer" aria-label="Fermer la mise en page">✕</button></div>
    <div class="mp-champ"><span>Cadrages enregistrés</span>
      <div class="mp-cadrages"></div>
      <button type="button" class="mp-enregistrer">Enregistrer ce cadrage</button></div>
    <label class="mp-champ"><span>Titre</span><input type="text" class="mp-titre" maxlength="90" placeholder="Plan de situation"></label>
    <div class="mp-champ"><span>Vue</span>
      <div class="segmented seg-sm" role="group" aria-label="Type de vue">
        <button type="button" data-vue="plan" aria-pressed="true" title="Plan à l'échelle, nord en haut">Plan à l'échelle</button>
        <button type="button" data-vue="3d" aria-pressed="false" title="Vue 3D en perspective, cadrée à l'écran, sans échelle">Perspective 3D</button>
      </div></div>
    <div class="mp-champ"><span>Format</span>
      <div class="segmented seg-sm mp-formats" role="group" aria-label="Format">
        ${[...Object.keys(FORMATS), "libre"].map((k) => `<button type="button" data-format="${k}" aria-pressed="${k === r.format}">${k === "libre" ? "Libre" : k}</button>`).join("")}
      </div></div>
    <div class="mp-champ mp-libre" hidden><span>Format libre (mm)</span>
      <span class="mp-ligne"><input type="number" class="mp-lw" min="50" max="5000" step="10" value="${r.libre[0]}" aria-label="Largeur en millimètres"> ×
      <input type="number" class="mp-lh" min="50" max="5000" step="10" value="${r.libre[1]}" aria-label="Hauteur en millimètres"></span></div>
    <div class="mp-champ"><span>Orientation</span>
      <div class="segmented seg-sm" role="group" aria-label="Orientation">
        <button type="button" data-orient="portrait" aria-pressed="false">Portrait</button>
        <button type="button" data-orient="paysage" aria-pressed="true">Paysage</button>
      </div></div>
    <div class="mp-champ mp-ch-echelle"><span>Échelle</span>
      <span class="mp-ligne"><span class="mp-un">1 /</span><input type="number" class="mp-echelle" min="100" max="500000" step="100" value="${r.echelle}" aria-label="Dénominateur d'échelle"></span>
      <span class="mp-presets">${[500, 1000, 2000, 5000, 10000].map((v) => `<button type="button" data-ech="${v}">1/${v}</button>`).join("")}</span></div>
    <div class="mp-champ"><span>Résolution</span>
      <div class="segmented seg-sm" role="group" aria-label="Résolution">
        <button type="button" data-dpi="150" aria-pressed="true">150 dpi</button>
        <button type="button" data-dpi="300" aria-pressed="false">300 dpi</button>
      </div></div>
    <p class="mp-info" aria-live="polite"></p>
    <div class="mp-actions">
      <button type="button" class="btn-primary mp-pdf">Exporter en PDF</button>
      <button type="button" class="btn-secondary mp-png">PNG</button>
    </div>
    <div class="mp-actions mp-actions-svg">
      <button type="button" class="btn-secondary mp-svg" title="Un seul fichier : un groupe par couche, vecteurs et images calées, à l'échelle (Illustrator, Inkscape)">SVG à calques</button>
      <button type="button" class="btn-secondary mp-zip" title="Archive ZIP : un SVG par couche, tous à la même page, à superposer">Un SVG par calque</button>
    </div>
    <p class="mp-etat" aria-live="polite"></p>`;
  carte.appendChild(panneau);
  const q = <T extends HTMLElement>(s: string) => panneau.querySelector<T>(s)!;

  const centreCarte = () => centreZoneCarte(r, map.getCenter());

  // Vue en perspective : le cadre est une fenêtre à l'écran, aux proportions de la zone carte.
  const cadre3d = document.createElement("div");
  cadre3d.className = "mp-cadre3d";
  cadre3d.hidden = true;
  carte.appendChild(cadre3d);
  /** Fenêtre de la planche 3D, en pixels CSS dans la toile de la carte. */
  function rectCadre3D(): { x: number; y: number; w: number; h: number } {
    const g = gabarit(r);
    const m = margesVisibles();
    const W = map.getCanvas().clientWidth, H = map.getCanvas().clientHeight;
    const dispoW = (W - m.left - m.right) * 0.94, dispoH = (H - m.top - m.bottom) * 0.94;
    const a = g.carteW / g.carteH;
    const w = Math.min(dispoW, dispoH * a), h = w / a;
    return { x: m.left + (W - m.left - m.right - w) / 2, y: m.top + (H - m.top - m.bottom - h) / 2, w, h };
  }
  const majCadre = () => {
    if (r.vue === "3d") {
      const c = rectCadre3D();
      Object.assign(cadre3d.style, { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px`, height: `${c.h}px` });
      cadre3d.hidden = panneau.hidden;
      if (map.getLayer("cadre-ligne")) for (const id of COUCHES_CADRE) map.setLayoutProperty(id, "visibility", "none");
      const g = gabarit(r);
      q<HTMLElement>(".mp-info").textContent =
        `Feuille ${g.w} × ${g.h} mm · carte ${Math.round(g.carteW)} × ${Math.round(g.carteH)} mm. ` +
        `Vue en perspective : pas d'échelle. Cadrez dans la fenêtre (clic droit ou Ctrl + glisser pour incliner et tourner).`;
      return;
    }
    cadre3d.hidden = true;
    if (!panneau.hidden && map.getLayer("cadre-ligne")) for (const id of COUCHES_CADRE) map.setLayoutProperty(id, "visibility", "visible");
    const src = map.getSource("cadre") as maplibregl.GeoJSONSource | undefined;
    src?.setData(polygoneCadre(r, centreCarte()));
    const g = gabarit(r);
    const e = emprise(r, centreCarte());
    const px = Math.round((g.w / 25.4) * r.dpi) * Math.round((g.h / 25.4) * r.dpi);
    q<HTMLElement>(".mp-info").textContent =
      `Feuille ${g.w} × ${g.h} mm · carte ${Math.round(g.carteW)} × ${Math.round(g.carteH)} mm, ` +
      `soit ${Math.round(e.solW)} × ${Math.round(e.solH)} m au sol. ` +
      `Image ${(px / 1e6).toFixed(0)} Mpx${px > 60e6 ? " : export long, préférez 150 dpi" : ""}. Déplacez la carte pour placer le cadre.`;
  };

  const margesVisibles = () =>
    window.matchMedia("(max-width: 800px)").matches
      ? { top: 70, left: 12, right: 12, bottom: Math.round(carte.clientHeight * 0.62) + 12 }
      : { top: 70, left: 24, right: 380, bottom: 40 };

  /** Zoom pour voir toute la feuille autour du centre de la vue. */
  function cadrer(): void {
    const f = empriseFeuille(r, centreCarte());
    const dx = (f.e - f.o) * 0.08, dy = (f.n - f.s) * 0.08;
    const [w, s] = merc2ll(f.o - dx, f.s - dy);
    const [est, n] = merc2ll(f.e + dx, f.n + dy);
    // Le panneau couvre la droite (ordinateur) ou le bas (téléphone) de la
    // carte : on décale le centre de la carte vers la partie visible, et le
    // cadre suit ce centre.
    map.setPadding(margesVisibles());
    map.fitBounds([[w, s], [est, n]], { duration: 400 });
    majCadre();
  }

  function ouvrir(v: boolean): void {
    panneau.hidden = !v;
    bouton.hidden = v;
    if (v) {
      if (!map.getSource("cadre")) {
        map.addSource("cadre", { type: "geojson", data: polygoneCadre(r, centreCarte()) });
        map.addLayer({ id: "cadre-masque", type: "fill", source: "cadre", filter: ["==", ["get", "role"], "masque"], paint: { "fill-color": "#1d1d1f", "fill-opacity": 0.32, "fill-antialias": false } });
        map.addLayer({ id: "cadre-papier", type: "fill", source: "cadre", filter: ["==", ["get", "role"], "papier"], paint: { "fill-color": "#ffffff", "fill-opacity": 0.7, "fill-antialias": false } });
        map.addLayer({ id: "cadre-bandeau", type: "fill", source: "cadre", filter: ["==", ["get", "role"], "bandeau"], paint: { "fill-color": "#f4f2ee", "fill-opacity": 0.92 } });
        map.addLayer({ id: "cadre-page", type: "line", source: "cadre", filter: ["==", ["get", "role"], "page"], paint: { "line-color": "#1d1d1f", "line-width": 1.5 } });
        map.addLayer({ id: "cadre-ligne", type: "line", source: "cadre", filter: ["==", ["get", "role"], "cadre"], paint: { "line-color": "#1d1d1f", "line-width": 1, "line-dasharray": [3, 2] } });
      }
      // Le panneau s'ouvre dans le mode de la carte : inclinée → perspective.
      if (map.getPitch() > 1) {
        r.vue = "3d";
        panneau.querySelectorAll("[data-vue]").forEach((x) => x.setAttribute("aria-pressed", String(x.getAttribute("data-vue") === "3d")));
        q<HTMLElement>(".mp-ch-echelle").hidden = true;
      }
      if (r.vue === "3d") o.passer3D();
      else {
        for (const id of COUCHES_CADRE) map.setLayoutProperty(id, "visibility", "visible");
        // Vue imprimée : nord en haut, sans inclinaison.
        o.passer2D();
        map.easeTo({ pitch: 0, bearing: 0, duration: 400 });
      }
      // Titre par défaut : repris à l'export si le site n'est pas encore chargé.
      const siteActuel = o.site();
      if (!r.titre && siteActuel) {
        r.titre = `Plan de situation — ${siteActuel.label}`;
        q<HTMLInputElement>(".mp-titre").value = r.titre;
      }
      if (r.vue === "3d") {
        map.setPadding(margesVisibles());
        majCadre();
      } else cadrer();
    } else {
      cadre3d.hidden = true;
      if (map.getLayer("cadre-ligne")) for (const id of COUCHES_CADRE) map.setLayoutProperty(id, "visibility", "none");
      map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    }
  }
  bouton.addEventListener("click", () => ouvrir(true));
  q<HTMLButtonElement>(".mp-fermer").addEventListener("click", () => ouvrir(false));
  map.on("move", () => { if (!panneau.hidden) majCadre(); });
  map.on("resize", () => { if (!panneau.hidden) majCadre(); });

  const segment = (attr: string, f: (v: string) => void) =>
    panneau.querySelectorAll<HTMLButtonElement>(`[${attr}]`).forEach((b) =>
      b.addEventListener("click", () => {
        panneau.querySelectorAll(`[${attr}]`).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        f(b.getAttribute(attr)!);
        majCadre();
      }),
    );
  segment("data-format", (v) => {
    r.format = v as NomFormat;
    q<HTMLElement>(".mp-libre").hidden = v !== "libre";
  });
  segment("data-orient", (v) => (r.paysage = v === "paysage"));
  /** Change le type de vue ; `basculer` : met aussi la carte en 2D ou en 3D. */
  function choisirVue(v: "plan" | "3d", basculer: boolean): void {
    r.vue = v;
    panneau.querySelectorAll("[data-vue]").forEach((x) => x.setAttribute("aria-pressed", String(x.getAttribute("data-vue") === v)));
    q<HTMLElement>(".mp-ch-echelle").hidden = v === "3d";
    if (basculer) {
      if (v === "3d") o.passer3D();
      else {
        o.passer2D();
        map.easeTo({ pitch: 0, bearing: 0, duration: 400 });
        setTimeout(cadrer, 450);
      }
    }
    majCadre();
  }
  segment("data-vue", (v) => choisirVue(v as "plan" | "3d", true));
  // Le panneau suit la carte (retours du 24/11) : carte inclinée (bouton 3D de
  // l'atelier, clic droit) → perspective ; carte remise à plat → plan à l'échelle.
  map.on("pitchend", () => {
    if (panneau.hidden) return;
    const incline = map.getPitch() > 1;
    if (incline && r.vue !== "3d") choisirVue("3d", false);
    else if (!incline && r.vue === "3d") {
      choisirVue("plan", false);
      cadrer();
    }
  });
  segment("data-dpi", (v) => (r.dpi = Number(v)));
  panneau.querySelectorAll<HTMLButtonElement>("[data-ech]").forEach((b) =>
    b.addEventListener("click", () => {
      r.echelle = Number(b.dataset.ech);
      q<HTMLInputElement>(".mp-echelle").value = String(r.echelle);
      majCadre();
    }),
  );
  q<HTMLInputElement>(".mp-echelle").addEventListener("input", (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    if (v >= 100 && v <= 500000) { r.echelle = Math.round(v); majCadre(); }
  });
  for (const [cls, k] of [[".mp-lw", 0], [".mp-lh", 1]] as const) {
    q<HTMLInputElement>(cls).addEventListener("input", (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (v >= 50 && v <= 5000) { r.libre[k] = v; majCadre(); }
    });
  }
  q<HTMLInputElement>(".mp-titre").addEventListener("input", (e) => (r.titre = (e.target as HTMLInputElement).value));

  // --- Cadrages enregistrés ------------------------------------------------
  let cadrages = lireCadrages();
  /** Recopie les réglages dans le panneau (boutons, champs). */
  function majPanneau(): void {
    const presser = (attr: string, val: string) =>
      panneau.querySelectorAll(`[${attr}]`).forEach((x) => x.setAttribute("aria-pressed", String(x.getAttribute(attr) === val)));
    presser("data-format", r.format);
    presser("data-orient", r.paysage ? "paysage" : "portrait");
    presser("data-dpi", String(r.dpi));
    presser("data-vue", r.vue ?? "plan");
    q<HTMLElement>(".mp-ch-echelle").hidden = r.vue === "3d";
    q<HTMLElement>(".mp-libre").hidden = r.format !== "libre";
    q<HTMLInputElement>(".mp-lw").value = String(r.libre[0]);
    q<HTMLInputElement>(".mp-lh").value = String(r.libre[1]);
    q<HTMLInputElement>(".mp-echelle").value = String(r.echelle);
    q<HTMLInputElement>(".mp-titre").value = r.titre;
  }
  function majCadrages(): void {
    const zone = q<HTMLElement>(".mp-cadrages");
    zone.hidden = !cadrages.length;
    zone.innerHTML = cadrages
      .map(
        (c, i) => `<span class="mp-cadrage"><button type="button" data-cadrage="${i}" title="${c.format === "libre" ? `${c.libre[0]} × ${c.libre[1]} mm` : `${c.format} ${c.paysage ? "paysage" : "portrait"}`} · ${c.vue === "3d" ? "perspective 3D" : `1/${c.echelle}`}">${c.nom.replace(/[&<>"]/g, (m) => `&#${m.charCodeAt(0)};`)}</button><button type="button" class="mp-suppr" data-suppr="${i}" aria-label="Supprimer le cadrage ${c.nom.replace(/[&<>"]/g, "")}">✕</button></span>`,
      )
      .join("");
    zone.querySelectorAll<HTMLButtonElement>("[data-cadrage]").forEach((b) =>
      b.addEventListener("click", () => {
        const c = cadrages[Number(b.dataset.cadrage)];
        Object.assign(r, { format: c.format, libre: [...c.libre] as [number, number], paysage: c.paysage, echelle: c.echelle, dpi: c.dpi, titre: c.titre, vue: c.vue ?? "plan" });
        majPanneau();
        if (r.vue === "3d" && c.camera) {
          o.passer3D();
          // Après la bascule en 3D (qui anime la caméra), on pose la caméra enregistrée.
          setTimeout(() => {
            map.jumpTo({ center: c.centre, zoom: c.camera!.zoom, pitch: c.camera!.pitch, bearing: c.camera!.bearing });
            majCadre();
          }, 650);
        } else {
          o.passer2D();
          map.jumpTo({ center: c.centre, pitch: 0, bearing: 0 });
          cadrer();
        }
        q<HTMLElement>(".mp-etat").textContent = `Cadrage « ${c.nom} » rappelé.`;
      }),
    );
    zone.querySelectorAll<HTMLButtonElement>("[data-suppr]").forEach((b) =>
      b.addEventListener("click", () => {
        cadrages.splice(Number(b.dataset.suppr), 1);
        ecrireCadrages(cadrages);
        majCadrages();
      }),
    );
  }
  q<HTMLButtonElement>(".mp-enregistrer").addEventListener("click", () => {
    const defaut = `${r.titre.replace(/^Plan de situation — /, "") || "Cadrage"} · ${r.vue === "3d" ? "3D" : `1/${r.echelle}`}`;
    const nom = window.prompt("Nom du cadrage", defaut)?.trim();
    if (!nom) return;
    const c = map.getCenter();
    const nouveau: Cadrage = {
      ...r,
      libre: [...r.libre] as [number, number],
      nom,
      centre: [c.lng, c.lat],
      camera: r.vue === "3d" ? { zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() } : undefined,
    };
    const k = cadrages.findIndex((x) => x.nom === nom);
    if (k >= 0) cadrages[k] = nouveau;
    else cadrages.push(nouveau);
    ecrireCadrages(cadrages);
    majCadrages();
    q<HTMLElement>(".mp-etat").textContent = `Cadrage « ${nom} » enregistré dans ce navigateur.`;
  });
  majCadrages();

  // --- Export ---------------------------------------------------------------
  const etat = q<HTMLElement>(".mp-etat");
  const boutons = [q<HTMLButtonElement>(".mp-pdf"), q<HTMLButtonElement>(".mp-png"), q<HTMLButtonElement>(".mp-svg"), q<HTMLButtonElement>(".mp-zip")];
  const nomFichier = (ext: string) =>
    `${(r.titre || "plan").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "plan"}_1-${r.echelle}.${ext}`;

  /**
   * Capture de la vue 3D : la carte est rendue le temps de la capture à une
   * résolution plus forte (même cadrage à l'écran), puis la fenêtre du cadre
   * est découpée dans la toile. Résolution plafonnée par la carte graphique
   * (8192 px de côté) : la résolution obtenue est indiquée.
   */
  async function capturer3D(pxW: number): Promise<{ img: HTMLCanvasElement; dpiObtenu: number }> {
    const fr = rectCadre3D();
    const toile = map.getCanvas();
    const ancien = map.getPixelRatio();
    cadre3d.hidden = true;
    map.setPixelRatio(Math.max(ancien, pxW / fr.w));
    try {
      await new Promise<void>((ok) => {
        const t = setTimeout(ok, 30_000); // ne bloque pas sur une tuile perdue
        map.once("idle", () => {
          clearTimeout(t);
          ok();
        });
        map.triggerRepaint();
      });
      // Une image de plus pour que les couches three.js soient dessinées à la nouvelle taille.
      await new Promise<void>((ok) => {
        map.once("render", () => requestAnimationFrame(() => ok()));
        map.triggerRepaint();
      });
      const k = toile.width / toile.clientWidth; // résolution réellement obtenue (plafonnée)
      const img = document.createElement("canvas");
      img.width = Math.round(fr.w * k);
      img.height = Math.round(fr.h * k);
      img.getContext("2d")!.drawImage(toile, fr.x * k, fr.y * k, fr.w * k, fr.h * k, 0, 0, img.width, img.height);
      const g = gabarit(r);
      return { img, dpiObtenu: Math.round((img.width / g.carteW) * 25.4) };
    } finally {
      map.setPixelRatio(ancien);
      cadre3d.hidden = panneau.hidden || r.vue !== "3d";
    }
  }

  async function exporter(type: "pdf" | "png" | "svg" | "zip"): Promise<void> {
    const g = gabarit(r);
    const centre = centreCarte();
    const e = emprise(r, centre);
    const legende = o.legende();
    const site = o.site()?.label ?? "";
    // Latitude du nord solaire : celle du site, sinon le centre de la carte.
    const lat = o.site()?.lat ?? o.map.getCenter().lat;
    if (!r.titre) r.titre = site ? `Plan de situation — ${site}` : "Plan de situation";
    let dpi = r.dpi;
    if (type === "png") {
      // Une seule image : on reste sous la limite de Safari.
      const pxPage = (g.w / 25.4) * (g.h / 25.4) * dpi * dpi;
      if (pxPage > PNG_MAX_PX) dpi = Math.floor(Math.sqrt(PNG_MAX_PX / ((g.w / 25.4) * (g.h / 25.4))));
    }
    const pxParMm = dpi / 25.4;
    const pxW = Math.round(g.carteW * pxParMm);
    const pxH = Math.round(g.carteH * pxParMm);
    boutons.forEach((b) => (b.disabled = true));
    // Vue en perspective : capture de la caméra, habillage sans échelle.
    const cam: Camera3D | null = r.vue === "3d" ? { pitch: map.getPitch(), bearing: map.getBearing(), focale: o.focale() } : null;
    try {
      let vue3d: HTMLCanvasElement | null = null;
      if (cam) {
        etat.textContent = "Rendu de la vue 3D…";
        const cap = await capturer3D(pxW);
        vue3d = cap.img;
        dpi = Math.min(dpi, cap.dpiObtenu);
      }
      if (type === "svg" || type === "zip") {
        const { exporterSvg } = await import("./svg-planche");
        const res = await exporterSvg({
          map, r, centre, legende, site, lat, cam, vue3d,
          arbres: o.arbres3d(),
          calque: o.calque ?? (() => null),
          progres: (t) => (etat.textContent = t),
          zip: type === "zip",
        });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(res.blob);
        a.download = nomFichier(res.ext);
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        etat.textContent = `Export ${res.ext === "zip" ? "ZIP (un SVG par calque)" : "SVG à calques"} terminé${res.note ? ` : ${res.note}` : ""}.`;
        return;
      }
      if (type === "pdf") {
        const doc = new jsPDF({ orientation: g.w > g.h ? "landscape" : "portrait", unit: "mm", format: [g.w, g.h], compress: true });
        if (vue3d) doc.addImage(vue3d.toDataURL("image/jpeg", 0.92), "JPEG", g.marge, g.marge, g.carteW, g.carteH, undefined, "FAST");
        else
          await rendre(o.arbres3d(), map, r, centre, pxW, pxH, (img, x, y) => {
            doc.addImage(img.toDataURL("image/jpeg", 0.9), "JPEG", g.marge + x / pxParMm, g.marge + y / pxParMm, img.width / pxParMm, img.height / pxParMm, undefined, "FAST");
          }, (f, t) => (etat.textContent = `Rendu de la carte : ${f}/${t}…`));
        habillagePdf(doc, r, g, e.solW, legende, site, lat, cam);
        doc.save(nomFichier("pdf"));
      } else {
        const c = document.createElement("canvas");
        c.width = Math.round(g.w * pxParMm);
        c.height = Math.round(g.h * pxParMm);
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        if (vue3d) {
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(vue3d, Math.round(g.marge * pxParMm), Math.round(g.marge * pxParMm), pxW, pxH);
        } else
          await rendre(o.arbres3d(), map, r, centre, pxW, pxH, (img, x, y) => ctx.drawImage(img, Math.round(g.marge * pxParMm) + x, Math.round(g.marge * pxParMm) + y),
            (f, t) => (etat.textContent = `Rendu de la carte : ${f}/${t}…`));
        habillageCanvas(ctx, r, g, pxParMm, e.solW, legende, site, lat, cam);
        const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/png"));
        if (!blob) throw new Error("image trop grande");
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = nomFichier("png");
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }
      etat.textContent = cam && dpi < r.dpi
        ? `Export terminé : vue 3D à ${dpi} dpi (plafond de la carte graphique ; ${r.dpi} dpi demandés).`
        : `Export terminé (${dpi} dpi).`;
    } catch (err) {
      etat.textContent = `Export impossible : ${(err as Error).message}. Essayez 150 dpi ou un format plus petit.`;
    } finally {
      boutons.forEach((b) => (b.disabled = false));
    }
  }
  boutons[0].addEventListener("click", () => void exporter("pdf"));
  boutons[1].addEventListener("click", () => void exporter("png"));
  boutons[2].addEventListener("click", () => void exporter("svg"));
  boutons[3].addEventListener("click", () => void exporter("zip"));
}
