// Export SVG à calques de la mise en page (Illustrator, Inkscape, Affinity).
//
// Document en millimètres (1 unité = 1 mm), carte à l'échelle saisie : un
// 1/2000 reste un 1/2000 à l'ouverture. Un groupe nommé par couche de
// l'atelier, dans l'ordre de dessin (du dessous au dessus) :
//   - vecteurs redessinés depuis les données (bâti, végétation, ombres,
//     arbres en points, isochrones, courbes, patrimoine, équipements,
//     carroyage, périmètre, coupe ; cadastre lu dans les tuiles vectorielles),
//     avec les couleurs, épaisseurs et pointillés de l'écran ;
//   - images calées sur le cadre pour ce qui reste raster (fonds IGN, Plan IGN
//     « Composé » thème par thème, photo, LiDAR, CoSIA, WMS, relief,
//     ensoleillement, arbres en volume) : un PNG transparent par couche ;
//   - l'habillage (cadre, nord solaire, échelle graphique, cartouche, légende)
//     en vecteurs et en texte modifiable.
// Variante ZIP : un SVG par calque, tous à la même page, à superposer.
//
// Épaisseurs, rayons et tailles de texte : ceux du rendu à 150 dpi (le PDF
// par défaut), soit 1 px = 25,4 / 150 mm.

import maplibregl from "maplibre-gl";
import { nordSolaire, encombrement } from "./nord-solaire";
import {
  gabarit, emprise, rendre, longueurRonde, ll2merc, MERC,
  type Reglages, type Camera3D, type ElementLegende,
} from "./mise-en-page";
import type { ArbreOsm } from "../modules/soleil/fetch";
import { gabaritArbre, arbresADessiner } from "./arbres3d";
import {
  eclater, typeDeBase, dansRect, KMM as KMM_HAB, n2, echapper, fabriqueIds, tracePolyligne, tracePolygone, ouvrirCalque, couleur, evaluateur, nombre,
  zipper, dessinerCouche, opa, type Pt, type Rect, type EntiteStyle, type EntitePage, type CoucheStyle,
} from "./svg-outils";

const DPI_REF = 150;
const MAX_PX_IMAGE = 16_000_000; // une image par calque raster : limite de Safari
const POLICE_HAB = "'Helvetica Neue', Helvetica, Arial, sans-serif";

export interface ContexteSvg {
  map: maplibregl.Map;
  r: Reglages;
  centre: maplibregl.LngLat;
  legende: ElementLegende[];
  site: string;
  lat: number;
  cam: Camera3D | null;
  vue3d: HTMLCanvasElement | null;
  arbres: { arbres: ArbreOsm[]; lat0: number; lon0: number } | null;
  /** Couche de l'atelier (calque) à laquelle appartient une couche de style. */
  calque(layerId: string): { cle: string; titre: string } | null;
  progres(t: string): void;
  zip: boolean;
}


interface Calque {
  cle: string;
  titre: string;
  genre: "vecteur" | "raster" | "arbres";
  couches: CoucheStyle[];
  /** Contenu SVG (sans le groupe englobant), ou parties (images en base64). */
  contenu: string[];
  note?: string;
}

const visible = (l: CoucheStyle) => (l.layout as { visibility?: string } | undefined)?.visibility !== "none";

async function enDataUrl(c: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/png"));
  if (!blob) throw new Error("image trop grande");
  return new Promise((ok, ko) => {
    const lecteur = new FileReader();
    lecteur.onload = () => ok(String(lecteur.result));
    lecteur.onerror = () => ko(lecteur.error);
    lecteur.readAsDataURL(blob);
  });
}

/** Une toile entièrement transparente ne vaut pas un calque. */
function vide(c: HTMLCanvasElement): boolean {
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4 * 7) if (d[i] > 2) return false;
  return true;
}

// --- Lecture des tuiles vectorielles (cadastre…) -------------------------------------------

