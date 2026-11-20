// Caractère du climat du site : classification de Köppen-Geiger, grands traits
// chiffrés et zone climatique réglementaire (RE2020). Pur, sans I/O.
//
// Köppen-Geiger : critères de Peel, Finlayson et McMahon (2007), repris par
// Beck et al. (2018, 2023) : limite tempéré / continental à 0 °C pour le mois
// le plus froid, été = avril à septembre dans l'hémisphère nord. Calculée sur
// les normales 1991-2020 du point (réanalyse ERA5 via Open-Meteo), donc propre
// au site, pas lue sur une carte à maille large.

export interface Koppen {
  code: string;
  nom: string;
  description: string;
  /** Les valeurs qui décident de la classe, pour la montrer « à livre ouvert ». */
  criteres: string[];
}

const NOMS: Record<string, [string, string]> = {
  Csa: ["Méditerranéen à été chaud", "Été chaud et sec, hiver doux ; les pluies tombent surtout en automne et en hiver."],
  Csb: ["Méditerranéen à été tempéré", "Été sec mais modéré, hiver doux et pluvieux : littoral exposé ou relief méditerranéen."],
  Csc: ["Méditerranéen à été frais", "Été sec et court, hiver frais : altitude méditerranéenne."],
  Cfa: ["Subtropical humide", "Été chaud, hiver doux, pluies toute l'année sans saison sèche marquée."],
  Cfb: ["Océanique", "Températures modérées toute l'année, faible écart entre été et hiver, pluies régulières sans saison sèche."],
  Cfc: ["Océanique froid", "Été court et frais, hiver doux, pluies régulières."],
  Cwa: ["Tempéré à hiver sec, été chaud", "Pluies concentrées en été, hiver sec."],
  Cwb: ["Tempéré à hiver sec, été tempéré", "Pluies concentrées en été, hiver sec et doux."],
  Dfa: ["Continental humide à été chaud", "Hiver froid (mois le plus froid sous 0 °C), été chaud, pluies toute l'année."],
  Dfb: ["Continental humide à été tempéré", "Hiver froid (mois le plus froid sous 0 °C), été tempéré, pluies toute l'année : montagne moyenne, Est."],
  Dfc: ["Subarctique / montagnard", "Hiver long et froid, été court et frais : étage montagnard et subalpin."],
  Dsa: ["Continental méditerranéen à été chaud", "Hiver froid, été chaud et sec."],
  Dsb: ["Continental méditerranéen à été tempéré", "Hiver froid, été sec et tempéré : montagne méditerranéenne."],
  Dsc: ["Continental méditerranéen à été frais", "Hiver froid et long, été sec et court : haute montagne méditerranéenne."],
  ET: ["Climat de toundra / haute montagne", "Aucun mois au-dessus de 10 °C : étage alpin."],
  EF: ["Glaciaire", "Aucun mois au-dessus de 0 °C."],
  BSk: ["Semi-aride froid (steppe)", "Pluies insuffisantes au regard de l'évaporation, moyenne annuelle sous 18 °C."],
  BSh: ["Semi-aride chaud (steppe)", "Pluies insuffisantes au regard de l'évaporation, moyenne annuelle d'au moins 18 °C."],
  BWk: ["Aride froid (désert)", "Très faibles pluies, moyenne annuelle sous 18 °C."],
  BWh: ["Aride chaud (désert)", "Très faibles pluies, moyenne annuelle d'au moins 18 °C."],
};

const fr = (v: number, d = 1) => v.toLocaleString("fr-FR", { maximumFractionDigits: d });

/** tMoy et precip : 12 valeurs mensuelles (janvier d'abord). lat : pour l'hémisphère (été = avr.–sept. au nord). */
export function koppen(tMoy: number[], precip: number[], lat: number): Koppen {
  const ete = lat >= 0 ? [3, 4, 5, 6, 7, 8] : [9, 10, 11, 0, 1, 2];
  const hiver = [...Array(12).keys()].filter((m) => !ete.includes(m));
  const tFroid = Math.min(...tMoy), tChaud = Math.max(...tMoy);
  const MAT = tMoy.reduce((a, b) => a + b, 0) / 12;
  const MAP = precip.reduce((a, b) => a + b, 0);
  const pEte = ete.reduce((a, m) => a + precip[m], 0), pHiver = MAP - pEte;
  const pSecEte = Math.min(...ete.map((m) => precip[m])), pHumEte = Math.max(...ete.map((m) => precip[m]));
  const pSecHiver = Math.min(...hiver.map((m) => precip[m])), pHumHiver = Math.max(...hiver.map((m) => precip[m]));
  const pSeuil = pHiver >= 0.7 * MAP ? 2 * MAT : pEte >= 0.7 * MAP ? 2 * MAT + 28 : 2 * MAT + 14;
  const mois10 = tMoy.filter((t) => t >= 10).length;
  const criteres = [
    `mois le plus froid ${fr(tFroid)} °C, le plus chaud ${fr(tChaud)} °C`,
    `${mois10} mois à 10 °C ou plus`,
    `pluie annuelle ${fr(MAP, 0)} mm (seuil d'aridité ${fr(10 * pSeuil, 0)} mm)`,
    `mois d'été le plus sec ${fr(pSecEte, 0)} mm, mois d'hiver le plus pluvieux ${fr(pHumHiver, 0)} mm`,
  ];
  let code: string;
  if (tChaud < 10) code = tChaud > 0 ? "ET" : "EF";
  else if (MAP < 10 * pSeuil) code = (MAP < 5 * pSeuil ? "BW" : "BS") + (MAT >= 18 ? "h" : "k");
  else {
    const groupe = tFroid >= 18 ? "A" : tFroid > 0 ? "C" : "D";
    if (groupe === "A") code = "A";
    else {
      const sec = pSecEte < 40 && pSecEte < pHumHiver / 3 ? "s" : pSecHiver < pHumEte / 10 ? "w" : "f";
      const chaleur = tChaud >= 22 ? "a" : mois10 >= 4 ? "b" : groupe === "D" && tFroid < -38 ? "d" : "c";
      code = groupe + sec + chaleur;
    }
  }
  const [nom, description] = NOMS[code] ?? [code === "A" ? "Tropical" : code, ""];
  return { code, nom, description, criteres };
}

