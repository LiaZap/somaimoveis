import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, requirePagePermission, isAuthError } from "@/lib/api-auth";
import { logAudit } from "@/lib/audit-log";
import { buildSearchWhere } from "@/lib/search";

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const search = searchParams.get("search");

    const tenantId = searchParams.get("tenantId");
    const guaranteeType = searchParams.get("guaranteeType");
    const startMonth = searchParams.get("startMonth"); // YYYY-MM
    const where: Record<string, unknown> = {};
    if (status && status !== "all") where.status = status;
    if (tenantId) where.tenantId = tenantId;
    // Filtro por mes de inicio do contrato (startDate)
    if (startMonth && /^\d{4}-\d{2}$/.test(startMonth)) {
      const [y, m] = startMonth.split("-").map(Number);
      where.startDate = { gte: new Date(y, m - 1, 1), lt: new Date(y, m, 1) };
    }
    if (guaranteeType && guaranteeType !== "all") {
      if (guaranteeType === "SEM_GARANTIA") {
        where.OR = [{ guaranteeType: null }, { guaranteeType: "" }, { guaranteeType: "SEM_GARANTIA" }];
      } else {
        where.guaranteeType = guaranteeType;
      }
    }
    // Busca abrangente — locatario, proprietario, codigo, imovel, endereco.
    // Inclui owner.name pois muitos usuarios buscam contratos pelo nome do
    // proprietario do imovel.
    const searchWhere = buildSearchWhere(
      search,
      [
        "code",
        "tenant.name",
        "tenant.cpfCnpj",
        "owner.name",
        "owner.cpfCnpj",
        "property.title",
        "property.street",
        "property.neighborhood",
      ],
      { numericFields: ["tenant.cpfCnpj", "owner.cpfCnpj"] },
    );
    if (searchWhere) {
      // Combina com filtro de garantia (que ja pode estar em where.OR)
      const existingOR = where.OR;
      if (existingOR) {
        where.AND = [...((where.AND as any[]) || []), { OR: existingOR }, ...searchWhere];
        delete where.OR;
      } else {
        where.AND = [...((where.AND as any[]) || []), ...searchWhere];
      }
    }

    const includeRelations = {
      property: { select: { id: true, title: true, condoFee: true, iptuValue: true } },
      owner: { select: { id: true, name: true } },
      tenant: { select: { id: true, name: true } },
      tenant2: { select: { id: true, name: true } },
      guarantors: {
        select: { guarantor: { select: { id: true, name: true, cpfCnpj: true } } },
      },
      createdBy: { select: { id: true, name: true } },
    };

    const pageParam = searchParams.get("page");
    if (!pageParam) {
      // Legacy: return all as array
      const contracts = await prisma.contract.findMany({
        where,
        include: includeRelations,
        orderBy: { createdAt: "desc" },
      });
      return NextResponse.json(contracts);
    }

    // Paginated response
    const page = Math.max(1, parseInt(pageParam));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "50")));
    const skip = (page - 1) * limit;

    const [contracts, total] = await Promise.all([
      prisma.contract.findMany({
        where,
        include: includeRelations,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.contract.count({ where }),
    ]);

    return NextResponse.json({
      data: contracts,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("[Contracts GET] Error:", error);
    return NextResponse.json({ error: "Erro interno do servidor" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requirePagePermission("contratos");
  if (isAuthError(auth)) return auth;
  const body = await request.json();
  const { ownerId, rentalValue, startDate, endDate } = body;
  if (!ownerId || !startDate || !endDate) {
    return NextResponse.json(
      { error: "Campos obrigatórios: ownerId, startDate, endDate" },
      { status: 400 }
    );
  }

  // Validate dates
  const parsedStart = new Date(String(startDate).includes("T") ? startDate : startDate + "T12:00:00");
  const parsedEnd = new Date(String(endDate).includes("T") ? endDate : endDate + "T12:00:00");
  if (isNaN(parsedStart.getTime()) || isNaN(parsedEnd.getTime())) {
    return NextResponse.json(
      { error: "Datas inválidas. Use o formato AAAA-MM-DD." },
      { status: 400 }
    );
  }

  try {
    // Auto-generate code if not provided or if it already exists
    let code = body.code;
    if (!code) {
      const lastContract = await prisma.contract.findFirst({ orderBy: { createdAt: "desc" } });
      const lastNum = lastContract ? parseInt(lastContract.code.replace(/\D/g, "") || "0") : 0;
      code = `CTR-${lastNum + 1}`;
    }
    // Check uniqueness
    const exists = await prisma.contract.findUnique({ where: { code } });
    if (exists && body.code) {
      // User provided explicit code that already exists
      return NextResponse.json(
        { error: `Já existe um contrato com o código ${code}. Escolha outro código ou deixe em branco para gerar automaticamente.` },
        { status: 409 }
      );
    }
    if (exists) {
      // Auto-generated code collision, increment
      const allContracts = await prisma.contract.findMany({ select: { code: true }, orderBy: { createdAt: "desc" }, take: 1 });
      const maxNum = allContracts.reduce((max, c) => Math.max(max, parseInt(c.code.replace(/\D/g, "") || "0")), 0);
      code = `CTR-${maxNum + 1}`;
    }

    // Extract guarantorIds for many-to-many
    const guarantorIds: string[] = body.guaranteeType === "FIADOR" && Array.isArray(body.guarantorIds)
      ? body.guarantorIds
      : [];

    const contract = await prisma.contract.create({
      data: {
        code,
        ownerId,
        propertyId: body.propertyId || null,
        tenantId: body.tenantId || null,
        tenant2Id: body.tenant2Id || null,
        rentalValue: rentalValue ? parseFloat(String(rentalValue)) : 0,
        startDate: parsedStart,
        endDate: parsedEnd,
        type: body.type || "LOCACAO",
        status: body.status || "ATIVO",
        adminFeePercent: body.adminFeePercent ? parseFloat(String(body.adminFeePercent)) : 10,
        bankFee: body.bankFee != null ? parseFloat(String(body.bankFee)) : 3.90,
        insuranceFee: body.insuranceFee ? parseFloat(String(body.insuranceFee)) : null,
        intermediationFee: body.intermediationFee ? parseFloat(String(body.intermediationFee)) : null,
        paymentDay: body.paymentDay ? parseInt(String(body.paymentDay)) : 10,
        guaranteeType: body.guaranteeType || null,
        guaranteeValue: body.guaranteeValue ? parseFloat(String(body.guaranteeValue)) : null,
        guaranteeNotes: body.guaranteeNotes || null,
        guaranteeInsurer: body.guaranteeInsurer || null,
        aluguelGarantido: body.aluguelGarantido === true,
        intermediationInstallments: body.intermediationInstallments ? parseInt(String(body.intermediationInstallments)) : 1,
        renewalMonths: body.renewalMonths ? parseInt(String(body.renewalMonths)) : 12,
        penaltyPercent: body.penaltyPercent ? parseFloat(String(body.penaltyPercent)) : 3,
        adjustmentIndex: body.adjustmentIndex || "IGPM",
        adjustmentMonth: body.adjustmentMonth ? parseInt(String(body.adjustmentMonth)) : null,
        documentUrl: body.documentUrl || null,
        notes: body.notes || null,
        // Rastreabilidade — quem criou
        createdById: auth.user.id,
        guarantors: guarantorIds.length > 0 ? {
          create: guarantorIds.map((gId: string) => ({ guarantorId: gId })),
        } : undefined,
      },
      include: {
        property: { select: { id: true, title: true } },
        owner: { select: { id: true, name: true } },
        tenant: { select: { id: true, name: true } },
    tenant2: { select: { id: true, name: true } },
        guarantors: {
          select: { guarantor: { select: { id: true, name: true, cpfCnpj: true } } },
        },
      },
    });

    await logAudit({
      userId: auth.user.id,
      action: "CREATE",
      entity: "Contract",
      entityId: contract.id,
      entityCode: contract.code,
      entityName: contract.property?.title || null,
      request,
    });

    return NextResponse.json(contract, { status: 201 });
  } catch (error: any) {
    console.error("[Contract POST] Erro:", error);
    return NextResponse.json({ error: error.message || "Erro ao criar contrato" }, { status: 500 });
  }
}