interface MorceauTuile {
  f: maplibregl.GeoJSONFeature;
  /** Emprise de la tuile d'origine, en mètres Mercator. */
  tuile: { o: number; e: number; n: number; s: number };
}

/** Charge, sur une carte hors écran, les tuiles vectorielles couvrant l'emprise
 * et renvoie leurs entités morceau par morceau, avec la tuile d'origine
 * (pour couper chaque morceau à sa tuile : pas de faux traits aux raccords). */
async function lireTuiles(map: maplibregl.Map, couches: CoucheStyle[], centre: maplibregl.LngLat, ext: ReturnType<typeof emprise>, zoom: number, progres: (t: string) => void): Promise<Map<string, MorceauTuile[]>> {
  const style = map.getStyle();
  const ids = new Set(couches.map((c) => c.id));
  style.layers = style.layers.filter((l) => ids.has(l.id));
  delete (style as { terrain?: unknown }).terrain;
  const COTE = 2048;
  const div = document.createElement("div");
  div.style.cssText = `position:fixed;left:-${COTE * 2}px;top:0;width:${COTE}px;height:${COTE}px;pointer-events:none;`;
  document.body.appendChild(div);
  const hors = new maplibregl.Map({ container: div, style, center: centre, zoom, interactive: false, attributionControl: false, pixelRatio: 1, fadeDuration: 0 });
  const res = new Map<string, MorceauTuile[]>();
  const vus = new Set<string>();
  try {
    await new Promise<void>((ok) => hors.once("load", () => ok()));
    const mpp = MERC / (512 * 2 ** zoom);
    const nx = Math.ceil(ext.larg / (COTE * mpp)), ny = Math.ceil(ext.haut / (COTE * mpp));
    let fait = 0;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const mx = ext.cx - ext.larg / 2 + (i + 0.5) * COTE * mpp;
        const my = ext.cy + ext.haut / 2 - (j + 0.5) * COTE * mpp;
        const ll = [(mx * 360) / MERC, (Math.atan(Math.exp((my * 2 * Math.PI) / MERC)) * 360) / Math.PI - 90] as [number, number];
        hors.jumpTo({ center: ll, zoom });
        await new Promise<void>((ok) => {
          const t = setTimeout(ok, 20_000);
          hors.once("idle", () => {
            clearTimeout(t);
            ok();
          });
          hors.triggerRepaint();
        });
        for (const c of couches) {
          const src = c.source!;
          const liste = res.get(c.id) ?? [];
          for (const f of hors.querySourceFeatures(src, { sourceLayer: c["source-layer"] })) {
            const z = f._z, x = f._x, y = f._y;
            const cle = `${c.id}|${z}/${x}/${y}|${f.id ?? ""}|${JSON.stringify(f.properties)}|${JSON.stringify(f.geometry).length}`;
            if (vus.has(cle)) continue;
            vus.add(cle);
            const cote = MERC / 2 ** z;
            liste.push({ f, tuile: { o: -MERC / 2 + x * cote, e: -MERC / 2 + (x + 1) * cote, n: MERC / 2 - y * cote, s: MERC / 2 - (y + 1) * cote } });
          }
          res.set(c.id, liste);
        }
        progres(`Lecture du cadastre : ${++fait}/${nx * ny}…`);
      }
  } finally {
    hors.remove();
    div.remove();
  }
  return res;
}

// --- Habillage (port de habillagePdf) ---------------------------------------------------------

