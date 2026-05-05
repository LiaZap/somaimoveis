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

    // Inclui imoveis em que o owner eh co-proprietario via PropertyOwner
    const propertyShares = await prisma.propertyOwner.findMany({
      where: { ownerId },
      select: { propertyId: true, percentage: true },
    });
    const sharedPropertyIds = propertyShares.map((s) => s.propertyId);

    // Total de imoveis do proprietario (direto + co-proprietario)
    const totalProperties = await prisma.property.count({
      where: {
        active: true,
        OR: [
          { ownerId },
          ...(sharedPropertyIds.length > 0 ? [{ id: { in: sharedPropertyIds } }] : []),
        ],
      },
    });

    // Contratos ativos (direto + co-proprietario via property)
    const contractFilter = {
      status: "ATIVO",
      OR: [
        { ownerId },
        ...(sharedPropertyIds.length > 0 ? [{ propertyId: { in: sharedPropertyIds } }] : []),
      ],
    };
    const activeContracts = await prisma.contract.count({
      where: contractFilter,
    });

    // Renda mensal total — aplicando share% pra co-proprietarios
    const activeContractsList = await prisma.contract.findMany({
      where: contractFilter,
      select: { rentalValue: true, adminFeePercent: true, ownerId: true, propertyId: true },
    });

    const shareByProperty = new Map(
      propertyShares.map((s) => [s.propertyId, s.percentage]),
    );

    const totalMonthlyIncome = activeContractsList.reduce((sum, c) => {
      const share = c.ownerId === ownerId ? 100 : (shareByProperty.get(c.propertyId || "") || 0);
      return sum + c.rentalValue * (share / 100);
    }, 0);

    const totalMonthlyOwnerIncome = activeContractsList.reduce((sum, c) => {
      const share = c.ownerId === ownerId ? 100 : (shareByProperty.get(c.propertyId || "") || 0);
      return sum + c.rentalValue * (1 - c.adminFeePercent / 100) * (share / 100);
    }, 0);

    // Pagamentos pendentes e atrasados
    const paymentFilter = {
      OR: [
        { ownerId },
        ...(sharedPropertyIds.length > 0
          ? [{ contract: { propertyId: { in: sharedPropertyIds } } }]
          : []),
      ],
    };
    const pendingPayments = await prisma.payment.count({
      where: { ...paymentFilter, status: "PENDENTE" },
    });

    const overduePayments = await prisma.payment.count({
      where: { ...paymentFilter, status: "ATRASADO" },
    });

    // Ultimos 5 pagamentos
    const recentPayments = await prisma.payment.findMany({
      where: paymentFilter,
      include: {
        contract: {
          include: {
            property: { select: { title: true } },
          },
        },
        tenant: { select: { name: true } },
      },
      orderBy: { dueDate: "desc" },
      take: 5,
    });

    return NextResponse.json({
      totalProperties,
      activeContracts,
      totalMonthlyIncome,
      totalMonthlyOwnerIncome,
      pendingPayments,
      overduePayments,
      recentPayments,
    });
  } catch (error) {
    console.error("Erro ao buscar dashboard do portal:", error);
    return NextResponse.json(
      { error: "Erro ao buscar dados do dashboard" },
      { status: 500 }
    );
  }
}
