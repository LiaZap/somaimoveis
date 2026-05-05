import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPortalToken } from "@/lib/portal-auth";

/**
 * GET /api/portal/repasses?month=YYYY-MM&status=PAGO|PENDENTE|all
 *
 * Lista os REPASSES (OwnerEntry CREDITO REPASSE/GARANTIA + DEBITO IPTU/CONDOMINIO/etc)
 * do proprietario autenticado. Forca ownerId do JWT — nao expoe dados
 * de outros proprietarios nem agregados da empresa.
 *
 * Resumo retornado tambem eh apenas DELE (a repassar / ja repassado dele,
 * nunca total da empresa).
 */
export async function GET(request: NextRequest) {
  const auth = await verifyPortalToken(request);
  if (!auth) {
    return NextResponse.json({ error: "Nao autorizado" }, { status: 401 });
  }

  try {
    const { ownerId } = auth;
    const { searchParams } = new URL(request.url);
    const month = searchParams.get("month");
    const status = searchParams.get("status");

    const where: Record<string, unknown> = { ownerId };

    if (status && status !== "all") {
      where.status = status;
    }

    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split("-").map(Number);
      where.dueDate = {
        gte: new Date(y, m - 1, 1),
        lt: new Date(y, m, 1),
      };
    }

    const entries = await prisma.ownerEntry.findMany({
      where,
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
    });

    // Buscar contratos referenciados pra mostrar imovel/locatario
    const contractIds = Array.from(
      new Set(entries.map((e) => e.contractId).filter((id): id is string => !!id))
    );
    const contracts = contractIds.length
      ? await prisma.contract.findMany({
          where: { id: { in: contractIds } },
          select: {
            id: true,
            code: true,
            property: { select: { id: true, title: true } },
            tenant: { select: { id: true, name: true } },
          },
        })
      : [];
    const contractMap = new Map(contracts.map((c) => [c.id, c]));

    // Resumo: a repassar (PENDENTE), ja repassado (PAGO/REPASSADO), debitos
    let totalARepassar = 0;
    let totalJaRepassado = 0;
    let totalDebitos = 0;
    let totalCreditosPagos = 0;

    const items = entries.map((e) => {
      const c = e.contractId ? contractMap.get(e.contractId) : null;
      const isCredito = e.type === "CREDITO";
      const isPago = e.status === "PAGO" || e.status === "REPASSADO";

      if (isCredito) {
        if (isPago) totalJaRepassado += e.value;
        else totalARepassar += e.value;
        if (isPago) totalCreditosPagos += e.value;
      } else {
        // DEBITO — sempre subtrai do que sera repassado
        totalDebitos += e.value;
      }

      return {
        id: e.id,
        type: e.type,
        category: e.category,
        description: e.description,
        value: e.value,
        status: e.status,
        dueDate: e.dueDate ? e.dueDate.toISOString() : null,
        paidAt: e.paidAt ? e.paidAt.toISOString() : null,
        contract: c
          ? {
              id: c.id,
              code: c.code,
              property: c.property,
              tenant: c.tenant,
            }
          : null,
      };
    });

    const totalLiquido = totalARepassar - totalDebitos;

    return NextResponse.json({
      ownerName: auth.ownerName,
      items,
      resumo: {
        // SO os numeros DELE — nunca da empresa
        totalARepassar: Math.round(totalARepassar * 100) / 100,
        totalJaRepassado: Math.round(totalJaRepassado * 100) / 100,
        totalDebitos: Math.round(totalDebitos * 100) / 100,
        totalLiquido: Math.round(totalLiquido * 100) / 100,
        totalLancamentos: items.length,
      },
    });
  } catch (error) {
    console.error("[Portal Repasses]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro" },
      { status: 500 }
    );
  }
}
