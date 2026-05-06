import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";
import { nextBusinessDay } from "@/lib/business-days";

/**
 * GET /api/admin/contracts-payment-day
 * Lista todos os contratos ATIVOS com seu paymentDay, agrupado pra
 * facilitar conferencia. Util pra detectar contratos importados que
 * ficaram com o default do schema (5) quando deveriam ser outro dia.
 */
export async function GET(_request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  const contracts = await prisma.contract.findMany({
    where: { status: "ATIVO" },
    select: {
      id: true,
      code: true,
      paymentDay: true,
      tenant: { select: { name: true, paymentDay: true } },
      owner: { select: { name: true } },
      property: { select: { title: true } },
    },
    orderBy: { code: "asc" },
  });

  // Agrupar por paymentDay pra ver distribuicao
  const byDay = new Map<number, number>();
  for (const c of contracts) {
    byDay.set(c.paymentDay, (byDay.get(c.paymentDay) || 0) + 1);
  }
  const distribuicao = Array.from(byDay.entries())
    .map(([day, count]) => ({ paymentDay: day, total: count }))
    .sort((a, b) => a.paymentDay - b.paymentDay);

  return NextResponse.json({
    totalContratos: contracts.length,
    distribuicao,
    contratos: contracts.map((c) => ({
      id: c.id,
      code: c.code,
      paymentDay: c.paymentDay,
      tenantPaymentDay: c.tenant?.paymentDay ?? null,
      mismatch: c.tenant?.paymentDay !== undefined && c.tenant?.paymentDay !== null && c.tenant.paymentDay !== c.paymentDay,
      locatario: c.tenant?.name || "?",
      proprietario: c.owner?.name || "?",
      imovel: c.property?.title || "?",
    })),
  });
}

/**
 * POST /api/admin/contracts-payment-day
 * Body: { updates: [{ contractId, newPaymentDay }] }
 *
 * Atualiza paymentDay em batch e cascateia para boletos PENDENTES
 * NAO emitidos (sem nossoNumero) — boletos ja emitidos no Sicredi
 * NAO sao alterados (precisam ser cancelados+regerados manualmente).
 *
 * Retorna lista de boletos ja emitidos que ficaram divergentes pra o
 * usuario poder agir manualmente neles.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  const body = await request.json().catch(() => ({}));
  const updates = Array.isArray(body.updates) ? body.updates : [];

  if (updates.length === 0) {
    return NextResponse.json(
      { error: "updates obrigatorio (array de {contractId, newPaymentDay})" },
      { status: 400 },
    );
  }

  const results: Array<{
    contractId: string;
    code: string;
    oldDay: number;
    newDay: number;
    pendingNotIssuedUpdated: number;
    pendingIssuedNeedManualReissue: Array<{ paymentId: string; code: string; dueDate: string }>;
  }> = [];

  for (const u of updates) {
    const contractId = String(u.contractId || "");
    const newDay = parseInt(String(u.newPaymentDay));
    if (!contractId || !isFinite(newDay) || newDay < 1 || newDay > 31) continue;

    const contract = await prisma.contract.findUnique({
      where: { id: contractId },
      select: { id: true, code: true, paymentDay: true },
    });
    if (!contract) continue;

    const oldDay = contract.paymentDay;
    if (oldDay === newDay) continue; // sem mudanca

    // Atualiza o contrato
    await prisma.contract.update({
      where: { id: contractId },
      data: { paymentDay: newDay },
    });

    // Cascateia pros boletos PENDENTES nao emitidos
    const pendingUnissued = await prisma.payment.findMany({
      where: {
        contractId,
        status: "PENDENTE",
        OR: [{ nossoNumero: null }, { nossoNumero: "" }],
      },
      select: { id: true, dueDate: true },
    });
    let pendingNotIssuedUpdated = 0;
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
      pendingNotIssuedUpdated++;
    }

    // Lista boletos JA emitidos com dueDate ainda no dia antigo —
    // precisam de acao manual (cancelar + regerar)
    const issued = await prisma.payment.findMany({
      where: {
        contractId,
        status: { in: ["PENDENTE", "ATRASADO"] },
        nossoNumero: { not: null },
      },
      select: { id: true, code: true, dueDate: true },
    });
    const needsManual = issued
      .filter((p) => p.dueDate.getUTCDate() !== newDay)
      .map((p) => ({
        paymentId: p.id,
        code: p.code,
        dueDate: p.dueDate.toISOString(),
      }));

    results.push({
      contractId,
      code: contract.code,
      oldDay,
      newDay,
      pendingNotIssuedUpdated,
      pendingIssuedNeedManualReissue: needsManual,
    });
  }

  const totalManual = results.reduce(
    (s, r) => s + r.pendingIssuedNeedManualReissue.length,
    0,
  );

  return NextResponse.json({
    contractsUpdated: results.length,
    totalBoletosCascadeados: results.reduce((s, r) => s + r.pendingNotIssuedUpdated, 0),
    totalBoletosPrecisamReemitir: totalManual,
    results,
    mensagem:
      `${results.length} contrato(s) atualizado(s). ` +
      `${totalManual} boleto(s) ja emitido(s) ficaram com data antiga e precisam ` +
      `ser cancelados+regerados manualmente na tela do pagamento.`,
  });
}
