/**
 * Helpers pra resolver a aliquota ISS (e Simples) usada na emissao de NFS-e.
 *
 * Preferencia (do mais especifico pro mais generico):
 *   1. MonthlyAliquota da competencia EXATA (ano, mes) se existir
 *   2. MonthlyAliquota mais recente ANTERIOR a competencia
 *      (util quando contabilidade ainda nao enviou apuracao do mes corrente)
 *   3. FiscalSettings.aliquotaIss (global)
 *   4. DEFAULT_ALIQUOTA (2%)
 *
 * Util porque no Simples Nacional a aliquota efetiva varia mes a mes
 * (depende do RBT12). Imobiliarias atualizam mensalmente via UI; e quando
 * a apuracao do mes ainda nao chegou da contabilidade, usar a do mes
 * anterior eh a pratica comum.
 */
import { prisma } from "./prisma";

export interface AliquotaResolvida {
  aliquotaIss: number;      // % (ex: 2.5 = 2,5%)
  simplesAliquota: number | null;
  origem: "MENSAL" | "ANTERIOR" | "GLOBAL" | "DEFAULT";
  competencia?: { ano: number; mes: number };           // competencia solicitada
  competenciaUsada?: { ano: number; mes: number };      // competencia que efetivamente forneceu a aliquota (= competencia quando origem=MENSAL; mes anterior quando origem=ANTERIOR)
}

const DEFAULT_ALIQUOTA = 2; // 2% padrao se nada configurado

/**
 * Converte (ano, mes) em um inteiro ordenavel YYYYMM, util pra comparar
 * competencias com `<` / `>` no banco.
 */
function toYearMonth(ano: number, mes: number): number {
  return ano * 100 + mes;
}

/**
 * Busca a aliquota efetiva pra uma competencia (ano/mes).
 * Cascata: MENSAL exato > ANTERIOR mais recente > GLOBAL > DEFAULT 2%.
 */
export async function getAliquotaParaCompetencia(
  ano: number,
  mes: number,
  fiscalSettingsAliquota?: number | null,
  fiscalSettingsSimples?: number | null,
): Promise<AliquotaResolvida> {
  const competenciaValida =
    Number.isInteger(ano) && Number.isInteger(mes) && mes >= 1 && mes <= 12;

  if (competenciaValida) {
    // 1. tenta o mes exato
    const exato = await prisma.monthlyAliquota.findUnique({
      where: { ano_mes: { ano, mes } },
    });
    if (exato) {
      return {
        aliquotaIss: exato.aliquotaIss,
        simplesAliquota: exato.simplesAliquota,
        origem: "MENSAL",
        competencia: { ano, mes },
        competenciaUsada: { ano, mes },
      };
    }

    // 2. tenta o mes anterior mais recente (qualquer ano <= ano+mes solicitados)
    const alvo = toYearMonth(ano, mes);
    const candidatos = await prisma.monthlyAliquota.findMany({
      where: {
        OR: [
          { ano: { lt: ano } },
          { AND: [{ ano }, { mes: { lt: mes } }] },
        ],
      },
      orderBy: [{ ano: "desc" }, { mes: "desc" }],
      take: 1,
    });
    const anterior = candidatos[0];
    if (anterior && toYearMonth(anterior.ano, anterior.mes) < alvo) {
      return {
        aliquotaIss: anterior.aliquotaIss,
        simplesAliquota: anterior.simplesAliquota,
        origem: "ANTERIOR",
        competencia: { ano, mes },
        competenciaUsada: { ano: anterior.ano, mes: anterior.mes },
      };
    }
  }

  if (typeof fiscalSettingsAliquota === "number" && fiscalSettingsAliquota > 0) {
    return {
      aliquotaIss: fiscalSettingsAliquota,
      simplesAliquota: typeof fiscalSettingsSimples === "number" ? fiscalSettingsSimples : null,
      origem: "GLOBAL",
      competencia: competenciaValida ? { ano, mes } : undefined,
    };
  }

  console.warn(
    `[fiscal-aliquota] Aliquota DEFAULT 2% usada — nenhuma alíquota mensal nem global configurada. ` +
    `Competência solicitada: ${ano}/${mes}. ` +
    `Configure em /configuracoes/fiscal pra evitar surpresas fiscais.`
  );

  return {
    aliquotaIss: DEFAULT_ALIQUOTA,
    simplesAliquota: null,
    origem: "DEFAULT",
    competencia: competenciaValida ? { ano, mes } : undefined,
  };
}

/**
 * Extrai (ano, mes) de uma data (Date). Util pra derivar competencia
 * a partir de entry.dueDate ou Date.now().
 */
export function competenciaFromDate(date: Date | null | undefined): { ano: number; mes: number } | null {
  if (!date) return null;
  return { ano: date.getFullYear(), mes: date.getMonth() + 1 };
}
