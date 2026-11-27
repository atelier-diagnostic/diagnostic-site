// Disponibilité du LiDAR HD de l'IGN autour du site.
//
// Le LiDAR HD est encore en cours de publication : sur un secteur non couvert,
// ses couches restent vides et l'outil se replie sur le RGE ALTI® (relief), la
// BD TOPO® (volumes) et CoSIA (canopée vue d'avion). On le dit clairement.
//
// Test : une petite image d'altitudes du MNT LiDAR (64 × 64 valeurs, WMS-R de
// la Géoplateforme, sans clé) sur le carré du rayon d'analyse ; la part des
// pixels valides donne la couverture.

const N = 64;
const MNT_LIDAR = "IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93";

export type EtatLidar = "publie" | "partiel" | "absent" | "indisponible";

export interface DispoLidar {
  etat: EtatLidar;
  /** Part du carré d'analyse couverte (%), null si non vérifiée. */
  couverturePct: number | null;
}

export const LIBELLE_DISPO_COURT: Record<EtatLidar, string> = {
  publie: "disponible",
  partiel: "en partie",
  absent: "non publié ici",
  indisponible: "non vérifié",
};

export function texteDispoLidar(d: DispoLidar): string {
  switch (d.etat) {
    case "publie":
      return "LiDAR HD disponible sur tout le secteur : relief au pas de 50 cm, canopée et volumes bâtis mesurés.";
    case "partiel":
      return `LiDAR HD disponible sur ${d.couverturePct} % du secteur seulement : ailleurs, relief RGE ALTI® (1 m), volumes BD TOPO® et canopée vue d'avion (CoSIA).`;
    case "absent":
      return "LiDAR HD pas encore publié sur ce secteur : les couches LiDAR restent vides ; relief RGE ALTI® (1 m), volumes extrudés BD TOPO® et canopée vue d'avion (CoSIA) à la place.";
    default:
      return "Disponibilité du LiDAR HD non vérifiée : le service de l'IGN ne répond pas (ce n'est pas une absence de LiDAR).";
  }
}

const cache = new Map<string, Promise<DispoLidar>>();

/** Couverture LiDAR HD sur le carré de demi-côté `rayonM` (au moins 100 m) autour du point. */
export function disponibiliteLidar(lat: number, lon: number, rayonM: number): Promise<DispoLidar> {
  const demi = Math.max(100, Math.min(rayonM, 2000));
  const cle = `${lat.toFixed(4)},${lon.toFixed(4)},${Math.round(demi / 50)}`;
  let p = cache.get(cle);
  if (!p) {
    p = verifier(lat, lon, demi);
    cache.set(cle, p);
    void p.then((d) => d.etat === "indisponible" && cache.delete(cle));
  }
  return p;
}

async function verifier(lat: number, lon: number, demi: number): Promise<DispoLidar> {
  const R = 6378137;
  const x = (R * lon * Math.PI) / 180;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  // Demi-côté en mètres Mercator (étirés de 1 / cos φ).
  const d = demi / Math.cos((lat * Math.PI) / 180);
  const url =
    "https://data.geopf.fr/wms-r?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap" +
    `&LAYERS=${MNT_LIDAR}&STYLES=&FORMAT=image/x-bil;bits=32&CRS=EPSG:3857` +
    `&BBOX=${x - d},${y - d},${x + d},${y + d}&WIDTH=${N}&HEIGHT=${N}`;
  for (let essai = 0; essai < 3; essai++) {
    try {
      const rep = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: essai ? "reload" : "default" });
      if (!rep.ok) throw new Error(String(rep.status));
      const buf = await rep.arrayBuffer();
      if (buf.byteLength < N * N * 4) throw new Error("réponse inattendue");
      const z = new Float32Array(buf, 0, N * N);
      let ok = 0;
      for (const v of z) if (Number.isFinite(v) && v > -1000 && v < 9000) ok++;
      const pct = Math.round((ok / z.length) * 100);
      return { etat: pct >= 95 ? "publie" : pct >= 5 ? "partiel" : "absent", couverturePct: pct };
    } catch {
      await new Promise((r) => setTimeout(r, 800 * (essai + 1)));
    }
  }
  return { etat: "indisponible", couverturePct: null };
}
