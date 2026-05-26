/**
 * Helpers pra resolver a aliquota ISS (e Simples) usada na emissao de NFS-e.
 *
 * Preferencia:
 *   1. MonthlyAliquota da competencia (ano, mes) se existir
 *   2. FiscalSettings.aliquotaIss (global) como fallback
 *
 * Util porque no Simples Nacional a aliquota efetiva varia mes a mes
 * (depende do RBT12). Imobiliarias atualizam mensalmente via UI.
 */
import { prisma } from "./prisma";

export interface AliquotaResolvida {
  aliquotaIss: number;      // % (ex: 2.5 = 2,5%)
  simplesAliquota: number | null;
  origem: "MENSAL" | "GLOBAL" | "DEFAULT";
  competencia?: { ano: number; mes: number };
}

const DEFAULT_ALIQUOTA = 2; // 2% padrao se nada configurado

/**
 * Busca a aliquota efetiva pra uma competencia (ano/mes).
 * - Se houver MonthlyAliquota cadastrada, usa ela
 * - Senao, cai pro FiscalSettings.aliquotaIss
 * - Senao, cai pra DEFAULT_ALIQUOTA (2%)
 */
export async function getAliquotaParaCompetencia(
  ano: number,
  mes: number,
  fiscalSettingsAliquota?: number | null,
  fiscalSettingsSimples?: number | null,
): Promise<AliquotaResolvida> {
  if (Number.isInteger(ano) && Number.isInteger(mes) && mes >= 1 && mes <= 12) {
    const mensal = await prisma.monthlyAliquota.findUnique({
      where: { ano_mes: { ano, mes } },
    });
    if (mensal) {
      return {
        aliquotaIss: mensal.aliquotaIss,
        simplesAliquota: mensal.simplesAliquota,
        origem: "MENSAL",
        competencia: { ano, mes },
      };
    }
  }

  if (typeof fiscalSettingsAliquota === "number" && fiscalSettingsAliquota > 0) {
    return {
      aliquotaIss: fiscalSettingsAliquota,
      simplesAliquota: typeof fiscalSettingsSimples === "number" ? fiscalSettingsSimples : null,
      origem: "GLOBAL",
    };
  }

  return {
    aliquotaIss: DEFAULT_ALIQUOTA,
    simplesAliquota: null,
    origem: "DEFAULT",
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
