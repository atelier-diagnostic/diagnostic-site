// Mode « produit » (multiplication) pour les couches raster en niveaux de
// gris, comme les ombrages LiDAR : MapLibre ne connaît que l'opacité, qui
// grise tout ce qui est dessous. On convertit chaque tuile en un voile noir
// dont l'opacité vaut 1 − luminance : posé sur n'importe quel fond, le
// résultat est exactement fond × luminance, soit le mode produit des logiciels
// de mise en page (le blanc disparaît, les ombres assombrissent sans griser).

import maplibregl from "maplibre-gl";

let enregistre = false;
/** Luminance du sol plat dans les ombrages IGN, ramenée au blanc. */
const PLAT = 0.78;

async function versProduit(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const bmp = await createImageBitmap(new Blob([buf]));
  const toile = new OffscreenCanvas(bmp.width, bmp.height);
  const g = toile.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  const img = g.getImageData(0, 0, bmp.width, bmp.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    // Les ombrages IGN posent le sol plat en gris clair (≈ 0,78) : ramené au
    // blanc, le plat devient transparent et seules les ombres assombrissent.
    const lum = Math.min(1, (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255 / PLAT);
    const a = d[i + 3] / 255; // zones sans donnée : restent transparentes
    d[i] = d[i + 1] = d[i + 2] = 0;
    d[i + 3] = Math.round((1 - lum) * a * 255);
  }
  g.putImageData(img, 0, 0);
  return (await toile.convertToBlob({ type: "image/png" })).arrayBuffer();
}

/** Protocole « produit:// » : même URL que la tuile d'origine, sans « https:// ». */
export function enregistrerProduit(): void {
  if (enregistre) return;
  enregistre = true;
  maplibregl.addProtocol("produit", async (params, abort) => {
    const rep = await fetch(params.url.replace(/^produit:\/\//, "https://"), { signal: abort.signal });
    if (!rep.ok) throw new Error(`Tuile : HTTP ${rep.status}`);
    return { data: await versProduit(await rep.arrayBuffer()) };
  });
}

export const enProduit = (url: string): string => url.replace(/^https:\/\//, "produit://");
