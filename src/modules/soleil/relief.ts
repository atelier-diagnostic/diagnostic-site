// Masque du relief (horizon lointain) à partir du RGE ALTI® de l'IGN.
//
// Méthode : altitudes lues le long de 72 directions (pas de 5°), de 50 m à
// 30 km du site ; pour chaque direction, l'angle d'élévation de l'horizon est
// le plus grand atan((z − z0 − chute) / d), où z0 est l'altitude du sol au
// site + 1,5 m (œil d'un piéton) et `chute` la courbure de la Terre corrigée
// de la réfraction atmosphérique (coefficient 0,13). Le relief est un modèle
// numérique de terrain : il ne contient ni bâtiments ni arbres.
//
// LIMITE : échantillonnage discret (23 distances par direction) ; une crête
// étroite entre deux points peut être légèrement sous-estimée.
import { fetchJson } from "../../api/client";
import { IGN_ALTI } from "../../api/endpoints";
import type { SiteContext } from "../../core/types";

export const RELIEF_PAS_DEG = 5;
const DIRECTIONS = 360 / RELIEF_PAS_DEG;
const DISTANCES = [50, 75, 100, 150, 200, 300, 400, 500, 700, 1000, 1400, 2000, 2800, 4000, 5000, 6500, 8000, 10000, 13000, 16000, 20000, 25000, 30000];
export const RELIEF_PORTEE_M = DISTANCES[DISTANCES.length - 1];
const OEIL_M = 1.5;
const R_TERRE = 6_371_000;
const REFRACTION = 0.13;
const PAR_REQUETE = 140; // URL < 5 000 caractères

export interface ReliefRaw {
  /** Élévation de l'horizon (°) par direction, de 0° (nord) par pas de 5°. */
  horizonDeg: number[];
  /** Altitude du sol au site (m). */
  z0: number;
  /** Point le plus masquant : direction (°), distance (m), angle (°). */
  plusHaut: { azimut: number; distance: number; angle: number };
}

interface IgnAltiResponse {
  elevations: (number | { z?: number })[];
}

function destination(lat: number, lon: number, azDeg: number, d: number): [number, number] {
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;
  const θ = (azDeg * Math.PI) / 180;
  const δ = d / R_TERRE;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [(φ2 * 180) / Math.PI, (λ2 * 180) / Math.PI];
}

async function altitudes(points: [number, number][]): Promise<(number | null)[]> {
  const morceaux: [number, number][][] = [];
  for (let i = 0; i < points.length; i += PAR_REQUETE) morceaux.push(points.slice(i, i + PAR_REQUETE));
  const resultats: (number | null)[][] = new Array(morceaux.length);
  // Trois requêtes à la fois : le service de l'IGN limite le débit.
  let suivant = 0;
  const travail = async () => {
    while (suivant < morceaux.length) {
      const k = suivant++;
      const m = morceaux[k];
      const url =
        `${IGN_ALTI}?lon=${m.map((p) => p[1].toFixed(5)).join("|")}&lat=${m.map((p) => p[0].toFixed(5)).join("|")}` +
        `&resource=ign_rge_alti_wld&zonly=true&indent=false`;
      const data = await fetchJson<IgnAltiResponse>(url, { cacheKey: "ign:relief", ttlMs: 365 * 24 * 3600 * 1000, timeoutMs: 30_000 });
      resultats[k] = m.map((_, i) => {
        const e = data.elevations?.[i];
        const z = typeof e === "number" ? e : e?.z;
        return typeof z === "number" && z > -1000 ? z : null;
      });
    }
  };
  await Promise.all([travail(), travail(), travail()]);
  return resultats.flat();
}

/** Horizon du relief ; null si le service ne répond pas ou hors couverture. */
export async function fetchRelief(ctx: SiteContext): Promise<ReliefRaw | null> {
  try {
    const points: [number, number][] = [[ctx.lat, ctx.lon]];
    for (let a = 0; a < DIRECTIONS; a++)
      for (const d of DISTANCES) points.push(destination(ctx.lat, ctx.lon, a * RELIEF_PAS_DEG, d));
    const z = await altitudes(points);
    const zSite = z[0] ?? ctx.altitude;
    if (zSite == null) return null;
    const z0 = zSite + OEIL_M;

    const horizonDeg: number[] = [];
    let plusHaut = { azimut: 0, distance: 0, angle: -90 };
    let valides = 0;
    for (let a = 0; a < DIRECTIONS; a++) {
      let max = 0; // l'horizon astronomique (0°) reste la référence basse
      DISTANCES.forEach((d, j) => {
        const zi = z[1 + a * DISTANCES.length + j];
        if (zi == null) return;
        valides++;
        const chute = ((1 - REFRACTION) * d * d) / (2 * R_TERRE);
        const ang = (Math.atan2(zi - z0 - chute, d) * 180) / Math.PI;
        if (ang > max) max = ang;
        if (ang > plusHaut.angle) plusHaut = { azimut: a * RELIEF_PAS_DEG, distance: d, angle: ang };
      });
      horizonDeg.push(Math.round(max * 10) / 10);
    }
    if (valides < points.length * 0.5) return null; // hors France ou service partiel
    plusHaut.angle = Math.round(plusHaut.angle * 10) / 10;
    return { horizonDeg, z0: Math.round(zSite), plusHaut };
  } catch {
    return null;
  }
}
