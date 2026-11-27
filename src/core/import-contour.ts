// Lecture d'un contour importé : GeoJSON, KML (Google Earth, QGIS) ou KMZ
// (KML zippé). Renvoie du GeoJSON, que src/core/perimetre.ts fusionne.

/** Lit le fichier et renvoie un GeoJSON (FeatureCollection pour un KML). */
export async function lireContour(fichier: File): Promise<unknown> {
  const nom = fichier.name.toLowerCase();
  if (nom.endsWith(".kmz")) return kmlVersGeoJson(await kmlDuKmz(await fichier.arrayBuffer()));
  const texte = await fichier.text();
  if (nom.endsWith(".kml") || /^\s*</.test(texte)) return kmlVersGeoJson(texte);
  return JSON.parse(texte);
}

/** Polygones d'un KML (Polygon, y compris dans les MultiGeometry), trous compris. */
export function kmlVersGeoJson(kml: string): { type: "FeatureCollection"; features: object[] } {
  const doc = new DOMParser().parseFromString(kml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("KML illisible");
  const anneau = (el: Element | null): [number, number][] =>
    (el?.textContent ?? "")
      .trim()
      .split(/\s+/)
      .map((t) => t.split(",").map(Number))
      .filter((c) => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
      .map((c) => [c[0], c[1]] as [number, number]);
  const features: object[] = [];
  // Espaces de noms variables selon les logiciels : on cherche par nom local.
  const tous = (racine: Element | Document, local: string) => Array.from(racine.getElementsByTagNameNS("*", local));
  for (const poly of tous(doc, "Polygon")) {
    const ext = anneau(tous(poly, "outerBoundaryIs")[0]?.getElementsByTagNameNS("*", "coordinates")[0] ?? null);
    if (ext.length < 4) continue;
    const trous = tous(poly, "innerBoundaryIs")
      .map((b) => anneau(b.getElementsByTagNameNS("*", "coordinates")[0] ?? null))
      .filter((r) => r.length >= 4);
    features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ext, ...trous] } });
  }
  return { type: "FeatureCollection", features };
}

/** Premier fichier .kml d'une archive KMZ (zip : stocké ou compressé « deflate »). */
async function kmlDuKmz(buf: ArrayBuffer): Promise<string> {
  const v = new DataView(buf);
  // Fin du répertoire central : signature 0x06054b50, cherchée depuis la fin.
  let fin = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65_557); i--)
    if (v.getUint32(i, true) === 0x06054b50) {
      fin = i;
      break;
    }
  if (fin < 0) throw new Error("KMZ illisible");
  const n = v.getUint16(fin + 10, true);
  let p = v.getUint32(fin + 16, true);
  const dec = new TextDecoder();
  for (let k = 0; k < n && v.getUint32(p, true) === 0x02014b50; k++) {
    const methode = v.getUint16(p + 10, true);
    const taille = v.getUint32(p + 20, true);
    const lnom = v.getUint16(p + 28, true), lextra = v.getUint16(p + 30, true), lcom = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const nom = dec.decode(new Uint8Array(buf, p + 46, lnom));
    p += 46 + lnom + lextra + lcom;
    if (!nom.toLowerCase().endsWith(".kml")) continue;
    const debut = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const donnees = new Uint8Array(buf, debut, taille);
    if (methode === 0) return dec.decode(donnees);
    if (methode === 8) {
      const flux = new Blob([donnees]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return await new Response(flux).text();
    }
    throw new Error("KMZ : compression non prise en charge");
  }
  throw new Error("KMZ sans fichier KML");
}
