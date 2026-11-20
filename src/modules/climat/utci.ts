// Confort thermique extérieur : UTCI (Universal Thermal Climate Index),
// heure par heure, dans quatre situations types (soleil / ombre × vent /
// abrité), sur les heures réellement observées de 2016 à 2025 (ERA5 via
// Open-Meteo). Ce n'est pas une carte du confort rue par rue : c'est le
// climat du site traduit en sensation pour une personne debout dehors.
//
//  - UTCI : polynôme de Bröde et al. (2012), validé contre pythermalcomfort.
//  - Température radiante moyenne au soleil : personne debout assimilée à un
//    cylindre (facteur de surface projetée de Fanger), absorption 0,7,
//    rayonnement direct normal, moitié du diffus et du réfléchi par le sol
//    (albédo 0,2) ; grandes longueurs d'onde à la température de l'air
//    (méthode simplifiée de Thorsson et al. 2007, Kántor et Unger 2011).
//  - À l'ombre : température radiante = température de l'air (ombre totale,
//    parois à la température de l'air).
//  - Vent : vitesse à 10 m, référence de l'UTCI ; « abrité » = 0,5 m/s, le
//    minimum du modèle.
// Limites : le rayonnement des sols et façades surchauffés n'est pas compté
// (au soleil, l'été en ville, l'inconfort est sous-estimé) ; maille de la
// réanalyse ≈ 10 km.

import { polynomeUtci } from "./utci-polynome";
import { sunAtLegalTime } from "../../map3d/sun";

export const SITUATIONS = [
  { id: "soleil-vent", titre: "Au soleil, au vent", soleil: true, vent: true },
  { id: "soleil-abri", titre: "Au soleil, abrité", soleil: true, vent: false },
  { id: "ombre-vent", titre: "À l'ombre, au vent", soleil: false, vent: true },
  { id: "ombre-abri", titre: "À l'ombre, abrité", soleil: false, vent: false },
] as const;
export type Situation = (typeof SITUATIONS)[number]["id"];

/** Les dix classes de stress de l'UTCI (seuils en °C), du plus froid au plus chaud. */
export const CLASSES_UTCI = [
  { min: -Infinity, titre: "Froid extrême", couleur: "#1e2a6e" },
  { min: -40, titre: "Froid très fort", couleur: "#2f3f94" },
  { min: -27, titre: "Froid fort", couleur: "#3d55b5" },
  { min: -13, titre: "Froid modéré", couleur: "#4f72c4" },
  { min: 0, titre: "Froid léger", couleur: "#86b6e3" },
  { min: 9, titre: "Pas de stress thermique", couleur: "#6cb257" },
  { min: 26, titre: "Chaleur modérée", couleur: "#e8913a" },
  { min: 32, titre: "Chaleur forte", couleur: "#d9452f" },
  { min: 38, titre: "Chaleur très forte", couleur: "#a8262b" },
  { min: 46, titre: "Chaleur extrême", couleur: "#6b1418" },
] as const;
export function classeUtci(u: number): number {
  let k = 0;
  for (let i = 0; i < CLASSES_UTCI.length; i++) if (u >= CLASSES_UTCI[i].min) k = i;
  return k;
}

/** Pression de vapeur saturante (hPa), formule de l'UTCI (Hardy 1998, comme pythermalcomfort). */
function pressionSaturante(t: number): number {
  const g = [-2836.5744, -6028.076559, 19.54263612, -0.02737830188, 0.000016261698, 7.0229056e-10, -1.8680009e-13];
  const tk = t + 273.15;
  let es = 2.7150305 * Math.log(tk);
  g.forEach((c, i) => (es += c * tk ** (i - 2)));
  return Math.exp(es) * 0.01;
}

/** UTCI (°C) ; tdb air, tr température radiante moyenne, v vent à 10 m, rh humidité (%). Entrées bornées au domaine du modèle. */
export function utci(tdb: number, tr: number, v: number, rh: number): number {
  const t = Math.max(-50, Math.min(50, tdb));
  const d = Math.max(-30, Math.min(70, tr - tdb));
  const va = Math.max(0.5, Math.min(17, v));
  const pa = Math.min(5, (pressionSaturante(t) * Math.max(0, Math.min(100, rh))) / 100 / 10);
  return polynomeUtci(t, va, d, pa);
}

const SIGMA = 5.67e-8;
/**
 * Température radiante moyenne d'une personne debout au soleil (°C).
 * dni : direct normal, dhi : diffus horizontal, ghi : global horizontal (W/m²), h : hauteur du soleil (°).
 */
