import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPortalToken } from "@/lib/portal-auth";

interface MonthGroup {
  month: number;
  year: number;
  label: string;
  payments: {
    id: string;
    code: string;
    dueDate: string;
    paidAt: string | null;
    status: string;
    value: number;
    paidValue: number | null;
    splitOwnerValue: number | null;
    splitAdminValue: number | null;
    description: string | null;
    property: string;
    tenant: string;
  }[];
  totals: {
    totalValue: number;
    totalPaid: number;
    totalOwner: number;
    totalAdmin: number;
  };
}

export async function GET(request: NextRequest) {
  const auth = await verifyPortalToken(request);
  if (!auth) {
    return NextResponse.json(
      { error: "Nao autorizado" },
      { status: 401 }
    );
  }

  try {
    const { ownerId } = auth;
    const { searchParams } = new URL(request.url);

    const year = searchParams.get("year");

    // Achar contratos onde o owner atual eh DIRETO (ownerId) ou
    // CO-PROPRIETARIO via PropertyOwner. Manoela e Gabriel, por exemplo,
    // sao co-proprietarios sem ser ownerId principal — precisam aparecer.
    const propertyShares = await prisma.propertyOwner.findMany({
      where: { ownerId },
      select: { propertyId: true, percentage: true },
    });
    const sharedPropertyIds = propertyShares.map((s) => s.propertyId);
    const shareByProperty = new Map(
      propertyShares.map((s) => [s.propertyId, s.percentage]),
    );

    // Filtros base — pagamentos cujo contrato tem o owner direto OU cujo
    // imovel tem co-ownership do owner atual.
    const where: Record<string, unknown> = {
      OR: [
        { ownerId },
        ...(sharedPropertyIds.length > 0
          ? [{ contract: { propertyId: { in: sharedPropertyIds } } }]
          : []),
      ],
    };

    if (year) {
      const y = parseInt(year, 10);
      where.dueDate = {
        gte: new Date(y, 0, 1),
        lt: new Date(y + 1, 0, 1),
      };
    }

    // Buscar todos os pagamentos
    const payments = await prisma.payment.findMany({
      where,
      include: {
        contract: {
          include: {
            property: { select: { id: true, title: true } },
          },
        },
        tenant: { select: { name: true } },
      },
      orderBy: { dueDate: "desc" },
    });

    // Agrupar por mes
    const monthsMap = new Map<string, MonthGroup>();

    const monthNames = [
      "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
      "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
    ];

    for (const payment of payments) {
      const dueDate = new Date(payment.dueDate);
      const m = dueDate.getMonth();
      const y = dueDate.getFullYear();
      const key = `${y}-${String(m + 1).padStart(2, "0")}`;

      if (!monthsMap.has(key)) {
        monthsMap.set(key, {
          month: m + 1,
          year: y,
          label: `${monthNames[m]} ${y}`,
          payments: [],
          totals: {
            totalValue: 0,
            totalPaid: 0,
            totalOwner: 0,
            totalAdmin: 0,
          },
        });
      }

      const group = monthsMap.get(key)!;

      // Calcular split se nao estiver preenchido
      const adminFeePercent = payment.contract.adminFeePercent ?? 10;
      const paidValue = payment.paidValue ?? payment.value;
      const splitAdminTotal =
        payment.splitAdminValue ?? paidValue * (adminFeePercent / 100);
      const splitOwnerTotal =
        payment.splitOwnerValue ?? paidValue - splitAdminTotal;

      // Se o owner atual eh CO-PROPRIETARIO (nao ownerId direto do contrato),
      // aplica o share% pra mostrar so a parte que cabe a ele.
      const propId = payment.contract.property?.id;
      const isPrincipalOwner = payment.ownerId === ownerId;
      const sharePercent = !isPrincipalOwner && propId
        ? (shareByProperty.get(propId) ?? 0)
        : 100;
      const shareFactor = sharePercent / 100;
      const splitAdmin = Math.round(splitAdminTotal * shareFactor * 100) / 100;
      const splitOwner = Math.round(splitOwnerTotal * shareFactor * 100) / 100;

      group.payments.push({
        id: payment.id,
        code: payment.code,
        dueDate: payment.dueDate.toISOString(),
        paidAt: payment.paidAt ? payment.paidAt.toISOString() : null,
        status: payment.status,
        value: payment.value,
        paidValue: payment.paidValue,
        splitOwnerValue: splitOwner,
        splitAdminValue: splitAdmin,
        description: payment.description,
        property: payment.contract.property?.title || "N/A",
        tenant: payment.tenant?.name || "N/A",
      });

      // Totais respeitam o share% do owner atual (co-proprietario ve apenas
      // a parte dele).
      group.totals.totalValue += payment.value * shareFactor;
      if (payment.status === "PAGO") {
        group.totals.totalPaid += paidValue * shareFactor;
        group.totals.totalOwner += splitOwner;
        group.totals.totalAdmin += splitAdmin;
      }
    }

    // Ordenar meses por data (mais recente primeiro)
    const months = Array.from(monthsMap.values()).sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      return b.month - a.month;
    });

    // Totais gerais
    const grandTotals = months.reduce(
      (acc, m) => ({
        totalValue: acc.totalValue + m.totals.totalValue,
        totalPaid: acc.totalPaid + m.totals.totalPaid,
        totalOwner: acc.totalOwner + m.totals.totalOwner,
        totalAdmin: acc.totalAdmin + m.totals.totalAdmin,
      }),
      { totalValue: 0, totalPaid: 0, totalOwner: 0, totalAdmin: 0 }
    );

    return NextResponse.json({
      months,
      grandTotals,
      ownerName: auth.ownerName,
    });
  } catch (error) {
    console.error("Erro ao buscar extrato do portal:", error);
    return NextResponse.json(
      { error: "Erro ao buscar extrato financeiro" },
      { status: 500 }
    );
  }
}
