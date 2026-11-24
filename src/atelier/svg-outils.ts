// Outils purs de l'export SVG (sans navigateur, testables sous Node) :
// découpe des géométries sur un rectangle, écriture des tracés, évaluation
// des styles MapLibre pour une entité, archive ZIP.

import { normalizePropertyExpression, featureFilter, latest, Color, Formatted } from "@maplibre/maplibre-gl-style-spec";

export type Pt = [number, number];
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// --- Découpe ------------------------------------------------------------------------

/** Découpe d'un anneau (polygone) sur un rectangle, Sutherland–Hodgman. */
export function decouperAnneau(anneau: Pt[], r: Rect): Pt[] {
  let pts = anneau.length > 1 && anneau[0][0] === anneau[anneau.length - 1][0] && anneau[0][1] === anneau[anneau.length - 1][1] ? anneau.slice(0, -1) : anneau.slice();
  const bords: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p[0] >= r.x0, (a, b) => [r.x0, a[1] + ((b[1] - a[1]) * (r.x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= r.x1, (a, b) => [r.x1, a[1] + ((b[1] - a[1]) * (r.x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= r.y0, (a, b) => [a[0] + ((b[0] - a[0]) * (r.y0 - a[1])) / (b[1] - a[1]), r.y0]],
    [(p) => p[1] <= r.y1, (a, b) => [a[0] + ((b[0] - a[0]) * (r.y1 - a[1])) / (b[1] - a[1]), r.y1]],
  ];
  for (const [dedans, inter] of bords) {
    if (pts.length === 0) break;
    const sortie: Pt[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[i];
      const da = dedans(a), db = dedans(b);
      if (db) {
        if (!da) sortie.push(inter(a, b));
        sortie.push(b);
      } else if (da) sortie.push(inter(a, b));
    }
    pts = sortie;
  }
  return pts.length >= 3 ? pts : [];
}

/** Découpe d'une polyligne sur un rectangle (Liang–Barsky segment par segment) ;
 * renvoie les morceaux restés dedans. */
export function decouperLigne(ligne: Pt[], r: Rect): Pt[][] {
  const morceaux: Pt[][] = [];
  let cour: Pt[] = [];
  const pousser = (p: Pt) => {
    const d = cour[cour.length - 1];
    if (!d || Math.abs(d[0] - p[0]) > 1e-9 || Math.abs(d[1] - p[1]) > 1e-9) cour.push(p);
  };
  const clore = () => {
    if (cour.length >= 2) morceaux.push(cour);
    cour = [];
  };
  for (let i = 1; i < ligne.length; i++) {
    const [ax, ay] = ligne[i - 1];
    const [bx, by] = ligne[i];
    const dx = bx - ax, dy = by - ay;
    let t0 = 0, t1 = 1;
    let vide = false;
    for (const [p, q] of [[-dx, ax - r.x0], [dx, r.x1 - ax], [-dy, ay - r.y0], [dy, r.y1 - ay]] as const) {
      if (p === 0) {
        if (q < 0) { vide = true; break; }
      } else {
        const t = q / p;
        if (p < 0) { if (t > t1) { vide = true; break; } if (t > t0) t0 = t; }
        else { if (t < t0) { vide = true; break; } if (t < t1) t1 = t; }
      }
    }
    if (vide) { clore(); continue; }
    const debut: Pt = [ax + t0 * dx, ay + t0 * dy];
    const fin: Pt = [ax + t1 * dx, ay + t1 * dy];
    if (t0 > 0) clore();
    pousser(debut);
    pousser(fin);
    if (t1 < 1) clore();
  }
  clore();
  return morceaux;
}

export const dansRect = (p: Pt, r: Rect) => p[0] >= r.x0 && p[0] <= r.x1 && p[1] >= r.y0 && p[1] <= r.y1;

// --- Géométries GeoJSON ------------------------------------------------------------

/** Anneaux des polygones, lignes des linéaires, points des ponctuels. */
export function eclater(g: GeoJSON.Geometry): { polygones: Pt[][][]; lignes: Pt[][]; points: Pt[] } {
  const res = { polygones: [] as Pt[][][], lignes: [] as Pt[][], points: [] as Pt[] };
  const voir = (g: GeoJSON.Geometry) => {
    switch (g.type) {
      case "Point": res.points.push(g.coordinates as Pt); break;
      case "MultiPoint": res.points.push(...(g.coordinates as Pt[])); break;
      case "LineString": res.lignes.push(g.coordinates as Pt[]); break;
      case "MultiLineString": res.lignes.push(...(g.coordinates as Pt[][])); break;
      case "Polygon": res.polygones.push(g.coordinates as Pt[][]); break;
      case "MultiPolygon": res.polygones.push(...(g.coordinates as Pt[][][])); break;
      case "GeometryCollection": g.geometries.forEach(voir); break;
    }
  };
  voir(g);
  return res;
}

export const typeDeBase = (t: string): "Point" | "LineString" | "Polygon" =>
  t.includes("Point") ? "Point" : t.includes("LineString") ? "LineString" : "Polygon";

/** Centre de surface d'un anneau (repli : centre de l'emprise). */
export function centreAnneau(a: Pt[]): Pt {
  let s = 0, cx = 0, cy = 0;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    const f = a[j][0] * a[i][1] - a[i][0] * a[j][1];
    s += f;
    cx += (a[j][0] + a[i][0]) * f;
    cy += (a[j][1] + a[i][1]) * f;
  }
  if (Math.abs(s) < 1e-12) {
    const xs = a.map((p) => p[0]), ys = a.map((p) => p[1]);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  }
  return [cx / (3 * s), cy / (3 * s)];
}

// --- Écriture SVG -----------------------------------------------------------------------

export const n2 = (v: number) => {
  const s = (Math.round(v * 100) / 100).toString();
  return s === "-0" ? "0" : s;
};
export const echapper = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Identifiant XML lisible (accents gardés), unique dans le document. */
export function fabriqueIds(): (nom: string) => string {
  const vus = new Map<string, number>();
  return (nom) => {
    let base = nom.normalize("NFC").replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "") || "calque";
    if (!/^[\p{L}_]/u.test(base)) base = `_${base}`;
    const k = vus.get(base) ?? 0;
    vus.set(base, k + 1);
    return k ? `${base}_${k + 1}` : base;
  };
}

export const tracePolyligne = (l: Pt[]) => `M${l.map((p) => `${n2(p[0])} ${n2(p[1])}`).join("L")}`;
export const tracePolygone = (anneaux: Pt[][]) => anneaux.map((a) => `${tracePolyligne(a)}Z`).join("");

/** Ouverture d'un groupe-calque : nom lisible pour Illustrator (data-name) et Inkscape (calque). */
export function ouvrirCalque(id: string, nom: string, calque = true): string {
  return `<g id="${echapper(id)}" data-name="${echapper(nom)}"${calque ? ` inkscape:groupmode="layer" inkscape:label="${echapper(nom)}"` : ""}>`;
}

// --- Couleurs et styles MapLibre ----------------------------------------------------

/** Couleur → hexadécimal + opacité (Illustrator lit mal rgba()). */
export function couleur(v: unknown): { hex: string; a: number } | null {
  let c: Color | undefined;
  if (v instanceof Color) c = v;
  else if (typeof v === "string") c = Color.parse(v);
  else if (v && typeof v === "object" && "rgb" in (v as object)) c = v as Color;
  if (!c) return null;
  const [r, g, b, a] = c.rgb;
  const h = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255))).toString(16).padStart(2, "0");
  return { hex: `#${h(r)}${h(g)}${h(b)}`, a };
}