function habillageSvg(r: Reglages, g: ReturnType<typeof gabarit>, solW: number, legende: ElementLegende[], site: string, lat: number, cam: Camera3D | null, ids: (n: string) => string): string {
  const mesure = document.createElement("canvas").getContext("2d")!;
  const PT = 0.3528; // mm par point
  const larg = (t: string, tailleMm: number, gras: boolean) => {
    mesure.font = `${gras ? "bold " : ""}${tailleMm * 10}px Helvetica, Arial, sans-serif`;
    return mesure.measureText(t).width / 10;
  };
  const couper = (t: string, l: number, taille: number, gras = false): string[] => {
    const res: string[] = [];
    let cour = "";
    for (const mot of t.split(" ")) {
      const essai = cour ? `${cour} ${mot}` : mot;
      if (larg(essai, taille, gras) > l && cour) {
        res.push(cour);
        cour = mot;
      } else cour = essai;
    }
    if (cour) res.push(cour);
    return res;
  };
  const txt = (s: string | string[], x: number, y: number, taillePt: number, o: { gras?: boolean; couleur?: string; align?: "left" | "center" | "right"; interligne?: number } = {}) => {
    const t = taillePt * PT;
    const lignes = Array.isArray(s) ? s : [s];
    const ancre = o.align === "center" ? "middle" : o.align === "right" ? "end" : "start";
    return `<text font-family="${POLICE_HAB}" font-size="${n2(t)}"${o.gras ? ` font-weight="bold"` : ""} fill="${o.couleur ?? "#1d1d1f"}" text-anchor="${ancre}">${lignes
      .map((l, k) => `<tspan x="${n2(x)}" y="${n2(y + k * t * (o.interligne ?? 1.15))}">${echapper(l)}</tspan>`)
      .join("")}</text>`;
  };
  const x0 = g.marge, y0 = g.marge;
  const f = Math.max(1, Math.min(g.w, g.h) / 210);
  const parts: string[] = [];
  const groupe = (nom: string, contenu: string) => (contenu ? `${ouvrirCalque(ids(nom), nom, false)}${contenu}</g>` : "");

  parts.push(groupe("Cadre", `<rect x="${n2(x0)}" y="${n2(y0)}" width="${n2(g.carteW)}" height="${n2(g.carteH)}" fill="none" stroke="#282828" stroke-width="${n2(0.3 * f)}"/>`));

  if (cam) {
    const R = 6 * f;
    const cx = x0 + g.carteW - R - 4 * f, cy = y0 + R + 4 * f;
    const a = (-cam.bearing * Math.PI) / 180;
    const rot = (x: number, y: number): Pt => [cx + x * Math.cos(a) - y * Math.sin(a), cy + x * Math.sin(a) + y * Math.cos(a)];
    const [p1, p2, p3, p4] = [rot(0, -R), rot(R * 0.38, R * 0.55), rot(0, R * 0.25), rot(-R * 0.38, R * 0.55)];
    const [nx, ny] = rot(0, -R - 2.2 * f);
    parts.push(
      groupe(
        "Nord",
        `<path d="${tracePolygone([[p1, p2, p3]])}" fill="#1d1d1f"/>` +
          `<path d="${tracePolygone([[p1, p3, p4]])}" fill="none" stroke="#1d1d1f" stroke-width="${n2(0.25 * f)}" stroke-linejoin="round"/>` +
          txt("N", nx, ny + 1 * f, 7 * f, { gras: true, align: "center" }),
      ),
    );
  } else {
    const R = 8 * f;
    const [, ha, dr] = encombrement(R);
    const cx = x0 + g.carteW - dr - 2.5 * f;
    const cy = y0 + ha + 2.5 * f;
    const el: string[] = [];
    for (const p of nordSolaire(lat, R)) {
      if (p.t === "ligne") {
        const pts = (p.ferme ? [...p.pts, p.pts[0]] : p.pts).map(([x, y]) => [cx + x, cy + y] as Pt);
        el.push(`<path d="${tracePolyligne(pts)}" fill="none" stroke="#1d1d1f" stroke-width="${n2(Math.max(0.05, p.e))}" stroke-linecap="round" stroke-linejoin="round"/>`);
      } else if (p.t === "plein") el.push(`<path d="${tracePolygone([p.pts.map(([x, y]) => [cx + x, cy + y] as Pt)])}" fill="#1d1d1f"/>`);
      else if (p.t === "disque") el.push(`<circle cx="${n2(cx + p.x)}" cy="${n2(cy + p.y)}" r="${n2(p.r)}" fill="#1d1d1f"/>`);
      else el.push(txt(p.s, cx + p.x, cy + p.y, p.taille / PT, { gras: p.gras, align: p.align as "left" | "center" | "right" }));
    }
    parts.push(groupe("Nord solaire", el.join("")));

    const mParMm = r.echelle / 1000;
    const L = longueurRonde(g.carteW * 0.22 * mParMm);
    const lmm = L / mParMm;
    const sx = x0 + 5 * f, sy = y0 + g.carteH - 7 * f;
    const cases = [0, 1, 2, 3]
      .map((k) => `<rect x="${n2(sx + (k * lmm) / 4)}" y="${n2(sy - 1.2 * f)}" width="${n2(lmm / 4)}" height="${n2(1.6 * f)}" fill="${k % 2 === 0 ? "#1d1d1f" : "none"}" stroke="#1d1d1f" stroke-width="${n2(0.2 * f)}"/>`)
      .join("");
    parts.push(
      groupe(
        "Échelle graphique",
        cases +
          txt("0", sx, sy - 2.2 * f, 6.5 * f, { align: "center" }) +
          txt(L >= 1000 ? `${L / 1000} km` : `${L} m`, sx + lmm, sy - 2.2 * f, 6.5 * f, { align: "center" }) +
          txt(`1/${r.echelle.toLocaleString("fr-FR").replace(/ | /g, " ")}`, sx + lmm + 4 * f, sy + 0.4 * f, 6.5 * f),
      ),
    );
  }

  // Bandeau : cartouche à gauche, légende à droite.
  const by = y0 + g.carteH + g.marge / 2;
  const bh = g.bandeau;
  const colCart = g.carteW * 0.42;
  const lc = colCart - 4 * f;
  const titre = couper(r.titre || "Plan", lc, 11 * f * PT, true).slice(0, 2);
  const nomFormat = r.format === "libre" ? `${g.w} × ${g.h} mm` : `${r.format} ${r.paysage ? "paysage" : "portrait"}`;
  const lignes = (cam
    ? [site, `Vue en perspective, sans échelle · ${nomFormat} · focale ${cam.focale} mm · inclinaison ${Math.round(cam.pitch)}°`, `Édité le ${new Date().toLocaleDateString("fr-FR")}`]
    : [site, `Échelle 1/${r.echelle} · ${nomFormat} · emprise ${Math.round(solW)} m de large`, `Édité le ${new Date().toLocaleDateString("fr-FR")} · Lambert-93 / Web Mercator, nord en haut, heures solaires`]
  ).filter(Boolean);
  const sources = `Sources : ${[...new Set(legende.map((l) => l.source))].join(" · ")}. Diagnostic de site, données ouvertes.`;
  parts.push(
    groupe(
      "Cartouche",
      `<line x1="${n2(x0)}" y1="${n2(by)}" x2="${n2(x0 + g.carteW)}" y2="${n2(by)}" stroke="#282828" stroke-width="${n2(0.2 * f)}"/>` +
        txt(titre, x0, by + 6 * f, 11 * f, { gras: true }) +
        txt(lignes.flatMap((l) => couper(l, lc, 7.5 * f * PT)).slice(0, 3), x0, by + (titre.length > 1 ? 15 : 11.5) * f, 7.5 * f, { couleur: "#48484d", interligne: 1.3 }) +
        txt(couper(sources, lc, 5.8 * f * PT).slice(0, 2), x0, by + bh - 4 * f, 5.8 * f, { couleur: "#6e6e73" }),
    ),
  );

  const lx0 = x0 + colCart + 4 * f;
  const lw = g.carteW - colCart - 4 * f;
  const nCol = lw > 160 * f ? 3 : 2;
  const cw = lw / nCol;
  let col = 0;
  let ly = by + 5 * f;
  const pas = 3.6 * f;
  const leg: string[] = [];
  for (const el of legende) {
    const hauteur = pas * (1 + (el.pastilles ? Math.ceil(el.pastilles.length / 2) : 0));
    if (ly + hauteur > by + bh - 1 * f) {
      col++;
      ly = by + 5 * f;
      if (col >= nCol) break;
    }
    const lx = lx0 + col * cw;
    leg.push(txt(couper(el.titre, cw - 3 * f, 6.8 * f * PT, true)[0] ?? el.titre, lx, ly, 6.8 * f, { gras: true }));
    ly += pas;
    if (el.pastilles) {
      el.pastilles.forEach((p, k) => {
        const px = lx + (k % 2) * (cw / 2);
        const py = ly + Math.floor(k / 2) * pas;
        const c = couleur(p.couleur);
        leg.push(`<rect x="${n2(px)}" y="${n2(py - 2.4 * f)}" width="${n2(3 * f)}" height="${n2(2.4 * f)}" fill="${c?.hex ?? p.couleur}" stroke="#a0a0a0" stroke-width="0.1"/>`);
        leg.push(txt(couper(p.libelle, cw / 2 - 5 * f, 6 * f * PT)[0] ?? p.libelle, px + 4 * f, py - 0.3 * f, 6 * f));
      });
      ly += Math.ceil(el.pastilles.length / 2) * pas;
    }
  }
  parts.push(groupe("Légende", leg.join("")));
  return parts.join("\n");
}

