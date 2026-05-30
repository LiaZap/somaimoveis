/**
 * Regra de negocio Somma (definida pelo Leo Mai/2026):
 *
 * Pra calcular a taxa de administracao, SO descontos relacionados a
 * ALUGUEL devem ser subtraidos do aluguel bruto. Descontos de outras
 * categorias (seguro fianca, IPTU, condominio, taxas bancarias, etc)
 * NAO entram no calculo — a imobiliaria recebe os 10% sobre o aluguel
 * cheio, independente de descontos de seguro/iptu.
 *
 * Antes (errado): qualquer CREDITO no Payment.notes.lancamentos era
 * tratado como desconto e reduzia a base de calculo da taxa adm.
 * Resultado: cobravamos taxa adm a menos quando havia desconto de
 * seguro fianca ou similar.
 *
 * Esta funcao decide se um lancamento individual conta como
 * "desconto de aluguel" pra fins de reducao da base.
 */

export interface LancamentoMinimo {
  tipo?: string;
  categoria?: string;
  descricao?: string;
  valor?: number;
}

/**
 * Retorna true se o lancamento eh um desconto que deve REDUZIR a base
 * de calculo da taxa de administracao.
 *
 * Criterios (qualquer um basta):
 *   1. tipo=CREDITO + categoria=ALUGUEL (TenantEntry CREDITO de aluguel —
 *      classificacao explicita pelo admin)
 *   2. tipo=CREDITO + categoria=DESCONTO + descricao menciona "aluguel"
 *      (desconto generico mas explicitamente sobre aluguel)
 *
 * EXCLUI:
 *   - categoria=SEGURO_FIANCA, SEGURO, IPTU, CONDOMINIO, AGUA, LUZ, GAS,
 *     TAXA_BANCARIA, MULTA, REPARO, INTERMEDIACAO, OUTROS
 *   - categoria=DESCONTO sem mencao a aluguel na descricao
 */
export function isDescontoDeAluguel(l: LancamentoMinimo): boolean {
  if (l.tipo !== "CREDITO") return false;
  if (typeof l.valor !== "number" || l.valor <= 0) return false;

  const cat = (l.categoria || "").toUpperCase();

  // 1. Categoria explicita ALUGUEL
  if (cat === "ALUGUEL") return true;

  // 2. DESCONTO generico + descricao menciona aluguel
  if (cat === "DESCONTO") {
    const desc = (l.descricao || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (/aluguel|rent|loca[cç][aã]o/.test(desc)) return true;
  }

  return false;
}

/**
 * Soma o total de descontos VALIDOS (apenas aluguel) de um array de
 * lancamentos. Use no lugar do somatorio generico de CREDITOs.
 */
export function somaDescontosAluguel(lancamentos: LancamentoMinimo[]): number {
  return lancamentos
    .filter(isDescontoDeAluguel)
    .reduce((sum, l) => sum + (l.valor || 0), 0);
}