export interface EntiteStyle {
  type: "Point" | "LineString" | "Polygon";
  properties: Record<string, unknown>;
  id?: string | number;
}

type Couche = { id: string; type: string; filter?: unknown; paint?: Record<string, unknown>; layout?: Record<string, unknown>; minzoom?: number; maxzoom?: number };

/** Évaluateur des propriétés d'une couche de style, au zoom donné. */
export function evaluateur(couche: Couche, zoom: number) {
  const specs = latest as unknown as Record<string, Record<string, unknown>>;
  const cache = new Map<string, ((f: EntiteStyle) => unknown) | null>();
  const prop = (genre: "paint" | "layout", nom: string): ((f: EntiteStyle) => unknown) | null => {
    const cle = `${genre}:${nom}`;
    if (cache.has(cle)) return cache.get(cle)!;
    const spec = specs[`${genre}_${couche.type}`]?.[nom] as { default?: unknown } | undefined;
    let f: ((e: EntiteStyle) => unknown) | null = null;
    const brut = couche[genre]?.[nom];
    const valeur = brut === undefined ? spec?.default : brut;
    if (spec && valeur !== undefined) {
      try {
        const expr = normalizePropertyExpression(valeur as never, spec as never);
        f = (e) => {
          try {
            return expr.evaluate({ zoom } as never, e as never);
          } catch {
            return undefined;
          }
        };
      } catch {
        f = null;
      }
    }
    cache.set(cle, f);
    return f;
  };
  let filtre: (e: EntiteStyle) => boolean = () => true;
  if (couche.filter !== undefined) {
    try {
      const ff = featureFilter(couche.filter as never);
      filtre = (e) => {
        try {
          return Boolean(ff.filter({ zoom } as never, e as never));
        } catch {
          return false;
        }
      };
    } catch {
      filtre = () => false;
    }
  }
  return {
    filtre,
    paint: (nom: string, e: EntiteStyle) => prop("paint", nom)?.(e),
    layout: (nom: string, e: EntiteStyle) => prop("layout", nom)?.(e),
    /** Propriété explicitement posée dans le style (et non valeur par défaut). */
    posee: (genre: "paint" | "layout", nom: string) => couche[genre]?.[nom] !== undefined,
  };
}

