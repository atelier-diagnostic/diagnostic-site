// Coupe de terrain entre deux points A et B : profil des altitudes du LiDAR HD
// (MNT 50 cm, complété par le RGE ALTI® hors couverture) ou du RGE ALTI seul,
// avec les bâtiments de la BD TOPO® traversés (emprise × hauteur).
//
// Altitudes lues sur les tuiles Web Mercator de la Géoplateforme (les mêmes que
// le relief et les courbes), interpolées entre pixels (bilinéaire). Le pas
// d'échantillonnage suit la résolution : ≈ 0,4 m pour une coupe de moins de
// 600 m en LiDAR, plus large au-delà (1 500 points au plus).
//
// Points clés : A, B, point haut, point bas ; dénivelé A → B, montée et
// descente cumulées (sur un profil lissé à ±1 m, sinon chaque bordure compte),
// pente moyenne et pente maximale (sur 5 m au moins).

import { altitudesMixtes, TAILLE_TUILE, type SourceAlt } from "./relief-dem";

const C = 20037508.342789244;
type LL = [number, number];

export interface PointProfil {
  d: number;
  z: number;
  lon: number;
  lat: number;
}
export interface BatimentCoupe {
  d0: number;
  d1: number;
  /** Pied (m NGF) : altitude la plus basse du terrain sous le bâtiment coupé. */
  pied: number;
  h: number;
  connue: boolean;
}
export interface Profil {
  a: LL;
  b: LL;
  points: PointProfil[];
  longueur: number;
  pas: number;
  source: SourceAlt;
  /** Part du tracé lue sur le LiDAR HD (0-1). */
  partLidar: number;
  haut: PointProfil;
  bas: PointProfil;
  denivele: number;
  montee: number;
  descente: number;
  penteMoy: number;
  penteMax: { pct: number; d: number };
  batiments: BatimentCoupe[];
  /** Tuiles d'altitudes refusées (trous dans le profil). */
  manquantes: number;
}

const versMerc = (lon: number, lat: number): LL => [(lon * C) / 180, (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * C) / Math.PI];

/** Distance (m) entre deux points proches (projection locale). */
export function distanceM(a: LL, b: LL): number {
  const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (b[0] - a[0]) * 111_320 * Math.cos(lat);
  const dy = (b[1] - a[1]) * 110_540;
  return Math.hypot(dx, dy);
}

/** Zoom des tuiles : le plus fin possible (LiDAR 18, RGE ALTI 17), au plus ~30 tuiles le long du tracé. */
function zoomPour(source: SourceAlt, L: number, lat: number): number {
  const z = Math.floor(Math.log2((40_075_016 * Math.cos((lat * Math.PI) / 180) * 30) / L));
  return Math.max(8, Math.min(source === "rgealti" ? 17 : 18, z));
}

/** Intervalles (fractions 0-1 de A → B) où le segment traverse un polygone. */
function traversees(a: LL, b: LL, anneau: number[][]): [number, number][] {
  const cos = Math.cos(a[1] * (Math.PI / 180));
  const P = (p: number[]): LL => [(p[0] - a[0]) * cos, p[1] - a[1]];
  const B = P(b);
  const ts: number[] = [];
  for (let i = 0, j = anneau.length - 1; i < anneau.length; j = i++) {
    const p = P(anneau[j]), q = P(anneau[i]);
    const ex = q[0] - p[0], ey = q[1] - p[1];
    const den = B[0] * ey - B[1] * ex;
    if (Math.abs(den) < 1e-18) continue;
    const t = (p[0] * ey - p[1] * ex) / den;
    const u = (p[0] * B[1] - p[1] * B[0]) / den;
    if (t > 0 && t < 1 && u >= 0 && u < 1) ts.push(t);
  }
  // A est-il dans le polygone ? (parité des croisements d'un rayon depuis A)
  let dedans = false;
  for (let i = 0, j = anneau.length - 1; i < anneau.length; j = i++) {
    const p = P(anneau[j]), q = P(anneau[i]);
    if (p[1] > 0 !== q[1] > 0 && 0 < p[0] + ((0 - p[1]) * (q[0] - p[0])) / (q[1] - p[1])) dedans = !dedans;
  }
  ts.sort((x, y) => x - y);
  const bornes = [...(dedans ? [0] : []), ...ts];
  if (bornes.length % 2) bornes.push(1);
  const out: [number, number][] = [];
  for (let i = 0; i < bornes.length; i += 2) if (bornes[i + 1] - bornes[i] > 1e-6) out.push([bornes[i], bornes[i + 1]]);
  return out;
}