export interface Traits {
  /** Écart entre le mois le plus chaud et le plus froid (°C). */
  amplitude: number;
  /** Indice de continentalité de Gorczyński (0 : océanique pur, 100 : continental extrême). */
  continentalite: number;
  lectureContinentalite: string;
  pluieAnnuelle: number;
  /** Mois secs au sens de Gaussen (P < 2T). */
  moisSecs: number[];
  /** Évapotranspiration de référence annuelle (mm) et bilan P − ETP (mm). */
  etp: number;
  bilan: number;
  /** Bilan hydrique d'été (juin à août, mm). */
  bilanEte: number;
  /** Rayonnement solaire global annuel (kWh/m²). */
  rayonnementKwh: number;
}

export function traits(m: { tMean: number[]; precip: number[]; et0: number[]; rayonnement: number[] }, lat: number): Traits {
  const amplitude = Math.max(...m.tMean) - Math.min(...m.tMean);
  const s = Math.sin((Math.abs(lat) * Math.PI) / 180) || 1;
  const k = Math.max(0, Math.round(((1.7 * amplitude) / s - 20.4) * 10) / 10);
  // Lecture sur l'amplitude elle-même : les indices de continentalité classent
  // à tort le littoral méditerranéen (étés chauds) parmi les climats continentaux.
  const lecture = amplitude < 12 ? "faible, influence océanique" : amplitude < 16 ? "modérée" : "forte";
  const somme = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const etp = somme(m.et0), pluie = somme(m.precip);
  return {
    amplitude: Math.round(amplitude * 10) / 10,
    continentalite: k,
    lectureContinentalite: lecture,
    pluieAnnuelle: Math.round(pluie),
    moisSecs: m.tMean.map((t, i) => (m.precip[i] < 2 * t ? i : -1)).filter((i) => i >= 0),
    etp: Math.round(etp),
    bilan: Math.round(pluie - etp),
    bilanEte: Math.round([5, 6, 7].reduce((a, i) => a + m.precip[i] - m.et0[i], 0)),
    rayonnementKwh: Math.round(somme(m.rayonnement) / 3.6),
  };
}

// --- Zone climatique réglementaire (RE2020, arrêté du 4 août 2021, annexe) ---------
const ZONES: Record<string, string> = {};
const affecter = (zone: string, deps: string) => deps.split(" ").forEach((d) => (ZONES[d] = zone));
affecter("H1a", "02 14 27 28 59 60 61 62 75 76 77 78 80 91 92 93 94 95");
affecter("H1b", "08 10 45 51 52 54 55 57 58 67 68 70 88 89 90");
affecter("H1c", "01 03 05 15 19 21 23 25 38 39 42 43 63 69 71 73 74 87");
affecter("H2a", "22 29 35 50 56");
affecter("H2b", "16 17 18 36 37 41 44 49 53 72 79 85 86");
affecter("H2c", "09 12 24 31 32 33 40 46 47 64 65 81 82");
affecter("H2d", "04 07 26 48 84");
affecter("H3", "06 11 13 2A 2B 30 34 66 83");

export interface ZoneRE2020 {
  zone: string;
  /** Classe d'altitude de la réglementation : ≤ 400 m, 401 à 800 m, > 800 m. */
  altitude: string | null;
  departement: string;
}

export function zoneRE2020(insee: string | undefined, altitude: number | null): ZoneRE2020 | null {
  if (!insee) return null;
  const dep = insee.startsWith("97") ? insee.slice(0, 3) : insee.slice(0, 2);
  const zone = ZONES[dep];
  if (!zone) return null;
  const alt = altitude === null ? null : altitude <= 400 ? "jusqu'à 400 m" : altitude <= 800 ? "de 401 à 800 m" : "au-dessus de 800 m";
  return { zone, altitude: alt, departement: dep };
}

export const MOIS_LONGS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