export const texte = (v: unknown): string => (v instanceof Formatted ? v.toString() : v == null ? "" : String(v));
export const nombre = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
export const tableau = (v: unknown): number[] | null => {
  if (Array.isArray(v)) return v.every((x) => typeof x === "number") ? (v as number[]) : null;
  if (v && typeof v === "object" && "values" in (v as object) && Array.isArray((v as { values: unknown }).values)) return (v as { values: number[] }).values;
  return null;
};

/** Points d'étiquettes le long d'une ligne (pas « spacing ») : position et angle, lisibles. */
export function etiquettesLe(ligne: Pt[], espacement: number, longueurTexte: number): { p: Pt; angle: number }[] {
  const seg: { a: Pt; b: Pt; l: number; cumul: number }[] = [];
  let total = 0;
  for (let i = 1; i < ligne.length; i++) {
    const a = ligne[i - 1], b = ligne[i];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l <= 0) continue;
    seg.push({ a, b, l, cumul: total });
    total += l;
  }
  if (total < longueurTexte * 1.2 || !seg.length) return [];
  const res: { p: Pt; angle: number }[] = [];
  const pas = Math.max(espacement, longueurTexte * 1.5);
  const n = Math.max(1, Math.floor(total / pas));
  const debut = (total - (n - 1) * pas) / 2;
  for (let k = 0; k < n; k++) {
    const d = debut + k * pas;
    const s = seg.find((x) => x.cumul + x.l >= d) ?? seg[seg.length - 1];
    const t = Math.min(1, Math.max(0, (d - s.cumul) / s.l));
    const p: Pt = [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
    let angle = (Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]) * 180) / Math.PI;
    if (angle > 90) angle -= 180;
    else if (angle < -90) angle += 180;
    res.push({ p, angle });
  }
  return res;
}

/** Découpe un texte en lignes d'au plus `max` caractères (approximation de text-max-width). */
export function couperLignes(t: string, max: number): string[] {
  const lignes: string[] = [];
  let cour = "";
  for (const mot of t.split(/\s+/).filter(Boolean)) {
    const essai = cour ? `${cour} ${mot}` : mot;
    if (essai.length > max && cour) {
      lignes.push(cour);
      cour = mot;
    } else cour = essai;
  }
  if (cour) lignes.push(cour);
  return lignes.length ? lignes : [t];
}