export async function calculerProfil(a: LL, b: LL, source: SourceAlt, bati?: GeoJSON.FeatureCollection | null): Promise<Profil> {
  const L = distanceM(a, b);
  if (L < 2) throw new Error("Coupe trop courte");
  const latMoy = (a[1] + b[1]) / 2;
  const z = zoomPour(source, L, latMoy);
  const t = (2 * C) / 2 ** z;
  const pxSol = t / TAILLE_TUILE * Math.cos(latMoy * (Math.PI / 180));
  const n = Math.min(1500, Math.max(50, Math.ceil(L / pxSol))) + 1;
  const pas = L / (n - 1);

  // Positions en pixels du monde (centres de pixel à +0,5).
  const pos = Array.from({ length: n }, (_, i) => {
    const f = i / (n - 1);
    const lon = a[0] + (b[0] - a[0]) * f, lat = a[1] + (b[1] - a[1]) * f;
    const [mx, my] = versMerc(lon, lat);
    return { lon, lat, px: ((mx + C) / t) * TAILLE_TUILE - 0.5, py: ((C - my) / t) * TAILLE_TUILE - 0.5 };
  });
  // Tuiles nécessaires (avec les voisines pour l'interpolation).
  const cles = new Set<string>();
  for (const p of pos)
    for (const dx of [0, 1])
      for (const dy of [0, 1]) cles.add(`${Math.floor((Math.floor(p.px) + dx) / TAILLE_TUILE)},${Math.floor((Math.floor(p.py) + dy) / TAILLE_TUILE)}`);
  const tuiles = new Map<string, { alt: Float32Array; lidar: number } | null>();
  let manquantes = 0;
  await Promise.all(
    [...cles].map(async (k) => {
      const [x, y] = k.split(",").map(Number);
      try {
        tuiles.set(k, await altitudesMixtes(z, x, y, source));
      } catch {
        tuiles.set(k, null);
        manquantes++;
      }
    }),
  );
  if (manquantes === cles.size) throw new Error("Altitudes IGN indisponibles");
  const val = (ix: number, iy: number): number => {
    const tx = Math.floor(ix / TAILLE_TUILE), ty = Math.floor(iy / TAILLE_TUILE);
    const tu = tuiles.get(`${tx},${ty}`);
    if (!tu) return NaN;
    const v = tu.alt[(iy - ty * TAILLE_TUILE) * TAILLE_TUILE + (ix - tx * TAILLE_TUILE)];
    return Number.isFinite(v) && v > -1000 && v < 9000 ? v : NaN;
  };
  const points: PointProfil[] = [];
  for (let i = 0; i < n; i++) {
    const p = pos[i];
    const ix = Math.floor(p.px), iy = Math.floor(p.py), fx = p.px - ix, fy = p.py - iy;
    const v00 = val(ix, iy), v10 = val(ix + 1, iy), v01 = val(ix, iy + 1), v11 = val(ix + 1, iy + 1);
    const zz = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
    points.push({ d: i * pas, z: Number.isFinite(zz) ? zz : NaN, lon: p.lon, lat: p.lat });
  }
  const ok = points.filter((p) => Number.isFinite(p.z));
  if (ok.length < 2) throw new Error("Pas d'altitude sur ce tracé");
  let partLidar = 0;
  for (const tu of tuiles.values()) if (tu) partLidar += tu.lidar;
  partLidar /= Math.max(1, tuiles.size - manquantes);

  // Profil lissé (±1 m) pour la montée, la descente et les pentes.
  const w = Math.max(1, Math.round(1 / pas));
  const lisse = points.map((_, i) => {
    let s = 0, k = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++)
      if (Number.isFinite(points[j].z)) {
        s += points[j].z;
        k++;
      }
    return k ? s / k : NaN;
  });
  let montee = 0, descente = 0;
  let prec = NaN;
  for (const v of lisse) {
    if (!Number.isFinite(v)) continue;
    if (Number.isFinite(prec)) {
      if (v > prec) montee += v - prec;
      else descente += prec - v;
    }
    prec = v;
  }
  const fen = Math.max(1, Math.ceil(5 / pas));
  let penteMax = { pct: 0, d: 0 };
  for (let i = 0; i + fen < n; i++) {
    const dz = lisse[i + fen] - lisse[i];
    if (!Number.isFinite(dz)) continue;
    const pct = (Math.abs(dz) / (fen * pas)) * 100;
    if (pct > penteMax.pct) penteMax = { pct, d: (i + fen / 2) * pas };
  }
  const haut = ok.reduce((m, p) => (p.z > m.z ? p : m));
  const bas = ok.reduce((m, p) => (p.z < m.z ? p : m));
  const zA = ok[0].z, zB = ok[ok.length - 1].z;

  // Bâtiments coupés.
  const batiments: BatimentCoupe[] = [];
  for (const f of bati?.features ?? []) {
    if (f.geometry?.type !== "Polygon") continue;
    const anneau = f.geometry.coordinates[0];
    // Rejet rapide : boîte englobante.
    let w0 = 180, e0 = -180, s0 = 90, n0 = -90;
    for (const [x, y] of anneau) {
      if (x < w0) w0 = x;
      if (x > e0) e0 = x;
      if (y < s0) s0 = y;
      if (y > n0) n0 = y;
    }
    if (Math.max(a[0], b[0]) < w0 || Math.min(a[0], b[0]) > e0 || Math.max(a[1], b[1]) < s0 || Math.min(a[1], b[1]) > n0) continue;
    for (const [t0, t1] of traversees(a, b, anneau)) {
      const i0 = Math.floor(t0 * (n - 1)), i1 = Math.ceil(t1 * (n - 1));
      let pied = Infinity;
      for (let i = i0; i <= i1; i++) if (Number.isFinite(points[i].z) && points[i].z < pied) pied = points[i].z;
      if (!Number.isFinite(pied)) continue;
      batiments.push({ d0: t0 * L, d1: t1 * L, pied, h: Number(f.properties?.h) || 0, connue: f.properties?.connue !== false });
    }
  }

  return {
    a,
    b,
    points,
    longueur: L,
    pas,
    source,
    partLidar,
    haut,
    bas,
    denivele: zB - zA,
    montee,
    descente,
    penteMoy: ((zB - zA) / L) * 100,
    penteMax,
    batiments,
    manquantes,
  };
}

