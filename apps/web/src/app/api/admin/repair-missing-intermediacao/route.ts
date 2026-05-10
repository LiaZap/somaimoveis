import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * POST /api/admin/repair-missing-intermediacao?dryRun=true&month=YYYY-MM
 *
 * Detecta contratos com `intermediationFee > 0` onde a intermediacao nao
 * foi cobrada (cobradoInline + cobradoManualPrev < totalPrevista).
 *
 * Causa raiz: Payments criados via "Nova Cobranca" manual no /financeiro
 * pulam a logica do billing/generate que aplicaria intermediacao inline.
 *
 * Pra cada contrato com falta:
 *   - Calcula quanto CABE no mes corrente (aluguel - adminFee - intermediacoesJa)
 *   - Cria 1 OwnerEntry DEBITO INTERMEDIACAO com `min(falta, cabe)`
 *   - Atualiza contract.intermediacaoSaldoPendente com o restante
 *     (proximo billing/generate cobra automaticamente)
 *
 * Idempotente: ja considera DEBITOs INTERMEDIACAO existentes do contrato
 * em qualquer mes pra nao duplicar.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const dryRun = searchParams.get("dryRun") === "true";
    const monthStr = searchParams.get("month");

    let targetYear: number, targetMonth: number;
    if (monthStr && /^\d{4}-\d{2}$/.test(monthStr)) {
      const [y, m] = monthStr.split("-").map(Number);
      targetYear = y;
      targetMonth = m - 1;
    } else {
      const now = new Date();
      targetYear = now.getFullYear();
      targetMonth = now.getMonth();
    }

    const monthStart = new Date(targetYear, targetMonth, 1);
    const monthEnd = new Date(targetYear, targetMonth + 1, 1);

    // Pega contratos ativos com intermediacao
    const contracts = await prisma.contract.findMany({
      where: {
        status: { in: ["ATIVO", "PENDENTE_RENOVACAO"] },
        intermediationFee: { gt: 0 },
      },
      select: {
        id: true,
        code: true,
        ownerId: true,
        propertyId: true,
        rentalValue: true,
        adminFeePercent: true,
        intermediationFee: true,
        intermediationInstallments: true,
        intermediacaoSaldoPendente: true,
        owner: { select: { name: true } },
      },
    });

    // Pra cada contrato, soma cobradoInline (notes.intermediacao em REPASSEs)
    // e cobradoManual (DEBITOs INTERMEDIACAO em qualquer mes)
    const cobradosByContract: Record<string, number> = {};
    const repasses = await prisma.ownerEntry.findMany({
      where: { category: { in: ["REPASSE", "GARANTIA"] }, contractId: { in: contracts.map((c) => c.id) } },
      select: { contractId: true, notes: true },
    });
    for (const r of repasses) {
      if (!r.contractId || !r.notes) continue;
      try {
        const n = JSON.parse(r.notes);
        const interm = typeof n.intermediacao === "number" ? n.intermediacao : 0;
        if (interm > 0) {
          cobradosByContract[r.contractId] = (cobradosByContract[r.contractId] || 0) + interm;
        }
      } catch {}
    }
    const debitosManuais = await prisma.ownerEntry.findMany({
      where: { category: "INTERMEDIACAO", type: "DEBITO", contractId: { in: contracts.map((c) => c.id) }, status: { not: "CANCELADO" } },
      select: { contractId: true, value: true },
    });
    for (const d of debitosManuais) {
      if (!d.contractId) continue;
      cobradosByContract[d.contractId] = (cobradosByContract[d.contractId] || 0) + d.value;
    }

    // Calcula proposta pra cada contrato
    const propostas: {
      contractId: string;
      code: string;
      owner: string;
      totalPrevista: number;
      cobrado: number;
      falta: number;
      cabeNoMes: number;
      vaiCobrarAgora: number;
      novoSaldoPendente: number;
    }[] = [];

    for (const c of contracts) {
      const totalPrevista = Math.round(c.rentalValue * c.intermediationFee! / 100 * 100) / 100;
      const cobrado = Math.round((cobradosByContract[c.id] || 0) * 100) / 100;
      const falta = Math.round((totalPrevista - cobrado) * 100) / 100;
      if (falta <= 0.01) continue;

      const adminPct = c.adminFeePercent || 10;
      const adminFee = Math.round(c.rentalValue * (adminPct / 100) * 100) / 100;
      const cabeNoMes = Math.round((c.rentalValue - adminFee) * 100) / 100;
      const vaiCobrarAgora = Math.min(falta, cabeNoMes);
      const novoSaldoPendente = Math.round((falta - vaiCobrarAgora) * 100) / 100;

      propostas.push({
        contractId: c.id,
        code: c.code,
        owner: c.owner?.name || "?",
        totalPrevista,
        cobrado,
        falta,
        cabeNoMes,
        vaiCobrarAgora: Math.round(vaiCobrarAgora * 100) / 100,
        novoSaldoPendente,
      });
    }

    // Aplica
    const aplicados: { contractId: string; ownerEntryId?: string; saldoAtualizado: number }[] = [];
    if (!dryRun) {
      for (const p of propostas) {
        const c = contracts.find((x) => x.id === p.contractId)!;
        const monthLabel = `${String(targetMonth + 1).padStart(2, "0")}/${targetYear}`;
        // Cria OwnerEntry DEBITO INTERMEDIACAO no mes corrente
        const oe = await prisma.ownerEntry.create({
          data: {
            type: "DEBITO",
            category: "INTERMEDIACAO",
            description: `Intermediação ${monthLabel} - ${c.code}`,
            value: p.vaiCobrarAgora,
            dueDate: new Date(targetYear, targetMonth, 10),
            status: "PENDENTE",
            ownerId: c.ownerId,
            contractId: c.id,
            propertyId: c.propertyId || null,
            notes: JSON.stringify({
              autoCreated: true,
              repairFromMissingIntermediacao: true,
              totalPrevista: p.totalPrevista,
              vaiCobrarAgora: p.vaiCobrarAgora,
              saldoNovo: p.novoSaldoPendente,
            }),
          },
        });
        // Atualiza saldoPendente do contrato
        await prisma.contract.update({
          where: { id: c.id },
          data: { intermediacaoSaldoPendente: p.novoSaldoPendente },
        });
        aplicados.push({ contractId: c.id, ownerEntryId: oe.id, saldoAtualizado: p.novoSaldoPendente });
      }
    }

    return NextResponse.json({
      mode: dryRun ? "DRY_RUN" : "APPLIED",
      monthRef: `${String(targetMonth + 1).padStart(2, "0")}/${targetYear}`,
      total: propostas.length,
      somaVaiCobrar: Math.round(propostas.reduce((s, p) => s + p.vaiCobrarAgora, 0) * 100) / 100,
      somaSaldoFuturo: Math.round(propostas.reduce((s, p) => s + p.novoSaldoPendente, 0) * 100) / 100,
      propostas,
      aplicados,
    });
  } catch (error) {
    console.error("[repair-missing-intermediacao] Erro:", error);
    return NextResponse.json(
      { error: "Erro", details: error instanceof Error ? error.message : "desconhecido" },
      { status: 500 }
    );
  }
}
