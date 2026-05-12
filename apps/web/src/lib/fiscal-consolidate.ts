import type { PrismaClient } from "@prisma/client";
import { calculateIRRF } from "./fiscal";

/**
 * Distribui um valor total de IRRF proporcionalmente sobre uma lista de bases
 * (grossToOwner por boleto). O Payment de maior base absorve o drift de
 * arredondamento, garantindo soma exata ao centavo.
 *
 * Funcao pura, sem efeitos colaterais — facil de testar.
 */
export function distributeIRRF(grossList: number[], irrfTotal: number): number[] {
  const n = grossList.length;
  if (n === 0) return [];
  if (irrfTotal <= 0) return grossList.map(() => 0);
  const soma = grossList.reduce((s, v) => s + v, 0);
  if (soma <= 0) return grossList.map(() => 0);

  // Indice ordenado desc por base (maior primeiro absorve drift)
  const order = grossList.map((_, i) => i).sort((a, b) => grossList[b] - grossList[a]);

  const result = new Array<number>(n).fill(0);
  let acumulado = 0;
  // Distribui partes proporcionais para todos exceto o maior (indice 0 da ordem)
  for (let k = 1; k < n; k++) {
    const i = order[k];
    const parte = Math.round((irrfTotal * grossList[i]) / soma * 100) / 100;
    result[i] = parte;
    acumulado += parte;
  }
  // Maior absorve o resto
  const iggMaior = order[0];
  result[iggMaior] = Math.round((irrfTotal - acumulado) * 100) / 100;
  return result;
}

export interface ConsolidationGroup {
  ownerId: string;
  ownerName: string;
  ownerCpfCnpj: string;
  paymentIds: string[];
  somaGross: number;
  irrfTotal: number;
  irrfRate: number;
  distribuicao: { paymentId: string; grossToOwner: number; irrfValue: number; netToOwner: number }[];
}

export interface ConsolidationReport {
  refMonth: string; // YYYY-MM
  totalGroups: number;
  totalPayments: number;
  totalIrrf: number;
  groups: ConsolidationGroup[];
  skipped: { reason: string; count: number }[];
  applied: boolean;
}

/**
 * Agrupa Payments do mes por CPF do proprietario (PF), aplica a tabela
 * progressiva sobre a soma de cada grupo e distribui o IRRF proporcionalmente
 * de volta para cada Payment do grupo.
 *
 * - Apenas Payments com owner.personType=PF e tenant.personType=PJ entram no
 *   calculo (regra de retencao na fonte).
 * - Idempotente: rodar duas vezes produz o mesmo resultado.
 * - dryRun=true nao escreve no banco; retorna apenas o relatorio.
 */