// --- Dessin du profil (SVG) ----------------------------------------------------------

export interface Couleurs {
  fond: string;
  texte: string;
  texte2: string;
  grille: string;
  terre: string;
  trait: string;
  bati: string;
  batiTrait: string;
  point: string;
}
/** Couleurs à l'écran : variables du thème (clair / sombre). */
export const COULEURS_ECRAN: Couleurs = {
  fond: "transparent",
  texte: "var(--ink-2)",
  texte2: "var(--muted)",
  grille: "var(--border)",
  terre: "var(--coupe-terre)",
  trait: "var(--coupe-trait)",
  bati: "var(--coupe-bati)",
  batiTrait: "var(--coupe-bati-trait)",
  point: "var(--ink)",
};
/** Couleurs du fichier exporté (fond blanc, pour la mise en page). */
export const COULEURS_EXPORT: Couleurs = {
  fond: "#ffffff",
  texte: "#3a3a3c",
  texte2: "#8e8e93",
  grille: "#e5e5ea",
  terre: "#e8dfcf",
  trait: "#6b4a2c",
  bati: "#d4d0c8",
  batiTrait: "#8a8478",
  point: "#1d1d1f",
};

export const EXAGERATIONS_COUPE = ["auto", 1, 2, 5, 10] as const;
export type ExagCoupe = (typeof EXAGERATIONS_COUPE)[number];

