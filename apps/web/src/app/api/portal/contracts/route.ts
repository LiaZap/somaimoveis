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

    // Inclui contratos cujo imovel tem co-ownership do owner atual
    const propertyShares = await prisma.propertyOwner.findMany({
      where: { ownerId },
      select: { propertyId: true },
    });
    const sharedPropertyIds = propertyShares.map((s) => s.propertyId);

    const where: Record<string, unknown> = {
      OR: [
        { ownerId },
        ...(sharedPropertyIds.length > 0 ? [{ propertyId: { in: sharedPropertyIds } }] : []),
      ],
    };
    if (status && status !== "all") {
      where.status = status;
    }

    const contracts = await prisma.contract.findMany({
      where,
      include: {
        property: {
          select: {
            id: true,
            title: true,
            type: true,
            street: true,
            number: true,
            neighborhood: true,
            city: true,
            state: true,
          },
        },
        tenant: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            cpfCnpj: true,
          },
        },
      },
      orderBy: { startDate: "desc" },
    });

    return NextResponse.json(contracts);
  } catch (error) {
    console.error("Erro ao buscar contratos do portal:", error);
    return NextResponse.json(
      { error: "Erro ao buscar contratos" },
      { status: 500 }
    );
  }
}