export async function consolidateIRRFByOwnerMonth(
  prisma: PrismaClient,
  input: {
    refMonth: Date;            // Primeiro dia do mes alvo (qualquer Date sera normalizado)
    ownerCpfCnpj?: string;     // Opcional: rodar para um CPF apenas
    dryRun?: boolean;
  }
): Promise<ConsolidationReport> {
  const monthStart = new Date(input.refMonth.getFullYear(), input.refMonth.getMonth(), 1);
  const monthEnd = new Date(input.refMonth.getFullYear(), input.refMonth.getMonth() + 1, 1);
  const refMonthLabel = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`;

  const payments = await prisma.payment.findMany({
    where: {
      dueDate: { gte: monthStart, lt: monthEnd },
      status: { not: "CANCELADO" },
    },
    include: {
      owner: { select: { id: true, name: true, cpfCnpj: true, personType: true } },
      tenant: { select: { personType: true } },
    },
  });

  const skippedCounts = { ownerNaoPF: 0, tenantNaoPJ: 0, semGross: 0, foraDoCpfFiltro: 0 };

  const eligible = payments.filter((p) => {
    const ownerPF = (p.owner?.personType || "PF").toUpperCase() === "PF";
    if (!ownerPF) {
      skippedCounts.ownerNaoPF++;
      return false;
    }
    const tenantPJ = (p.tenant?.personType || "PF").toUpperCase() === "PJ";
    if (!tenantPJ) {
      skippedCounts.tenantNaoPJ++;
      return false;
    }
    if (!p.grossToOwner || p.grossToOwner <= 0) {
      skippedCounts.semGross++;
      return false;
    }
    if (input.ownerCpfCnpj && p.owner?.cpfCnpj !== input.ownerCpfCnpj) {
      skippedCounts.foraDoCpfFiltro++;
      return false;
    }
    return true;
  });

  // Agrupa por CPF do owner
  const groupsByCpf = new Map<string, typeof eligible>();
  for (const p of eligible) {
    const cpf = p.owner?.cpfCnpj || "SEM_CPF";
    const arr = groupsByCpf.get(cpf) || [];
    arr.push(p);
    groupsByCpf.set(cpf, arr);
  }

  const groups: ConsolidationGroup[] = [];
  let totalIrrf = 0;

  for (const [cpf, list] of groupsByCpf) {
    const somaGross = list.reduce((s, p) => s + (p.grossToOwner || 0), 0);
    const irrf = calculateIRRF(somaGross, monthStart);
    const irrfTotal = irrf.irrfValue;
    const grossList = list.map((p) => p.grossToOwner || 0);
    const partes = distributeIRRF(grossList, irrfTotal);
    const irrfRate = somaGross > 0 ? Math.round((irrfTotal / somaGross) * 10000) / 10000 : 0;

    const distribuicao = list.map((p, i) => {
      const irrfValue = partes[i];
      const grossToOwner = p.grossToOwner || 0;
      return {
        paymentId: p.id,
        grossToOwner,
        irrfValue,
        netToOwner: Math.round((grossToOwner - irrfValue) * 100) / 100,
      };
    });

    groups.push({
      ownerId: list[0].ownerId,
      ownerName: list[0].owner?.name || "(sem nome)",
      ownerCpfCnpj: cpf,
      paymentIds: list.map((p) => p.id),
      somaGross: Math.round(somaGross * 100) / 100,
      irrfTotal,
      irrfRate,
      distribuicao,
    });
    totalIrrf += irrfTotal;
  }

  const applied = !input.dryRun;
  if (applied) {
    // Atualiza Payments e OwnerEntry.notes em transacao
    await prisma.$transaction(async (tx) => {
      for (const g of groups) {
        for (const d of g.distribuicao) {
          await tx.payment.update({
            where: { id: d.paymentId },
            data: {
              irrfValue: d.irrfValue,
              irrfRate: g.irrfRate,
              netToOwner: d.netToOwner,
            },
          });

          // Atualiza OwnerEntry REPASSE correspondente (se existir)
          const payment = await tx.payment.findUnique({
            where: { id: d.paymentId },
            select: { contractId: true, dueDate: true },
          });
          if (!payment) continue;
          const ownerEntries = await tx.ownerEntry.findMany({
            where: {
              contractId: payment.contractId,
              dueDate: payment.dueDate,
              category: { in: ["REPASSE", "GARANTIA"] },
            },
          });
          for (const oe of ownerEntries) {
            let notes: Record<string, unknown> = {};
            if (oe.notes) {
              try { notes = JSON.parse(oe.notes); } catch {}
            }
            // sharePercent vem das notes ou e 100 quando ausente (sem coproprietarios)
            const sharePctRaw = (notes as any).sharePercent;
            const sharePct = typeof sharePctRaw === "number" ? sharePctRaw : 100;
            const isCoOwner = sharePct < 100;
            const shareRatio = sharePct / 100;
            // Fix Bug 24: irrfValue e netToOwner em notes devem ser PROPORCIONAIS
            // ao sharePercent (igual ao Bug 4 do buildOwnerNotes). Antes
            // gravava o valor do CONTRATO TODO em todas as entries de
            // coproprietarios — demonstrativos liam o valor cheio em cada
            // co-owner e mostravam IRRF totalmente errado.
            notes.irrfValue = isCoOwner
              ? Math.round(d.irrfValue * shareRatio * 100) / 100
              : d.irrfValue;
            notes.irrfRate = g.irrfRate;
            notes.netToOwner = isCoOwner
              ? Math.round(d.netToOwner * shareRatio * 100) / 100
              : d.netToOwner;
            notes.irrfConsolidatedAt = new Date().toISOString();
            const dataToUpdate: Record<string, unknown> = { notes: JSON.stringify(notes) };
            if (!isCoOwner) {
              // Sem coproprietarios: value = netToOwner (mesmo comportamento de antes)
              dataToUpdate.value = d.netToOwner;
            }
            // Caso coproprietario: NAO mexer em value — mantem o rateio original
            await tx.ownerEntry.update({
              where: { id: oe.id },
              data: dataToUpdate,
            });
          }
        }
      }
    }, { timeout: 60_000 });
  }

  const skipped: { reason: string; count: number }[] = [];
  if (skippedCounts.ownerNaoPF > 0) skipped.push({ reason: "Proprietario PJ (sem retencao)", count: skippedCounts.ownerNaoPF });
  if (skippedCounts.tenantNaoPJ > 0) skipped.push({ reason: "Inquilino PF (sem retencao)", count: skippedCounts.tenantNaoPJ });
  if (skippedCounts.semGross > 0) skipped.push({ reason: "Sem grossToOwner gravado", count: skippedCounts.semGross });
  if (skippedCounts.foraDoCpfFiltro > 0) skipped.push({ reason: "Fora do CPF filtrado", count: skippedCounts.foraDoCpfFiltro });

  return {
    refMonth: refMonthLabel,
    totalGroups: groups.length,
    totalPayments: groups.reduce((s, g) => s + g.paymentIds.length, 0),
    totalIrrf: Math.round(totalIrrf * 100) / 100,
    groups,
    skipped,
    applied,
  };
}