// --- Dessin vectoriel d'une couche de style ------------------------------------------------
// Épaisseurs, rayons et tailles de texte : ceux du rendu à 150 dpi (le PDF par
// défaut), soit 1 px de style = 25,4 / 150 mm.

export const KMM = 25.4 / 150;
const POLICE = "'Source Sans Pro', 'Helvetica Neue', Helvetica, Arial, sans-serif";

export type CoucheStyle = { id: string; type: string; source?: string; "source-layer"?: string; filter?: unknown; paint?: Record<string, unknown>; layout?: Record<string, unknown>; minzoom?: number; maxzoom?: number };


export interface EntitePage extends EntiteStyle {
  /** Géométrie en millimètres sur la page. */
  geo: { polygones: Pt[][][]; lignes: Pt[][]; points: Pt[] };
  /** Rectangle de découpe (zone carte, ou zone carte ∩ tuile d'origine). */
  rect: Rect;
}

export const opa = (a: number) => (Math.round(Math.max(0, Math.min(1, a)) * 1000) / 1000).toString();

function attrsTrait(hex: string, a: number, largeur: number): string {
  return ` stroke="${hex}"${a < 0.999 ? ` stroke-opacity="${opa(a)}"` : ""} stroke-width="${Math.max(0.02, Math.round(largeur * 1000) / 1000)}"`;
}

