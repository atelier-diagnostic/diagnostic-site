// Tableau « périmètre de projet / rayon » : une même grandeur aux deux échelles.

export interface LigneDeuxEchelles {
  label: string;
  perimetre: string;
  rayon: string;
}

export function tableDeuxEchelles(lignes: LigneDeuxEchelles[], entetePerimetre: string, enteteRayon: string): string {
  return `<table class="deux-echelles">
    <thead><tr><th></th><th class="col-perimetre">${entetePerimetre}</th><th>${enteteRayon}</th></tr></thead>
    <tbody>${lignes.map((l) => `<tr><td>${l.label}</td><td class="col-perimetre">${l.perimetre}</td><td>${l.rayon}</td></tr>`).join("")}</tbody>
  </table>`;
}

const fr0 = (v: number) => v.toLocaleString("fr-FR", { maximumFractionDigits: 0 });

/** En-tête de colonne du périmètre : « Périmètre de projet · 1 245 m² ». */
export function entetePerimetre(surfaceM2: number): string {
  return `Périmètre de projet · ${fr0(surfaceM2)} m²`;
}
