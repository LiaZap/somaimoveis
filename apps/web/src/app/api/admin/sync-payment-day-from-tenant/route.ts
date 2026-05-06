import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";
import { nextBusinessDay } from "@/lib/business-days";

/**
 * GET  /api/admin/sync-payment-day-from-tenant — dry-run, lista contratos
 * POST /api/admin/sync-payment-day-from-tenant?apply=1 — aplica
 *
 * Bug encontrado: a tela de detalhes do contrato mostra
 * tenant.paymentDay, mas o billing usa contract.paymentDay. Quando
 * contratos sao importados, o tenant.paymentDay fica certo (8, 10, etc)
 * mas contract.paymentDay fica no @default(5) do schema. Resultado:
 * UI mostra dia certo, billing gera dia 5.
 *
 * Esse endpoint sincroniza: pra cada contrato onde
 * contract.paymentDay !== tenant.paymentDay (e o tenant tem um valor
 * diferente do default 5), atualiza contract.paymentDay = tenant.paymentDay.
 *
 * Cascade automatico pros boletos PENDENTES nao emitidos.
 */
export async function GET(_request: NextRequest) {
  return run(false);
}

export async function POST(request: NextRequest) {
  const apply = new URL(request.url).searchParams.get("apply") === "1";
  return run(apply);
}

async function run(apply: boolean) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  const contracts = await prisma.contract.findMany({
    where: { status: "ATIVO" },
    select: {
      id: true,
      code: true,
      paymentDay: true,
      tenant: { select: { id: true, name: true, paymentDay: true } },
    },
  });

  type Mismatch = {
    contractId: string;
    code: string;
    contractPaymentDay: number;
    tenantPaymentDay: number;
    tenantName: string;
    pendingNotIssued?: number;
    pendingIssued?: number;
  };

  const mismatches: Mismatch[] = [];
  for (const c of contracts) {
    const tDay = c.tenant?.paymentDay;
    if (!tDay) continue;
    if (tDay === c.paymentDay) continue;
    mismatches.push({
      contractId: c.id,
      code: c.code,
      contractPaymentDay: c.paymentDay,
      tenantPaymentDay: tDay,
      tenantName: c.tenant?.name || "?",
    });
  }

  if (!apply) {
    return NextResponse.json({
      mode: "DRY_RUN",
      totalContratos: contracts.length,
      totalMismatches: mismatches.length,
      mismatches,
      mensagem:
        mismatches.length === 0
          ? "Todos os contratos ja estao sincronizados."
          : `${mismatches.length} contratos com contract.paymentDay diferente do tenant.paymentDay. POST com ?apply=1 pra sincronizar.`,
    });
  }

  // APPLY
  let totalContractsUpdated = 0;
  let totalPaymentsCascadeados = 0;
  let totalPaymentsPrecisamReemitir = 0;
  const reissueList: Array<{ contractCode: string; paymentCode: string }> = [];

  for (const m of mismatches) {
    const newDay = m.tenantPaymentDay;
    await prisma.contract.update({
      where: { id: m.contractId },
      data: { paymentDay: newDay },
    });
    totalContractsUpdated++;

    // Cascade pros boletos PENDENTES nao emitidos
    const pendingUnissued = await prisma.payment.findMany({
      where: {
        contractId: m.contractId,
        status: "PENDENTE",
        OR: [{ nossoNumero: null }, { nossoNumero: "" }],
      },
      select: { id: true, dueDate: true },
    });
    for (const p of pendingUnissued) {
      if (!p.dueDate) continue;
      const due = new Date(p.dueDate);
      const year = due.getFullYear();
      const month = due.getMonth();
      const lastDay = new Date(year, month + 1, 0).getDate();
      const adjustedDay = Math.min(newDay, lastDay);
      const rawNew = new Date(year, month, adjustedDay, 12, 0, 0);
      const adjusted = nextBusinessDay(rawNew);
      await prisma.payment.update({
        where: { id: p.id },
        data: { dueDate: adjusted },
      });
      totalPaymentsCascadeados++;
    }

    // Lista boletos JA emitidos com dueDate ainda no dia antigo
    const issued = await prisma.payment.findMany({
      where: {
        contractId: m.contractId,
        status: { in: ["PENDENTE", "ATRASADO"] },
        nossoNumero: { not: null },
      },
      select: { id: true, code: true, dueDate: true },
    });
    for (const p of issued) {
      if (p.dueDate.getUTCDate() !== newDay) {
        totalPaymentsPrecisamReemitir++;
        reissueList.push({ contractCode: m.code, paymentCode: p.code });
      }
    }
  }

  return NextResponse.json({
    mode: "APPLIED",
    totalContractsUpdated,
    totalPaymentsCascadeados,
    totalPaymentsPrecisamReemitir,
    reissueList: reissueList.slice(0, 100),
    mensagem:
      `${totalContractsUpdated} contratos sincronizados (contract.paymentDay = tenant.paymentDay). ` +
      `${totalPaymentsCascadeados} boletos pendentes ajustados automaticamente. ` +
      `${totalPaymentsPrecisamReemitir} boletos ja emitidos precisam ser cancelados+regerados manualmente.`,
  });
}
