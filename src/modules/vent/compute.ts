// Calculs vent : rose normée (16 directions × classes de vitesse) par saison
// et sur l'année, vents forts et jours de rafales. Pur, sans I/O.
import type { VentRaw } from "./fetch";

export const SECTORS = 16;
const SECTOR_SIZE = 360 / SECTORS;

/** Directions d'où vient le vent (convention météorologique), en français. */
export const SECTOR_LABELS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO",
];
export const SECTOR_NOMS = [
  "nord", "nord-nord-est", "nord-est", "est-nord-est", "est", "est-sud-est", "sud-est", "sud-sud-est",
  "sud", "sud-sud-ouest", "sud-ouest", "ouest-sud-ouest", "ouest", "ouest-nord-ouest", "nord-ouest", "nord-nord-ouest",
];

export type Season = "hiver" | "printemps" | "ete" | "automne";
export const SEASONS: Season[] = ["hiver", "printemps", "ete", "automne"];
export const SEASON_LABELS: Record<Season, string> = {
  hiver: "Hiver (DJF)",
  printemps: "Printemps (MAM)",
  ete: "Été (JJA)",
  automne: "Automne (SON)",
};

/** Seuil de calme (m/s). */
export const CALM_THRESHOLD = 0.5;
/** Classes de vitesse (m/s), proches des degrés Beaufort 1-2, 3, 4, 5 et 6 et plus. */
export const CLASSES = [
  { min: CALM_THRESHOLD, max: 3, label: "0,5–3 m/s", kmh: "2–11 km/h" },
  { min: 3, max: 5, label: "3–5 m/s", kmh: "11–18 km/h" },
  { min: 5, max: 8, label: "5–8 m/s", kmh: "18–29 km/h" },
  { min: 8, max: 11, label: "8–11 m/s", kmh: "29–40 km/h" },
  { min: 11, max: Infinity, label: "≥ 11 m/s", kmh: "≥ 40 km/h" },
];
/** Vent fort : à partir de 8 m/s (29 km/h, Beaufort 5). */
export const FORT_MS = 8;
/** Rafales : seuil de Météo-France pour un « jour de vent fort » (16 m/s, 58 km/h). */
export const RAFALE_MS = 16;

function seasonOf(isoDate: string): Season {
  const month = Number(isoDate.slice(5, 7));
  if (month === 12 || month <= 2) return "hiver";
  if (month <= 5) return "printemps";
  if (month <= 8) return "ete";
  return "automne";
}

export interface SeasonRose {
  /** Fréquence (%) par secteur, somme = 100 (hors calme). */
  frequency: number[];
  /** Fréquence (%) par secteur et par classe de vitesse, sur toutes les heures
   * (calme compris) : somme des secteurs + calme = 100. */
  parClasse: number[][];
  /** Vitesse moyenne (m/s) par secteur. */
  meanSpeed: number[];
  /** Part de vent calme (< 0.5 m/s), en %. */
  calmPct: number;
  /** Secteur dominant (indice dans SECTOR_LABELS). */
  dominantSector: number;
  /** Vitesse moyenne toutes directions confondues, hors calme (m/s). */
  meanSpeedOverall: number;
  /** Part des heures de vent fort (≥ FORT_MS), en %. */
  fortPct: number;
  /** Secteur d'où vient le plus souvent le vent fort (-1 s'il n'y en a pas). */
  fortSecteur: number;
}

export interface VentResult {
  years: number;
  bySeason: Record<Season, SeasonRose>;
  annual: SeasonRose;
  /** Jours par an avec rafale maximale ≥ RAFALE_MS (null si non fourni). */
  joursRafales: number | null;
}

class Bins {
  counts = Array.from({ length: SECTORS }, () => new Array(CLASSES.length).fill(0) as number[]);
  speedSum = new Array(SECTORS).fill(0) as number[];
  fort = new Array(SECTORS).fill(0) as number[];
  calm = 0;
  total = 0;

  add(speed: number, dir: number): void {
    this.total++;
    if (speed < CALM_THRESHOLD) {
      this.calm++;
      return;
    }
    const s = Math.round(dir / SECTOR_SIZE) % SECTORS;
    let c = CLASSES.findIndex((k) => speed < k.max);
    if (c < 0) c = CLASSES.length - 1;
    this.counts[s][c]++;
    this.speedSum[s] += speed;
    if (speed >= FORT_MS) this.fort[s]++;
  }

  rose(): SeasonRose {
    const parSecteur = this.counts.map((c) => c.reduce((a, b) => a + b, 0));
    const valid = this.total - this.calm;
    const frequency = parSecteur.map((n) => (valid > 0 ? (n / valid) * 100 : 0));
    const dominantSector = frequency.reduce((best, v, i) => (v > frequency[best] ? i : best), 0);
    const fortTotal = this.fort.reduce((a, b) => a + b, 0);
    const fortSecteur = fortTotal > 0 ? this.fort.reduce((best, v, i) => (v > this.fort[best] ? i : best), 0) : -1;
    const pct = (n: number) => (this.total > 0 ? (n / this.total) * 100 : 0);
    return {
      frequency: frequency.map(round1),
      parClasse: this.counts.map((c) => c.map((n) => round2(pct(n)))),
      meanSpeed: parSecteur.map((n, i) => round1(n > 0 ? this.speedSum[i] / n : 0)),
      calmPct: round1(pct(this.calm)),
      dominantSector,
      meanSpeedOverall: round1(valid > 0 ? this.speedSum.reduce((a, b) => a + b, 0) / valid : 0),
      fortPct: round1(pct(fortTotal)),
      fortSecteur,
    };
  }
}

export function computeVent(raw: VentRaw): VentResult {
  const h = raw.hourly;
  const saisons: Record<Season, Bins> = { hiver: new Bins(), printemps: new Bins(), ete: new Bins(), automne: new Bins() };
  const annee = new Bins();

  for (let i = 0; i < h.time.length; i++) {
    const speed = h.windspeed_10m[i];
    const dir = h.winddirection_10m[i];
    if (speed == null || dir == null || !Number.isFinite(speed)) continue;
    saisons[seasonOf(h.time[i])].add(speed, dir);
    annee.add(speed, dir);
  }

  let joursRafales: number | null = null;
  const g = raw.daily?.wind_gusts_10m_max;
  if (g && g.length) {
    const valides = g.filter((v) => v != null && Number.isFinite(v));
    if (valides.length > 365) joursRafales = round1((valides.filter((v) => v >= RAFALE_MS).length / valides.length) * 365.25);
  }

  return {
    years: Math.max(1, Math.round(h.time.length / 8766)),
    bySeason: Object.fromEntries(SEASONS.map((s) => [s, saisons[s].rose()])) as Record<Season, SeasonRose>,
    annual: annee.rose(),
    joursRafales,
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