// --- Export ---------------------------------------------------------------------------------------

export async function exporterSvg(c: ContexteSvg): Promise<{ blob: Blob; ext: "svg" | "zip"; note: string }> {
  const { map, r, centre } = c;
  const g = gabarit(r);
  const ext = emprise(r, centre);
  const s = ext.larg / g.carteW; // mètres Mercator par mm de papier
  const ox = ext.cx - ext.larg / 2, oy = ext.cy + ext.haut / 2;
  const versPage = (lon: number, lat: number): Pt => {
    const [mx, my] = ll2merc(lon, lat);
    return [g.marge + (mx - ox) / s, g.marge + (oy - my) / s];
  };
  const mercVersPage = (mx: number, my: number): Pt => [g.marge + (mx - ox) / s, g.marge + (oy - my) / s];
  const zone: Rect = { x0: g.marge, y0: g.marge, x1: g.marge + g.carteW, y1: g.marge + g.carteH };
  const zoomRef = Math.log2(MERC / (512 * (ext.larg / ((g.carteW * DPI_REF) / 25.4))));
  const ids = fabriqueIds();
  const notes: string[] = [];

  // Résolution des calques raster : celle demandée, plafonnée à une image de 16 Mpx.
  let dpi = r.dpi;
  const pxZone = (g.carteW / 25.4) * (g.carteH / 25.4);
  if (pxZone * dpi * dpi > MAX_PX_IMAGE) dpi = Math.floor(Math.sqrt(MAX_PX_IMAGE / pxZone));
  const pxW = Math.round((g.carteW * dpi) / 25.4), pxH = Math.round((g.carteH * dpi) / 25.4);
  const image = (url: string) =>
    `<image x="${n2(g.marge)}" y="${n2(g.marge)}" width="${n2(g.carteW)}" height="${n2(g.carteH)}" preserveAspectRatio="none" xlink:href="${url}"/>`;

  const calques: Calque[] = [];
  if (c.cam && c.vue3d) {
    c.progres("Image de la vue 3D…");
    calques.push({ cle: "vue-3d", titre: "Vue 3D", genre: "raster", couches: [], contenu: [image(await enDataUrl(c.vue3d))] });
  } else {
    // 1. Répartition des couches visibles en calques, dans l'ordre de dessin.
    // L'ordre vient de la carte : getStyle() omet les couches 3D (« custom »),
    // dont les arbres en volume.
    const style = map.getStyle();
    const specs = new Map((style.layers as CoucheStyle[]).map((l) => [l.id, l]));
    for (const lid of map.getLayersOrder()) {
      if (lid === "arbres-3d") {
        if (c.arbres && map.getLayoutProperty(lid, "visibility") !== "none") {
          calques.push({ cle: "arbres-3d", titre: "Arbres (volumes)", genre: "arbres", couches: [], contenu: [] });
          calques.push({ cle: "arbres-houppiers", titre: "Arbres — houppiers", genre: "vecteur", couches: [], contenu: [] });
        }
        continue;
      }
      const l = specs.get(lid);
      if (!l || l.id.startsWith("cadre-") || !visible(l)) continue;
      const type = l.type as string;
      if (type === "custom") continue;
      if (type === "fill-extrusion" || type === "heatmap") continue;
      if (type !== "raster" && type !== "hillshade" && type !== "background" && type !== "color-relief") {
        if ((l.minzoom !== undefined && zoomRef < l.minzoom) || (l.maxzoom !== undefined && zoomRef >= l.maxzoom)) continue;
      }
      const raster = type === "raster" || type === "hillshade" || type === "color-relief" || l.source === "plan_ign" || (type === "background" && l.id.startsWith("ign-"));
      const genre: Calque["genre"] = raster ? "raster" : "vecteur";
      const nom = c.calque(l.id) ?? (l.id.startsWith("coupe-") ? { cle: "coupe", titre: "Coupe de terrain" } : { cle: l.id, titre: l.id });
      let cible = calques.find((x) => x.cle === nom.cle && x.genre === genre);
      if (!cible) {
        cible = { cle: nom.cle, titre: nom.titre, genre, couches: [], contenu: [] };
        calques.push(cible);
      }
      cible.couches.push(l);
    }

    // 2. Calques vectoriels.
    const sources = style.sources as Record<string, { type: string; data?: unknown }>;
    const coucheTuilees = calques.filter((x) => x.genre === "vecteur").flatMap((x) => x.couches).filter((l) => l.source && sources[l.source]?.type === "vector");
    const morceaux = coucheTuilees.length ? await lireTuiles(map, coucheTuilees, centre, ext, Math.min(zoomRef, 19), c.progres) : new Map<string, MorceauTuile[]>();
    const donnees = new Map<string, GeoJSON.Feature[]>();
    const lireGeojson = async (id: string): Promise<GeoJSON.Feature[]> => {
      if (donnees.has(id)) return donnees.get(id)!;
      let d = sources[id]?.data;
      if (typeof d === "string") d = await (await fetch(d)).json();
      const liste: GeoJSON.Feature[] =
        !d ? [] : (d as GeoJSON.GeoJSON).type === "FeatureCollection" ? (d as GeoJSON.FeatureCollection).features : (d as GeoJSON.GeoJSON).type === "Feature" ? [d as GeoJSON.Feature] : [{ type: "Feature", properties: {}, geometry: d as GeoJSON.Geometry }];
      donnees.set(id, liste);
      return liste;
    };
    const projeter = (geo: GeoJSON.Geometry) => {
      const e = eclater(geo);
      return {
        polygones: e.polygones.map((p) => p.map((a) => a.map(([x, y]) => versPage(x, y)))),
        lignes: e.lignes.map((l) => l.map(([x, y]) => versPage(x, y))),
        points: e.points.map(([x, y]) => versPage(x, y)),
      };
    };
    // Houppiers des arbres en volume : un disque au diamètre réel (mesuré par
    // le LiDAR, renseigné dans OSM ou générique), mêmes arbres que la 3D.
    const mmParM = 1000 / r.echelle;
    const houppiers = (a: NonNullable<ContexteSvg["arbres"]>) => {
      const cercles: string[] = [];
      for (const arbre of arbresADessiner(a.arbres, a.lat0, a.lon0)) {
        const p = versPage(arbre.lon, arbre.lat);
        if (!dansRect(p, zone)) continue;
        const gb = gabaritArbre(arbre);
        cercles.push(`<circle cx="${n2(p[0])}" cy="${n2(p[1])}" r="${n2(Math.max(0.1, gb.rayon * mmParM))}" fill="${gb.resineux ? "#2f6b2a" : "#3a7a30"}" fill-opacity="0.85" stroke="#ffffff" stroke-opacity="0.9" stroke-width="${n2(KMM_HAB)}"/>`);
      }
      return cercles.length ? `${ouvrirCalque(ids("Arbres · houppiers"), "houppiers", false)}\n${cercles.join("\n")}\n</g>` : "";
    };
    const horsZone = (geo: EntitePage["geo"]) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const voir = (p: Pt) => {
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      };
      geo.points.forEach(voir);
      geo.lignes.forEach((l) => l.forEach(voir));
      geo.polygones.forEach((p) => p[0]?.forEach(voir));
      return x1 < zone.x0 || x0 > zone.x1 || y1 < zone.y0 || y0 > zone.y1;
    };
    for (const cq of calques.filter((x) => x.genre === "vecteur")) {
      c.progres(`Vecteurs : ${cq.titre}…`);
      if (cq.cle === "arbres-houppiers" && c.arbres) cq.contenu.push(houppiers(c.arbres));
      for (const l of cq.couches) {
        let contenu = "";
        if (l.type === "background") {
          const ev = evaluateur(l as never, zoomRef);
          const e0: EntiteStyle = { type: "Polygon", properties: {} };
          const col = couleur(ev.paint("background-color", e0));
          const a = (col?.a ?? 1) * nombre(ev.paint("background-opacity", e0), 1);
          if (col && a > 0) contenu = `<rect x="${n2(zone.x0)}" y="${n2(zone.y0)}" width="${n2(g.carteW)}" height="${n2(g.carteH)}" fill="${col.hex}"${a < 0.999 ? ` fill-opacity="${opa(a)}"` : ""}/>`;
        } else if (l.source && sources[l.source]?.type === "vector") {
          const entites: EntitePage[] = [];
          for (const m of morceaux.get(l.id) ?? []) {
            const geo = projeter(m.f.geometry);
            const [a, b] = [mercVersPage(m.tuile.o, m.tuile.n), mercVersPage(m.tuile.e, m.tuile.s)];
            const rect: Rect = { x0: Math.max(zone.x0, a[0]), y0: Math.max(zone.y0, a[1]), x1: Math.min(zone.x1, b[0]), y1: Math.min(zone.y1, b[1]) };
            if (rect.x0 >= rect.x1 || rect.y0 >= rect.y1) continue;
            entites.push({ type: typeDeBase(m.f.geometry.type), properties: m.f.properties ?? {}, id: m.f.id, geo, rect });
          }
          contenu = dessinerCouche(l, entites, zoomRef);
        } else if (l.source) {
          const entites: EntitePage[] = [];
          for (const f of await lireGeojson(l.source)) {
            if (!f.geometry) continue;
            const geo = projeter(f.geometry);
            if (horsZone(geo)) continue;
            entites.push({ type: typeDeBase(f.geometry.type), properties: (f.properties ?? {}) as Record<string, unknown>, id: f.id, geo, rect: zone });
          }
          contenu = dessinerCouche(l, entites, zoomRef);
        }
        if (contenu) cq.contenu.push(`${ouvrirCalque(ids(`${cq.titre} · ${l.id}`), l.id, false)}\n${contenu}\n</g>`);
      }
    }

    // 3. Calques raster : un rendu hors écran par calque, fond transparent.
    const rasters = calques.filter((x) => x.genre !== "vecteur");
    let k = 0;
    for (const cq of rasters) {
      k++;
      const toile = document.createElement("canvas");
      toile.width = pxW;
      toile.height = pxH;
      const ctx = toile.getContext("2d")!;
      const garder = new Set(cq.couches.map((l) => l.id));
      await rendre(cq.genre === "arbres" ? c.arbres : null, map, r, centre, pxW, pxH, (img, x, y) => ctx.drawImage(img, x, y), (f, t) => c.progres(`Images (${k}/${rasters.length}) ${cq.titre} : ${f}/${t}…`), (l) => garder.has(l.id));
      if (vide(toile)) {
        notes.push(`${cq.titre} : rien dans le cadre`);
        continue;
      }
      cq.contenu.push(image(await enDataUrl(toile)));
    }
  }

  // 4. Assemblage.
  const utiles = calques.filter((x) => x.contenu.length);
  const entete = (titre: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ` +
    `width="${n2(g.w)}mm" height="${n2(g.h)}mm" viewBox="0 0 ${n2(g.w)} ${n2(g.h)}">\n` +
    `<title>${echapper(titre)}</title>\n<desc>${echapper(
      `${c.cam ? "Vue en perspective, sans échelle" : `Échelle 1/${r.echelle}`} · unités en millimètres (1 unité = 1 mm) · ${c.site} · Diagnostic de site, données ouvertes`,
    )}</desc>\n`;
  const calqueSvg = (cq: Calque) => [`${ouvrirCalque(ids(cq.titre), cq.titre)}\n`, ...cq.contenu.map((x) => `${x}\n`), `</g>\n`];
  const habillage = habillageSvg(r, g, ext.solW, c.legende, c.site, c.lat, c.cam, ids);
  const calqueHab = () => [`${ouvrirCalque(ids("Habillage"), "Habillage")}\n${habillage}\n</g>\n`];
  const titre = r.titre || "Plan";
  const note = [dpi < r.dpi && utiles.some((x) => x.genre !== "vecteur") ? `images à ${dpi} dpi (plafond par image)` : "", ...notes].filter(Boolean).join(" ; ");

  if (!c.zip) {
    const parts: BlobPart[] = [entete(titre), ...utiles.flatMap(calqueSvg), ...calqueHab(), `</svg>\n`];
    return { blob: new Blob(parts, { type: "image/svg+xml" }), ext: "svg", note };
  }
  const enc = new TextEncoder();
  const fichiers: { nom: string; donnees: Uint8Array }[] = [];
  const nomFichier = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "calque";
  const tous = [...utiles.map((cq) => ({ titre: cq.titre, corps: calqueSvg(cq) })), { titre: "Habillage", corps: calqueHab() }];
  tous.forEach((x, i) => {
    c.progres(`Archive : ${x.titre}…`);
    fichiers.push({ nom: `${String(i + 1).padStart(2, "0")}-${nomFichier(x.titre)}.svg`, donnees: enc.encode([entete(`${titre} — ${x.titre}`), ...x.corps, `</svg>\n`].join("")) });
  });
  fichiers.push({
    nom: "LISEZMOI.txt",
    donnees: enc.encode(
      [
        `${titre}`,
        `${c.cam ? "Vue en perspective, sans échelle" : `Échelle 1/${r.echelle}`} · page ${g.w} × ${g.h} mm`,
        ``,
        `Un fichier SVG par calque, numérotés du dessous (01) au dessus. Tous ont la même page,`,
        `la même échelle et la même origine : ils se superposent au millimètre.`,
        ``,
        `Illustrator : ouvrir 01, puis pour chaque fichier suivant, créer un calque, Fichier > Importer,`,
        `et coller à la même position (ou ouvrir chaque fichier, tout sélectionner, copier,`,
        `puis Édition > Coller à la même position dans le calque voulu).`,
        ``,
        `Contenu : ${tous.map((x, i) => `${String(i + 1).padStart(2, "0")} ${x.titre}`).join(" · ")}`,
        note ? `Remarques : ${note}` : "",
      ].join("\r\n"),
    ),
  });
  return { blob: await zipper(fichiers), ext: "zip", note };
}