export function dessinerCouche(couche: CoucheStyle, entites: EntitePage[], zoom: number): string {
  const ev = evaluateur(couche as never, zoom);
  const out: string[] = [];
  const halos: string[] = [];
  const textes: string[] = [];
  for (const e of entites) {
    if (!ev.filtre(e)) continue;
    if (couche.type === "background") continue;
    if (couche.type === "fill") {
      const c = couleur(ev.paint("fill-color", e));
      if (!c) continue;
      const a = c.a * nombre(ev.paint("fill-opacity", e), 1);
      const contour = ev.posee("paint", "fill-outline-color") ? couleur(ev.paint("fill-outline-color", e)) : null;
      for (const poly of e.geo.polygones) {
        const exterieur = decouperAnneau(poly[0] ?? [], e.rect);
        if (!exterieur.length) continue;
        const anneaux = [exterieur, ...poly.slice(1).map((r) => decouperAnneau(r, e.rect)).filter((r) => r.length)];
        out.push(
          `<path d="${tracePolygone(anneaux)}" fill="${c.hex}"${a < 0.999 ? ` fill-opacity="${opa(a)}"` : ""} fill-rule="evenodd"` +
            (contour && contour.a > 0 ? attrsTrait(contour.hex, contour.a * nombre(ev.paint("fill-opacity", e), 1), KMM) + ` stroke-linejoin="round"` : "") +
            `/>`,
        );
      }
    } else if (couche.type === "line") {
      const c = couleur(ev.paint("line-color", e));
      if (!c) continue;
      const a = c.a * nombre(ev.paint("line-opacity", e), 1);
      if (a <= 0) continue;
      const w = nombre(ev.paint("line-width", e), 1) * KMM;
      const tirets = tableau(ev.paint("line-dasharray", e));
      const cap = texte(ev.layout("line-cap", e)) || "butt";
      const join = texte(ev.layout("line-join", e)) || "miter";
      const lignes = [...e.geo.lignes, ...e.geo.polygones.flatMap((p) => p.map((r) => (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) ? [...r, r[0]] : r)))];
      const d = lignes.flatMap((l) => decouperLigne(l, e.rect)).map(tracePolyligne).join("");
      if (!d) continue;
      out.push(
        `<path d="${d}" fill="none"${attrsTrait(c.hex, a, w)}${cap !== "butt" ? ` stroke-linecap="${cap}"` : ""}${join !== "miter" ? ` stroke-linejoin="${join === "bevel" ? "bevel" : "round"}"` : ""}` +
          (tirets && tirets.length ? ` stroke-dasharray="${tirets.map((t) => n2(Math.max(0.01, t * w))).join(" ")}"` : "") +
          `/>`,
      );
    } else if (couche.type === "circle") {
      const c = couleur(ev.paint("circle-color", e));
      const rayon = nombre(ev.paint("circle-radius", e), 5) * KMM;
      const a = (c?.a ?? 1) * nombre(ev.paint("circle-opacity", e), 1);
      const sw = nombre(ev.paint("circle-stroke-width", e), 0) * KMM;
      const sc = couleur(ev.paint("circle-stroke-color", e));
      const sa = (sc?.a ?? 1) * nombre(ev.paint("circle-stroke-opacity", e), 1);
      for (const p of e.geo.points) {
        if (!dansRect(p, e.rect)) continue;
        out.push(
          `<circle cx="${n2(p[0])}" cy="${n2(p[1])}" r="${n2(Math.max(0.05, rayon))}" fill="${c?.hex ?? "#000000"}"${a < 0.999 ? ` fill-opacity="${opa(a)}"` : ""}` +
            (sw > 0 && sc && sa > 0 ? attrsTrait(sc.hex, sa, sw) : "") +
            `/>`,
        );
      }
    } else if (couche.type === "symbol") {
      const s = texte(ev.layout("text-field", e)).trim();
      if (!s) continue;
      const taille = nombre(ev.layout("text-size", e), 16) * KMM;
      const c = couleur(ev.paint("text-color", e)) ?? { hex: "#000000", a: 1 };
      const a = c.a * nombre(ev.paint("text-opacity", e), 1);
      if (a <= 0) continue;
      const hc = couleur(ev.paint("text-halo-color", e));
      const hw = nombre(ev.paint("text-halo-width", e), 0) * KMM;
      const polices = ev.layout("text-font", e);
      const gras = Array.isArray(polices) && polices.some((p) => /bold|semibold/i.test(String(p)));
      const style = `font-family="${POLICE}" font-size="${n2(Math.max(0.1, taille))}"${gras ? ` font-weight="bold"` : ""}`;
      const placement = texte(ev.layout("symbol-placement", e)) || "point";
      const poses: { p: Pt; angle: number; lignes: string[]; ancre: string; dy: number }[] = [];
      if (placement !== "point" && (e.geo.lignes.length || e.geo.polygones.length)) {
        const espacement = nombre(ev.layout("symbol-spacing", e), 250) * KMM;
        const lignes = [...e.geo.lignes, ...e.geo.polygones.flatMap((p) => p)];
        for (const l of lignes.flatMap((x) => decouperLigne(x, e.rect)))
          for (const q of etiquettesLe(l, espacement, s.length * taille * 0.5)) poses.push({ p: q.p, angle: q.angle, lignes: [s], ancre: "middle", dy: 0.35 });
      } else {
        const pts = e.geo.points.length ? e.geo.points : [...e.geo.polygones.map((p) => centreAnneau(p[0])), ...e.geo.lignes.map((l) => l[Math.floor(l.length / 2)])];
        const off = tableau(ev.layout("text-offset", e)) ?? [0, 0];
        const ancre = texte(ev.layout("text-anchor", e)) || "center";
        const maxEm = nombre(ev.layout("text-max-width", e), 10);
        const lignesTxt = couperLignes(s, Math.max(4, Math.round(maxEm * 1.9)));
        for (const p0 of pts) {
          if (!dansRect(p0, e.rect)) continue;
          const p: Pt = [p0[0] + off[0] * taille, p0[1] + off[1] * taille];
          const h = ancre.includes("left") ? "start" : ancre.includes("right") ? "end" : "middle";
          const nl = lignesTxt.length;
          // Décalage vertical (en em) de la première ligne selon l'ancrage.
          const dy = ancre.startsWith("top") ? 0.8 : ancre.startsWith("bottom") ? -(nl - 1) * 1.2 - 0.2 : 0.35 - ((nl - 1) * 1.2) / 2;
          poses.push({ p, angle: 0, lignes: lignesTxt, ancre: h, dy });
        }
      }
      for (const q of poses) {
        const tr = q.angle ? ` transform="translate(${n2(q.p[0])} ${n2(q.p[1])}) rotate(${n2(q.angle)})"` : "";
        const [x, y] = q.angle ? [0, 0] : q.p;
        const corps = q.lignes
          .map((l, k) => `<tspan x="${n2(x)}" y="${n2(y + (q.dy + k * 1.2) * taille)}">${echapper(l)}</tspan>`)
          .join("");
        const base = `<text${tr} ${style} text-anchor="${q.ancre}"`;
        if (hc && hc.a > 0 && hw > 0) halos.push(`${base} fill="${hc.hex}" stroke="${hc.hex}"${hc.a < 0.999 ? ` fill-opacity="${opa(hc.a)}" stroke-opacity="${opa(hc.a)}"` : ""} stroke-width="${n2(Math.max(0.05, hw * 2))}" stroke-linejoin="round">${corps}</text>`);
        textes.push(`${base} fill="${c.hex}"${a < 0.999 ? ` fill-opacity="${opa(a)}"` : ""}>${corps}</text>`);
      }
    }
  }
  if (halos.length) out.push(`<g data-name="halos">${halos.join("")}</g>`);
  if (textes.length) out.push(`<g data-name="textes">${textes.join("")}</g>`);
  return out.join("\n");
}

