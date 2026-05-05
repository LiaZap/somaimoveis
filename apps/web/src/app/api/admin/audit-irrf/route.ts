import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * GET  /api/admin/audit-irrf?dry=1  — lista pagamentos com IRRF aplicado errado
 * POST /api/admin/audit-irrf?apply=1 — zera o IRRF nesses pagamentos
 *
 * Regra fiscal: IRRF SO se aplica quando locador eh PF e locatario eh PJ.
 * Em qualquer outro caso (PJ owner, ou PF+PF) o IRRF deveria ser 0.
 *
 * Esse endpoint encontra Payments com irrfValue > 0 onde a regra nao
 * deveria aplicar e (em apply mode) zera os campos. Tambem atualiza o
 * notes das OwnerEntries REPASSE correspondentes pra remover o irrfValue
 * — assim o demonstrativo nao mostra mais a linha "IRRF Retido".
 */
export async function GET(request: NextRequest) {
  return audit(request, false);
}

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const apply = searchParams.get("apply") === "1";
  return audit(request, apply);
}

async function audit(request: NextRequest, apply: boolean) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  // Buscar todos os pagamentos com IRRF > 0
  const payments = await prisma.payment.findMany({
    where: { irrfValue: { gt: 0 } },
    select: {
      id: true,
      code: true,
      irrfValue: true,
      irrfRate: true,
      paidAt: true,
      dueDate: true,
      contractId: true,
      contract: {
        select: {
          owner: { select: { id: true, name: true, personType: true } },
          tenant: { select: { id: true, name: true, personType: true } },
        },
      },
    },
  });

  type IncorrectItem = {
    paymentId: string;
    code: string;
    irrfValue: number;
    ownerName: string;
    ownerType: string;
    tenantName: string;
    tenantType: string;
    motivo: string;
    paidAt: string | null;
  };

  const incorrect: IncorrectItem[] = [];

  for (const p of payments) {
    const ownerType = (p.contract?.owner?.personType || "PF").toUpperCase();
    const tenantType = (p.contract?.tenant?.personType || "PF").toUpperCase();
    const ownerIsPF = ownerType === "PF";
    const tenantIsPJ = tenantType === "PJ";

    // Regra correta: IRRF so quando owner=PF E tenant=PJ
    if (ownerIsPF && tenantIsPJ) continue; // OK, mantem

    let motivo = "";
    if (!ownerIsPF) motivo = `Owner eh PJ (${p.contract?.owner?.name}) — sem retencao na fonte`;
    else motivo = `Tenant eh PF (${p.contract?.tenant?.name}) — sem retencao na fonte`;

    incorrect.push({
      paymentId: p.id,
      code: p.code,
      irrfValue: p.irrfValue ?? 0,
      ownerName: p.contract?.owner?.name || "?",
      ownerType,
      tenantName: p.contract?.tenant?.name || "?",
      tenantType,
      motivo,
      paidAt: p.paidAt?.toISOString() || null,
    });
  }

  const totalIrrfIncorreto = incorrect.reduce((s, x) => s + x.irrfValue, 0);

  if (!apply) {
    return NextResponse.json({
      mode: "DRY_RUN",
      totalPagamentosComIrrf: payments.length,
      totalCorretos: payments.length - incorrect.length,
      totalIncorretos: incorrect.length,
      totalIrrfIncorreto: Math.round(totalIrrfIncorreto * 100) / 100,
      incorretos: incorrect.slice(0, 50), // limita pra resposta nao explodir
      truncated: incorrect.length > 50,
      mensagem:
        incorrect.length === 0
          ? "Nenhum IRRF aplicado incorretamente — tudo ok."
          : `${incorrect.length} pagamentos com IRRF aplicado incorretamente. POST com ?apply=1 pra corrigir.`,
    });
  }

  // APPLY: zera os campos
  const ids = incorrect.map((x) => x.paymentId);
  let updatedPayments = 0;
  if (ids.length > 0) {
    const res = await prisma.payment.updateMany({
      where: { id: { in: ids } },
      data: { irrfValue: 0, irrfRate: 0 },
    });
    updatedPayments = res.count;
  }

  // Atualizar OwnerEntries REPASSE/GARANTIA correspondentes — limpa irrfValue do notes
  // Match por contractId + dueDate (mesmo mes do pagamento)
  let updatedEntries = 0;
  for (const item of incorrect) {
    const payment = payments.find((p) => p.id === item.paymentId);
    if (!payment || !payment.contractId || !payment.dueDate) continue;

    const monthStart = new Date(payment.dueDate);
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const monthEnd = new Date(monthStart);
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);

    const entries = await prisma.ownerEntry.findMany({
      where: {
        contractId: payment.contractId,
        category: { in: ["REPASSE", "GARANTIA"] },
        dueDate: { gte: monthStart, lt: monthEnd },
      },
    });

    for (const e of entries) {
      if (!e.notes) continue;
      try {
        const n = JSON.parse(e.notes);
        if (n.irrfValue || n.irrfRate) {
          n.irrfValue = 0;
          n.irrfRate = 0;
          await prisma.ownerEntry.update({
            where: { id: e.id },
            data: { notes: JSON.stringify(n) },
          });
          updatedEntries++;
        }
      } catch { /* notes nao eh JSON valido */ }
    }
  }

  return NextResponse.json({
    mode: "APPLIED",
    totalPagamentosComIrrf: payments.length,
    totalCorretos: payments.length - incorrect.length,
    totalIncorretos: incorrect.length,
    totalIrrfIncorreto: Math.round(totalIrrfIncorreto * 100) / 100,
    pagamentosAtualizados: updatedPayments,
    ownerEntriesAtualizadas: updatedEntries,
    mensagem:
      `Zerado IRRF em ${updatedPayments} pagamentos e ${updatedEntries} repasses. ` +
      `Demonstrativos novos nao vao mais mostrar IRRF nesses casos.`,
    incorretos: incorrect.slice(0, 50),
  });
}
