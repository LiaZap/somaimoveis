import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPortalToken } from "@/lib/portal-auth";

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

    const status = searchParams.get("status");
    const month = searchParams.get("month");
    const year = searchParams.get("year");

    // Co-proprietarios: incluir tambem pagamentos de imoveis em que o owner
    // aparece como PropertyOwner (mesmo nao sendo ownerId direto do contrato).
    const propertyShares = await prisma.propertyOwner.findMany({
      where: { ownerId },
      select: { propertyId: true },
    });
    const sharedPropertyIds = propertyShares.map((s) => s.propertyId);

    // Construir filtros
    const where: Record<string, unknown> = {
      OR: [
        { ownerId },
        ...(sharedPropertyIds.length > 0
          ? [{ contract: { propertyId: { in: sharedPropertyIds } } }]
          : []),
      ],
    };

    if (status && status !== "all") {
      where.status = status;
    }

    // Filtro por mes/ano usando range de datas no dueDate
    if (month && year) {
      const m = parseInt(month, 10);
      const y = parseInt(year, 10);
      const startDate = new Date(y, m - 1, 1);
      const endDate = new Date(y, m, 1);
      where.dueDate = {
        gte: startDate,
        lt: endDate,
      };
    } else if (year) {
      const y = parseInt(year, 10);
      const startDate = new Date(y, 0, 1);
      const endDate = new Date(y + 1, 0, 1);
      where.dueDate = {
        gte: startDate,
        lt: endDate,
      };
    }

    // Buscar pagamentos com filtros
    const payments = await prisma.payment.findMany({
      where,
      include: {
        contract: {
          include: {
            property: { select: { title: true } },
          },
        },
        tenant: { select: { id: true, name: true } },
      },
      orderBy: { dueDate: "desc" },
    });

    // Buscar todos os pagamentos para calcular resumo geral (proprio + co-owner)
    const allPayments = await prisma.payment.findMany({
      where: {
        OR: [
          { ownerId },
          ...(sharedPropertyIds.length > 0
            ? [{ contract: { propertyId: { in: sharedPropertyIds } } }]
            : []),
        ],
      },
      select: {
        status: true,
        value: true,
        paidValue: true,
        splitOwnerValue: true,
        splitAdminValue: true,
      },
    });

    const totalReceived = allPayments
      .filter((p) => p.status === "PAGO")
      .reduce((sum, p) => sum + (p.paidValue ?? p.value), 0);

    const totalPending = allPayments
      .filter((p) => p.status === "PENDENTE")
      .reduce((sum, p) => sum + p.value, 0);

    const totalOverdue = allPayments
      .filter((p) => p.status === "ATRASADO")
      .reduce((sum, p) => sum + p.value, 0);

    const totalOwnerReceived = allPayments
      .filter((p) => p.status === "PAGO")
      .reduce((sum, p) => sum + (p.splitOwnerValue ?? p.paidValue ?? p.value), 0);

    return NextResponse.json({
      payments,
      summary: {
        totalReceived,
        totalPending,
        totalOverdue,
        totalOwnerReceived,
      },
    });
  } catch (error) {
    console.error("Erro ao buscar financeiro do portal:", error);
    return NextResponse.json(
      { error: "Erro ao buscar dados financeiros" },
      { status: 500 }
    );
  }
}