export function tmrtSoleil(ta: number, dni: number, dhi: number, ghi: number, h: number): number {
  const hh = Math.max(0, h);
  // Facteur de surface projetée d'une personne debout (Fanger ; Underwood et Ward).
  const fp = 0.308 * Math.cos((hh * (1 - (hh * hh) / 48402) * Math.PI) / 180);
  const ALPHA = 0.7, EPS = 0.97, ALBEDO = 0.2;
  const absorbe = ALPHA * (fp * Math.max(0, dni) + 0.5 * Math.max(0, dhi) + 0.5 * ALBEDO * Math.max(0, ghi));
  return Math.pow((ta + 273.15) ** 4 + absorbe / (EPS * SIGMA), 0.25) - 273.15;
}

export interface HorairesUtci {
  time: string[];
  temperature_2m: number[];
  relative_humidity_2m: number[];
  wind_speed_10m: number[];
  shortwave_radiation: number[];
  diffuse_radiation: number[];
  direct_normal_irradiance: number[];
}

export interface AnalyseUtci {
  annees: number;
  /** UTCI médian par jour de l'année (365) et par heure (24), pour chaque situation : [jour][heure]. */
  medianes: Record<Situation, Float32Array>;
  /** Part (%) des heures de jour (soleil levé) par classe, par mois (12 × 10), pour chaque situation. */
  repartitionJour: Record<Situation, number[][]>;
}

const JOURS_MOIS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DEBUT_MOIS = JOURS_MOIS.map((_, m) => JOURS_MOIS.slice(0, m).reduce((a, b) => a + b, 0));
/** Jour de l'année (0-364) ; le 29 février compte comme le 28. */
const jourAn = (mois: number, jour: number) => DEBUT_MOIS[mois] + Math.min(jour, JOURS_MOIS[mois]) - 1;

export function analyserUtci(h: HorairesUtci, lat: number, lon: number): AnalyseUtci {
  const n = h.time.length;
  const valeurs = Object.fromEntries(SITUATIONS.map((s) => [s.id, Array.from({ length: 365 * 24 }, () => [] as number[])])) as Record<Situation, number[][]>;
  const comptes = Object.fromEntries(SITUATIONS.map((s) => [s.id, Array.from({ length: 12 }, () => new Array(CLASSES_UTCI.length).fill(0))])) as Record<Situation, number[][]>;
  const annees = new Set<string>();
  for (let i = 0; i < n; i++) {
    const ta = h.temperature_2m[i], rh = h.relative_humidity_2m[i], v = h.wind_speed_10m[i];
    if (![ta, rh, v].every(Number.isFinite)) continue;
    const t = h.time[i]; // AAAA-MM-JJTHH:00, heure locale ; rayonnement = moyenne de l'heure écoulée
    const date = t.slice(0, 10), heure = Number(t.slice(11, 13));
    const mois = Number(t.slice(5, 7)) - 1, jour = Number(t.slice(8, 10));
    annees.add(t.slice(0, 4));
    const hs = sunAtLegalTime(lat, lon, date, heure - 0.5).elevationDeg;
    const leve = hs > 0;
    const ghi = h.shortwave_radiation[i] ?? 0, dhi = h.diffuse_radiation[i] ?? 0;
    let dni = h.direct_normal_irradiance[i];
    if (!Number.isFinite(dni)) dni = hs > 3 ? Math.max(0, ghi - dhi) / Math.sin((hs * Math.PI) / 180) : 0;
    const trSoleil = leve ? tmrtSoleil(ta, dni, dhi, ghi, hs) : ta;
    const k = jourAn(mois, jour) * 24 + heure;
    for (const s of SITUATIONS) {
      const u = utci(ta, s.soleil ? trSoleil : ta, s.vent ? v : 0.5, rh);
      valeurs[s.id][k].push(u);
      if (leve) comptes[s.id][mois][classeUtci(u)]++;
    }
  }
  const mediane = (a: number[]) => {
    if (!a.length) return NaN;
    const b = [...a].sort((x, y) => x - y);
    const m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  };
  const medianes = Object.fromEntries(SITUATIONS.map((s) => [s.id, Float32Array.from(valeurs[s.id].map(mediane))])) as Record<Situation, Float32Array>;
  const repartitionJour = Object.fromEntries(
    SITUATIONS.map((s) => [
      s.id,
      comptes[s.id].map((c) => {
        const tot = c.reduce((a, b) => a + b, 0);
        return c.map((x) => (tot ? Math.round((x / tot) * 1000) / 10 : 0));
      }),
    ]),
  ) as Record<Situation, number[][]>;
  return { annees: annees.size, medianes, repartitionJour };
}

/** Part (%) des heures de jour d'une période (mois 0-11) dans un ensemble de classes. */
export function partHeures(a: AnalyseUtci, s: Situation, mois: number[], classes: number[]): number {
  const r = a.repartitionJour[s];
  return Math.round((mois.reduce((t, m) => t + classes.reduce((x, k) => x + r[m][k], 0), 0) / mois.length) * 10) / 10;
}