// --- Archive ZIP (méthode « deflate » du navigateur si disponible, sinon stockage) -----

const TABLE_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(d: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = TABLE_CRC[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflater(d: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: new (f: string) => GenericTransformStream }).CompressionStream;
  if (!CS) return null;
  try {
    const flux = new Blob([d as BlobPart]).stream().pipeThrough(new CS("deflate-raw") as unknown as TransformStream<Uint8Array, Uint8Array>);
    return new Uint8Array(await new Response(flux).arrayBuffer());
  } catch {
    return null;
  }
}

/** Archive ZIP des fichiers donnés (noms UTF-8). */
export async function zipper(fichiers: { nom: string; donnees: Uint8Array }[]): Promise<Blob> {
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const maintenant = new Date();
  const heure = (maintenant.getHours() << 11) | (maintenant.getMinutes() << 5) | Math.floor(maintenant.getSeconds() / 2);
  const date = ((maintenant.getFullYear() - 1980) << 9) | ((maintenant.getMonth() + 1) << 5) | maintenant.getDate();
  for (const f of fichiers) {
    const nom = enc.encode(f.nom);
    const crc = crc32(f.donnees);
    const comp = await deflater(f.donnees);
    const methode = comp && comp.length < f.donnees.length ? 8 : 0;
    const corps = methode === 8 ? comp! : f.donnees;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // noms en UTF-8
    local.setUint16(8, methode, true);
    local.setUint16(10, heure, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, corps.length, true);
    local.setUint32(22, f.donnees.length, true);
    local.setUint16(26, nom.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, nom as BlobPart, corps as BlobPart);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, methode, true);
    c.setUint16(12, heure, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, corps.length, true);
    c.setUint32(24, f.donnees.length, true);
    c.setUint16(28, nom.length, true);
    c.setUint32(42, offset, true);
    const entree = new Uint8Array(46 + nom.length);
    entree.set(new Uint8Array(c.buffer), 0);
    entree.set(nom, 46);
    central.push(entree);
    offset += 30 + nom.length + corps.length;
  }
  const tailleCentral = central.reduce((s, x) => s + x.length, 0);
  const fin = new DataView(new ArrayBuffer(22));
  fin.setUint32(0, 0x06054b50, true);
  fin.setUint16(8, fichiers.length, true);
  fin.setUint16(10, fichiers.length, true);
  fin.setUint32(12, tailleCentral, true);
  fin.setUint32(16, offset, true);
  return new Blob([...parts, ...(central as BlobPart[]), fin.buffer], { type: "application/zip" });
}
