// Module Réglementaire — assemble le contrat DiagnosticModule.
// Scope "site" : zonage, SUP et risques sont propres au point/parcelle,
// indépendants du rayon d'analyse "quartier" (contrairement à Nature/Urbanisme/Soleil).
import type { DiagnosticModule, ExportBlock, SiteContext } from "../../core/types";
import { fetchReglementaire, type ReglementaireRaw } from "./fetch";
import { computeReglementaire, type ReglementaireResult } from "./compute";
import { renderReglementaire } from "./render";

export const reglementaireModule: DiagnosticModule<ReglementaireRaw, ReglementaireResult> = {
  id: "reglementaire",
  label: "Réglementaire",
  icon: "📋",
  scope: "site",

  fetchData(ctx: SiteContext) {
    return fetchReglementaire(ctx);
  },

  compute(raw: ReglementaireRaw) {
    return computeReglementaire(raw);
  },

  render(el: HTMLElement, result: ReglementaireResult) {
    renderReglementaire(el, result);
  },

  toExport(result: ReglementaireResult): ExportBlock {
    const zonageStr = result.isRnu
      ? "Règlement National d'Urbanisme (pas de PLU communal publié)"
      : result.zonageLibelle
        ? `Zone ${result.zonageLibelle}${result.zonageType ? ` (${result.zonageType})` : ""}`
        : "Zonage non trouvé sur le Géoportail de l'Urbanisme";

    return {
      moduleId: "reglementaire",
      title: "Réglementaire",
      summary:
        `${zonageStr}. ${result.supCount ?? "n.d."} servitude(s) d'utilité publique détectée(s), ` +
        `exposition RGA ${result.rgaExposition ?? "n.d."}, ${result.catnatCount ?? "n.d."} arrêté(s) ` +
        `de catastrophe naturelle sur les communes à moins de 1 km.`,
      indicators: [
        ...(result.surPerimetre
          ? [
              {
                label: "Périmètre de projet — zones du PLU",
                value:
                  result.zonagesPerimetre === null
                    ? "n.d. (service indisponible)"
                    : result.zonagesPerimetre.length
                      ? result.zonagesPerimetre.map((z) => `${z.libelle} ${z.pct} %`).join(" ; ")
                      : "aucune zone publiée",
              },
              ...(result.rgaParcelles.length
                ? [{ label: "Périmètre de projet — argiles par parcelle", value: result.rgaParcelles.map((x) => `${x.court} : ${x.exposition ?? "n.d."}`).join(" ; ") }]
                : []),
            ]
          : []),
        { label: result.surPerimetre ? "Zonage au centre du périmètre" : "Zonage", value: result.isRnu ? "RNU" : result.zonageLibelle ?? "n.d." },
        { label: result.surPerimetre ? "Servitudes (SUP) touchant le périmètre" : "Servitudes (SUP)", value: `${result.supCount ?? "n.d."}` },
        {
          label: result.surPerimetre ? "Patrimoine protégé sur le périmètre" : "Patrimoine protégé au point",
          value:
            result.patrimoineAuPoint === null
              ? "n.d."
              : result.patrimoineAuPoint.length
                ? result.patrimoineAuPoint.map((p) => ({ mh: "monument historique", abords: "abords de MH", site: "site classé/inscrit", spr: "SPR" })[p.genre] + (p.libelle ? ` (${p.libelle})` : "")).join(" ; ")
                : "aucune protection publiée",
        },
        ...(result.mhPlusProche ? [{ label: "Monument historique le plus proche", value: `${result.mhPlusProche.nom}, ${result.mhPlusProche.distanceM} m` }] : []),
        { label: "Exposition RGA", value: result.rgaExposition ?? "n.d." },
        {
          label: "Risques existants à l'adresse (Géorisques)",
          value: result.risquesDisponibles ? `${result.risquesAdresseCount}` : "n.d.",
        },
        { label: "Arrêtés CatNat (communes < 1 km)", value: `${result.catnatCount ?? "n.d."}` },
        ...(result.documentUrl ? [{ label: "Lien règlement", value: result.documentUrl }] : []),
      ],
      charts: [],
      notes: [
        "Sources : Géoportail de l'Urbanisme (via API Carto IGN), Géorisques (BRGM / Ministère " +
          "de la Transition écologique).",
        "La totalité des documents d'urbanisme et des SUP n'est pas encore publiée sur le GPU " +
          "(~20 % des communes, surtout rurales) : une absence de résultat ne garantit pas leur absence réelle.",
        result.surPerimetre
          ? "Périmètre de projet : zones du PLU découpées au contour des parcelles ; servitudes et protections patrimoniales qui touchent le périmètre ; argiles au centre de chaque parcelle."
          : "Le zonage correspond au point recherché, pas nécessairement à l'ensemble de la parcelle " +
            "si celle-ci est à cheval sur deux zones.",
        !result.risquesDisponibles
          ? "Synthèse Géorisques indisponible au moment de la génération (service à instabilité connue) — à régénérer ultérieurement."
          : "Exposition RGA moyenne/forte : une étude géotechnique G1/G2 (loi ÉLAN) est généralement requise pour une maison individuelle.",
        "Informations à visée de diagnostic amont : seule la mairie et les services de l'État " +
          "font foi pour l'instruction d'un dossier réel.",
      ],
    };
  },
};
