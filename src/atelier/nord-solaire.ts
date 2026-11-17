// Nord solaire des planches (modèle fourni par Cédric le 17/11) : flèche du
// nord, horizon vu en plan légèrement incliné, courses du soleil aux
// solstices et aux équinoxes, directions et heures (solaires) de lever et de
// coucher, hauteur du soleil à midi. Calculé pour la latitude du site.
//
// Le dessin est produit en primitives (mm, origine au centre du symbole),
// rendues ensuite en vectoriel dans le PDF et sur le canevas du PNG.

export type Primitive =
  | { t: "ligne"; pts: [number, number][]; e: number; ferme?: boolean }
  | { t: "plein"; pts: [number, number][] }
  | { t: "disque"; x: number; y: number; r: number }
  | { t: "texte"; x: number; y: number; s: string; taille: number; align: "left" | "center" | "right"; gras?: boolean };

const RAD = Math.PI / 180;

/** Heure solaire décimale → « 4h30 » (au quart d'heure). */
function heure(h: number): string {
  const q = Math.round(h * 4) / 4;
  const hh = Math.floor(q);
  const mm = Math.round((q - hh) * 60);
  return mm ? `${hh}h${String(mm).padStart(2, "0")}` : `${hh}h`;
}

/**
 * Symbole pour un rayon R (mm) du cercle ; occupe environ 2,6 R de large et
 * 2,9 R de haut (textes compris).
 */
export function nordSolaire(lat: number, R: number): Primitive[] {
  const phi = lat * RAD;
  const k = 0.8; // aplatissement de l'horizon (vue légèrement inclinée)
  const m = 0.13; // la hauteur du soleil abaisse un peu le point (lecture du modèle)
  // Point du ciel (azimut depuis le nord, hauteur) → plan du symbole (y vers le bas).
  const P = (azDeg: number, elDeg: number): [number, number] => {
    const az = azDeg * RAD, el = Math.max(0, elDeg) * RAD;
    return [R * Math.cos(el) * Math.sin(az), R * (-k * Math.cos(el) * Math.cos(az) + m * Math.sin(el))];
  };
  const out: Primitive[] = [];
  const e = R * 0.012; // épaisseur de trait
  const txt = R * 0.12; // corps des textes (mm)

  // Sphère et horizon.
  out.push({ t: "ligne", pts: Array.from({ length: 73 }, (_, i) => [R * Math.cos(i * 5 * RAD), R * Math.sin(i * 5 * RAD)] as [number, number]), e });
  out.push({ t: "ligne", pts: Array.from({ length: 73 }, (_, i) => P(i * 5, 0)), e });
  // Axes est-ouest et nord-sud.
  out.push({ t: "ligne", pts: [[-R * 1.22, 0], [R * 1.22, 0]], e });
  out.push({ t: "ligne", pts: [[0, 0], [0, R * 1.22]], e });

  const jours: { nom: string; dec: number }[] = [
    { nom: "été", dec: 23.44 },
    { nom: "équinoxes", dec: 0 },
    { nom: "hiver", dec: -23.44 },
  ];
  let soleilLeve: [number, number] | null = null;
  for (const j of jours) {
    const d = j.dec * RAD;
    const cosH0 = -Math.tan(phi) * Math.tan(d);
    if (cosH0 <= -1 || cosH0 >= 1) continue; // jour ou nuit polaire : pas de lever
    const H0 = Math.acos(cosH0) / RAD; // demi-arc diurne (°)
    // Course du jour, du lever au coucher.
    const pts: [number, number][] = [];
    for (let H = -H0; H <= H0 + 1e-6; H += H0 / 40) {
      const h = H * RAD;
      const sinEl = Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(h);
      const el = Math.asin(sinEl);
      const az = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(phi) - Math.tan(d) * Math.cos(phi)) / RAD + 180;
      pts.push(P(az, el / RAD));
    }
    out.push({ t: "ligne", pts, e });
    // Lever et coucher : direction depuis le centre, prolongée jusqu'au cercle, et heure.
    const azLever = Math.acos(Math.max(-1, Math.min(1, Math.sin(d) / Math.cos(phi)))) / RAD;
    const hLever = 12 - H0 / 15;
    for (const [az, h, gauche] of [[azLever, hLever, false], [360 - azLever, 24 - hLever, true]] as const) {
      const [x, y] = P(az, 0);
      const n = Math.hypot(x, y) || 1;
      const L = R * 1.18;
      out.push({ t: "ligne", pts: [[-(x / n) * L * 0.2, -(y / n) * L * 0.2], [(x / n) * L, (y / n) * L]], e: e * 0.8 });
      out.push({ t: "texte", x: x * 0.93 + (gauche ? R * 0.02 : -R * 0.02), y: y * 0.93 - R * 0.04, s: heure(h), taille: txt * 0.85, align: gauche ? "left" : "right" });
      if (!gauche && j.dec > 0) soleilLeve = [x, y];
    }
    // Hauteur à midi.
    const elMidi = 90 - lat + j.dec;
    const [, ym] = P(180, elMidi);
    // Nom au-dessus de l'arc à gauche de l'axe, hauteur sous l'arc à droite (lecture du modèle).
    out.push({ t: "texte", x: -R * 0.04, y: ym - R * 0.025, s: j.nom, taille: txt * 0.85, align: "right" });
    out.push({ t: "texte", x: R * 0.04, y: ym + R * 0.105, s: `${Math.round(elMidi)}°`, taille: txt * 0.9, align: "left" });
  }
  out.push({ t: "texte", x: -R * 0.04, y: R * 1.1, s: "12h", taille: txt * 0.85, align: "right" });

  // Flèche du nord (pointe fine, noire).
  out.push({ t: "plein", pts: [[0, -R * 1.32], [R * 0.055, 0], [-R * 0.055, 0]] });
  // Soleil levant d'été.
  if (soleilLeve) {
    const [sx, sy] = soleilLeve;
    const rs = R * 0.085;
    out.push({ t: "disque", x: sx + rs * 0.6, y: sy, r: rs });
    for (let a = -90; a <= 90; a += 30) {
      const c = Math.cos(a * RAD), s = Math.sin(a * RAD);
      out.push({ t: "ligne", pts: [[sx + rs * 0.6 + c * rs * 1.45, sy + s * rs * 1.45], [sx + rs * 0.6 + c * rs * 2.1, sy + s * rs * 2.1]], e: e * 1.6 });
    }
  }
  // Points cardinaux.
  out.push({ t: "texte", x: 0, y: -R * 1.38, s: "NORD", taille: txt * 1.5, align: "center" });
  out.push({ t: "texte", x: 0, y: R * 1.42, s: "SUD", taille: txt * 1.5, align: "center" });
  out.push({ t: "texte", x: -R * 1.24, y: -R * 0.05, s: "OUEST", taille: txt * 1.35, align: "right" });
  out.push({ t: "texte", x: R * 1.24, y: -R * 0.05, s: "EST", taille: txt * 1.35, align: "left" });
  return out;
}

/** Encombrement (mm) autour du centre, pour le cartouche blanc : [gauche, haut, droite, bas]. */
export function encombrement(R: number): [number, number, number, number] {
  return [R * 2.05, R * 1.62, R * 1.75, R * 1.55];
}