const fr = (v: number, dec = 1) => v.toLocaleString("fr-FR", { maximumFractionDigits: dec, minimumFractionDigits: 0 });
const pasJoli = (etendue: number, cible: number) => {
  const brut = etendue / cible;
  const p = 10 ** Math.floor(Math.log10(brut));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((v) => v >= brut) ?? 10 * p;
};

export interface Dessin {
  svg: string;
  /** Exagération verticale réellement appliquée. */
  exag: number;
  /** Conversion abscisse écran (px dans le SVG) → distance (m). */
  xVersD: (x: number) => number;
  dVersX: (d: number) => number;
  zVersY: (z: number) => number;
  marges: { g: number; d: number; h: number; b: number };
}

export function dessinerProfil(p: Profil, W: number, H: number, exagVoulue: ExagCoupe, avecBati: boolean, c: Couleurs): Dessin {
  const m = { g: 46, d: 14, h: 26, b: 24 };
  const pw = W - m.g - m.d, ph = H - m.h - m.b;
  const ok = p.points.filter((q) => Number.isFinite(q.z));
  let zmin = p.bas.z, zmax = p.haut.z;
  if (avecBati) for (const b of p.batiments) zmax = Math.max(zmax, b.pied + b.h);
  const amplitude = Math.max(1, zmax - zmin);
  const mParPxH = p.longueur / pw;
  // Exagération « auto » : le relief occupe ~80 % de la hauteur (jamais moins que ×1).
  const auto = Math.max(1, (ph * 0.8 * mParPxH) / amplitude);
  const exag = exagVoulue === "auto" ? auto : Math.min(exagVoulue, auto);
  const mParPxV = mParPxH / exag;
  const centre = (zmin + zmax) / 2;
  const z0 = centre - (ph / 2) * mParPxV, z1 = centre + (ph / 2) * mParPxV;
  const X = (d: number) => m.g + (d / p.longueur) * pw;
  const Y = (z: number) => m.h + ph - ((z - z0) / (z1 - z0)) * ph;
  const st = (props: Record<string, string | number>) => `style="${Object.entries(props).map(([k, v]) => `${k}:${v}`).join(";")}"`;
  const parts: string[] = [];
  if (c.fond !== "transparent") parts.push(`<rect width="${W}" height="${H}" ${st({ fill: c.fond })}/>`);
  // Grille des altitudes.
  const pz = pasJoli(z1 - z0, 5);
  for (let v = Math.ceil(z0 / pz) * pz; v <= z1; v += pz) {
    const y = Y(v).toFixed(1);
    parts.push(`<line x1="${m.g}" x2="${m.g + pw}" y1="${y}" y2="${y}" ${st({ stroke: c.grille, "stroke-width": 1 })}/>`);
    parts.push(`<text x="${m.g - 6}" y="${y}" dy="0.32em" text-anchor="end" ${st({ fill: c.texte2, "font-size": "10px" })}>${fr(v)} m</text>`);
  }
  // Graduations des distances.
  const pd = pasJoli(p.longueur, 8);
  for (let d = 0; d <= p.longueur + 1e-6; d += pd) {
    const x = X(d).toFixed(1);
    parts.push(`<line x1="${x}" x2="${x}" y1="${m.h + ph}" y2="${m.h + ph + 4}" ${st({ stroke: c.texte2, "stroke-width": 1 })}/>`);
    parts.push(`<text x="${x}" y="${m.h + ph + 15}" text-anchor="middle" ${st({ fill: c.texte2, "font-size": "10px" })}>${d >= 1000 ? `${fr(d / 1000, 2)} km` : `${fr(d, 0)} m`}</text>`);
  }
  // Terrain : aplat jusqu'en bas du cadre, puis le trait du sol.
  const segs: PointProfil[][] = [];
  let cur: PointProfil[] = [];
  for (const q of p.points) {
    if (Number.isFinite(q.z)) cur.push(q);
    else if (cur.length) {
      segs.push(cur);
      cur = [];
    }
  }
  if (cur.length) segs.push(cur);
  const bas = (m.h + ph).toFixed(1);
  for (const s of segs) {
    const l = s.map((q) => `${X(q.d).toFixed(1)},${Y(q.z).toFixed(1)}`).join(" L");
    parts.push(`<path d="M${X(s[0].d).toFixed(1)},${bas} L${l} L${X(s[s.length - 1].d).toFixed(1)},${bas} Z" ${st({ fill: c.terre })}/>`);
  }
  // Bâtiments coupés : pied au plus bas du terrain, hauteur BD TOPO.
  if (avecBati)
    for (const b of p.batiments) {
      const x0 = X(b.d0), x1 = X(b.d1), yb = Y(b.pied), yh = Y(b.pied + b.h);
      parts.push(
        `<rect x="${x0.toFixed(1)}" y="${yh.toFixed(1)}" width="${Math.max(0.8, x1 - x0).toFixed(1)}" height="${Math.max(0.5, yb - yh).toFixed(1)}" ${st({ fill: c.bati, stroke: c.batiTrait, "stroke-width": 0.8, "stroke-dasharray": b.connue ? "none" : "2 2" })}/>`,
      );
    }
  for (const s of segs) parts.push(`<path d="M${s.map((q) => `${X(q.d).toFixed(1)},${Y(q.z).toFixed(1)}`).join(" L")}" ${st({ fill: "none", stroke: c.trait, "stroke-width": 1.6, "stroke-linejoin": "round" })}/>`);
  // Points clés.
  const pointCle = (q: PointProfil, label: string, dessus: boolean) => {
    const x = X(q.d), y = Y(q.z);
    const ancre = x < m.g + 40 ? "start" : x > m.g + pw - 40 ? "end" : "middle";
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" ${st({ fill: c.point, stroke: c.fond === "transparent" ? "var(--panel)" : c.fond, "stroke-width": 1.5 })}/>`);
    parts.push(`<text x="${x.toFixed(1)}" y="${(y + (dessus ? -9 : 16)).toFixed(1)}" text-anchor="${ancre}" ${st({ fill: c.texte, "font-size": "10.5px", "font-weight": 600 })}>${label}</text>`);
  };
  const premier = ok[0], dernier = ok[ok.length - 1];
  pointCle(premier, `A · ${fr(premier.z)} m`, true);
  pointCle(dernier, `B · ${fr(dernier.z)} m`, true);
  const loin = (q: PointProfil) => Math.abs(q.d - premier.d) > p.longueur * 0.08 && Math.abs(q.d - dernier.d) > p.longueur * 0.08;
  if (loin(p.haut) && p.haut.z - Math.max(premier.z, dernier.z) > 0.2) pointCle(p.haut, `▲ ${fr(p.haut.z)} m`, true);
  if (loin(p.bas) && Math.min(premier.z, dernier.z) - p.bas.z > 0.2) pointCle(p.bas, `▼ ${fr(p.bas.z)} m`, false);
  parts.push(
    `<text x="${m.g}" y="12" ${st({ fill: c.texte2, "font-size": "10px" })}>Exagération verticale ×${fr(exag, exag < 10 ? 1 : 0)}${exagVoulue !== "auto" && exag < exagVoulue ? " (réduite pour tenir dans le cadre)" : ""}</text>`,
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="-apple-system, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif">${parts.join("")}</svg>`;
  return { svg, exag, xVersD: (x) => ((x - m.g) / pw) * p.longueur, dVersX: X, zVersY: Y, marges: m };
}

/** Pente locale (%) autour de la distance d (fenêtre de 5 m). */
export function penteEn(p: Profil, d: number): number {
  const i = Math.round(d / p.pas);
  const f = Math.max(1, Math.ceil(2.5 / p.pas));
  const i0 = Math.max(0, i - f), i1 = Math.min(p.points.length - 1, i + f);
  const a = p.points[i0], b = p.points[i1];
  if (!Number.isFinite(a.z) || !Number.isFinite(b.z) || b.d === a.d) return NaN;
  return ((b.z - a.z) / (b.d - a.d)) * 100;
}

/** Fichier CSV du profil (distance, altitude, longitude, latitude). */
export function profilCsv(p: Profil): string {
  return "distance_m;altitude_m;longitude;latitude\n" + p.points.map((q) => `${q.d.toFixed(2)};${Number.isFinite(q.z) ? q.z.toFixed(2) : ""};${q.lon.toFixed(7)};${q.lat.toFixed(7)}`).join("\n");
}
