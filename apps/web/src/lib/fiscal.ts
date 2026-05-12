// Tabela progressiva IRRF — ate 2025 (Lei 11.482/2007 + ajustes)
// Piso da isencao: R$ 2.259,20
export const IR_TABLE_2025 = [
  { min: 0, max: 2259.2, rate: 0, deduction: 0 },
  { min: 2259.21, max: 2826.65, rate: 0.075, deduction: 169.44 },
  { min: 2826.66, max: 3751.05, rate: 0.15, deduction: 381.44 },
  { min: 3751.06, max: 4664.68, rate: 0.225, deduction: 662.77 },
  { min: 4664.69, max: Infinity, rate: 0.275, deduction: 896.0 },
];

// Tabela progressiva IRRF — a partir de 01/01/2026 (Lei 15.270/2025)
// Piso da isencao: R$ 5.000,00 (vale tambem para alugueis PJ -> PF)
// Faixa R$ 5.000,01 a R$ 7.350: aplica tabela normal MENOS reducao parcial
// Reducao = R$ 978,62 - (0,133145 x base de calculo)
// Acima de R$ 7.350: tabela progressiva normal sem reducao
//
// Fix Bug 23: tabela anterior tinha faixa invalida (min=5000.01, max=2826.65 — max < min).
// Reescrita corretamente com a tabela progressiva 2026 oficial.
export const IR_TABLE_2026 = [
  { min: 0, max: 2826.65, rate: 0, deduction: 0 },
  { min: 2826.66, max: 3751.05, rate: 0.075, deduction: 211.97 },
  { min: 3751.06, max: 4664.68, rate: 0.15, deduction: 493.79 },
  { min: 4664.69, max: 5752.4, rate: 0.225, deduction: 843.64 },
  { min: 5752.41, max: Infinity, rate: 0.275, deduction: 1131.26 },
];

// Mantem export antigo pra compatibilidade
export const IR_TABLE = IR_TABLE_2026;

const NEW_RULE_START = new Date("2026-01-01T00:00:00Z");

/**
 * Calcula IRRF mensal sobre uma base tributavel.
 * Aplica regra de 2025 ou 2026+ conforme a data de referencia.
 *
 * 2025 (e antes): piso isencao R$ 2.259,20 + tabela progressiva
 * 2026+ (Lei 15.270/2025):
 *   - Ate R$ 5.000: isento
 *   - R$ 5.000,01 a R$ 7.350: tabela progressiva MENOS reducao parcial
 *     (R$ 978,62 - 0,133145 x base)
 *   - Acima R$ 7.350: tabela progressiva normal
 */
export function calculateIRRF(monthlyTaxableIncome: number, refDate?: Date) {
  if (monthlyTaxableIncome <= 0) {
    return { taxableAmount: 0, rate: 0, deduction: 0, irrfValue: 0 };
  }

  const isNewRule = !refDate || refDate >= NEW_RULE_START;

  // Regra 2026+: isencao ate R$ 5.000
  if (isNewRule && monthlyTaxableIncome <= 5000) {
    return { taxableAmount: monthlyTaxableIncome, rate: 0, deduction: 0, irrfValue: 0 };
  }
  // Regra antiga: isencao ate R$ 2.259,20
  if (!isNewRule && monthlyTaxableIncome <= 2259.2) {
    return { taxableAmount: monthlyTaxableIncome, rate: 0, deduction: 0, irrfValue: 0 };
  }

  // Acima do piso: aplica tabela progressiva tradicional (mesma faixas)
  const PROGRESSIVE = [
    { min: 2259.21, max: 2826.65, rate: 0.075, deduction: 169.44 },
    { min: 2826.66, max: 3751.05, rate: 0.15, deduction: 381.44 },
    { min: 3751.06, max: 4664.68, rate: 0.225, deduction: 662.77 },
    { min: 4664.69, max: Infinity, rate: 0.275, deduction: 896.0 },
  ];

  const bracket =
    PROGRESSIVE.find((b) => monthlyTaxableIncome >= b.min && monthlyTaxableIncome <= b.max) ||
    PROGRESSIVE[PROGRESSIVE.length - 1];

  let irrf = monthlyTaxableIncome * bracket.rate - bracket.deduction;

  // Faixa de transicao 2026: R$ 5.000,01 a R$ 7.350 -> aplica reducao parcial
  if (isNewRule && monthlyTaxableIncome > 5000 && monthlyTaxableIncome <= 7350) {
    const reducao = Math.max(0, 978.62 - 0.133145 * monthlyTaxableIncome);
    irrf = Math.max(0, irrf - reducao);
  }

  return {
    taxableAmount: monthlyTaxableIncome,
    rate: bracket.rate,
    deduction: bracket.deduction,
    irrfValue: Math.max(0, Math.round(irrf * 100) / 100),
  };
}

/**
 * Calcula IRRF de aluguel apenas se houver retencao na fonte aplicavel.
 *
 * Regra fiscal RFB (atualizada Lei 15.270/2025 a partir de 01/01/2026):
 *
 * 1. SO ha retencao quando LOCADOR=PF e LOCATARIO=PJ
 *    - Locador PJ → recebe valor cheio (PJ declara como receita)
 *    - Locador PF + Locatario PF → sem retencao na fonte
 *
 * 2. Em 2026+, mesmo na configuracao PF→PJ, isento ate R$ 5.000/mes
 *    (limite ANTES era R$ 2.259,20)
 *
 * 3. Acima do piso, aplica tabela progressiva (com reducao parcial
 *    entre R$ 5.000,01 e R$ 7.350)
 *
 * @param grossToOwner aluguel bruto (apos taxa adm) que vai pro locador
 * @param ownerType PF ou PJ
 * @param tenantType PF ou PJ
 * @param refDate data de referencia (default = hoje). Pode ser dueDate
 *                ou paidAt do pagamento, pra recalcular boleto antigo
 *                com a regra que vigia na epoca.
 */
export function calculateIRRFRental(params: {
  grossToOwner: number;
  ownerType: "PF" | "PJ" | string | null | undefined;
  tenantType: "PF" | "PJ" | string | null | undefined;
  refDate?: Date;
}): ReturnType<typeof calculateIRRF> {
  const ownerIsPF = (params.ownerType || "PF").toUpperCase() === "PF";
  const tenantIsPJ = (params.tenantType || "PF").toUpperCase() === "PJ";
  if (!ownerIsPF || !tenantIsPJ) {
    return { taxableAmount: 0, rate: 0, deduction: 0, irrfValue: 0 };
  }
  return calculateIRRF(params.grossToOwner, params.refDate);
}

export interface FiscalMonthRow {
  month: number;
  label: string;
  grossRental: number;
  adminFee: number;
  netToOwner: number;
  maintenanceCost: number;
  taxableIncome: number;
  irrfRate: number;
  irrfValue: number;
}

export interface FiscalPropertySummary {
  propertyId: string;
  propertyTitle: string;
  months: FiscalMonthRow[];
  annualGross: number;
  annualAdminFee: number;
  annualNet: number;
  annualMaintenance: number;
  annualTaxable: number;
  annualIrrf: number;
}

export interface FiscalReportData {
  ownerId: string;
  ownerName: string;
  ownerCpfCnpj: string;
  personType: string;
  year: number;
  properties: FiscalPropertySummary[];
  totals: {
    grossRental: number;
    adminFee: number;
    netToOwner: number;
    maintenanceCost: number;
    taxableIncome: number;
    totalIrrf: number;
  };
  generatedAt: string;
}

export const MONTH_NAMES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];
