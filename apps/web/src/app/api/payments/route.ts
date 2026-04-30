import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, requirePagePermission, isAuthError } from "@/lib/api-auth";
import { buildSearchWhere } from "@/lib/search";

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const search = searchParams.get("search");
  const contractId = searchParams.get("contractId");
  const tab = searchParams.get("tab"); // todos|pendentes|pagos|atrasados|emitidos|nao_emitidos
  const dateField = (searchParams.get("dateField") || "dueDate") as
    | "dueDate"
    | "paidAt"
    | "createdAt";
  const dateFrom = searchParams.get("dateFrom");
  const dateTo = searchParams.get("dateTo");

  const where: Record<string, unknown> = {};
  if (status && status !== "all") where.status = status;
  if (contractId) where.contractId = contractId;

  // Busca tokenizada: cada palavra do termo precisa estar presente em algum campo.
  // Ex: "Maria Silva" → encontra "Maria Aparecida Silva" e "Silva, Maria Joana".
  const searchWhere = buildSearchWhere(
    search,
    [
      "code",
      "description",
      "nossoNumero",
      "tenant.name",
      "tenant.cpfCnpj",
      "owner.name",
      "owner.cpfCnpj",
      "contract.code",
      "contract.property.title",
    ],
    {
      numericFields: ["tenant.cpfCnpj", "owner.cpfCnpj", "nossoNumero"],
    },
  );
  if (searchWhere) {
    where.AND = [...((where.AND as any[]) || []), ...searchWhere];
  }

  // Filtro por aba (status especiais)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (tab === "pendentes") {
    where.status = "PENDENTE";
    where.dueDate = { gte: today };
  } else if (tab === "pagos") {
    where.status = "PAGO";
  } else if (tab === "atrasados") {
    // PENDENTE com vencimento passado OU status ATRASADO
    where.OR = [
      ...((where.OR as any[]) || []),
      { status: "ATRASADO" },
      { AND: [{ status: "PENDENTE" }, { dueDate: { lt: today } }] },
    ];
    delete where.status;
  } else if (tab === "emitidos") {
    where.boletoStatus = "EMITIDO";
  } else if (tab === "nao_emitidos") {
    where.AND = [
      { OR: [{ nossoNumero: null }, { nossoNumero: "" }] },
      { OR: [{ status: "PENDENTE" }, { status: "ATRASADO" }] },
    ];
  }

  // Filtro por data
  if (dateFrom || dateTo) {
    const range: { gte?: Date; lte?: Date } = {};
    if (dateFrom) range.gte = new Date(`${dateFrom}T00:00:00`);
    if (dateTo) range.lte = new Date(`${dateTo}T23:59:59`);
    where[dateField] = range;
  }

  const includeRelations = {
    contract: { include: { property: { select: { title: true } } } },
    tenant: { select: { id: true, name: true } },
    owner: { select: { id: true, name: true } },
  };

  const pageParam = searchParams.get("page");
  if (!pageParam) {
    // Legacy: return all as array
    const payments = await prisma.payment.findMany({
      where,
      include: includeRelations,
      orderBy: { dueDate: "desc" },
    });

    // Buscar notificações enviadas para cada payment
    const paymentIds = payments.map(p => p.id);
    const sentNotifications = paymentIds.length > 0
      ? await prisma.notification.findMany({
          where: { paymentId: { in: paymentIds }, status: "ENVIADO" },
          select: { paymentId: true, channel: true, sentAt: true },
          orderBy: { sentAt: "desc" },
        })
      : [];

    const notifByPayment = new Map<string, { channel: string; sentAt: Date | null }[]>();
    for (const n of sentNotifications) {
      if (!n.paymentId) continue;
      if (!notifByPayment.has(n.paymentId)) notifByPayment.set(n.paymentId, []);
      notifByPayment.get(n.paymentId)!.push({ channel: n.channel, sentAt: n.sentAt });
    }

    const enriched = payments.map(p => ({
      ...p,
      notifications: notifByPayment.get(p.id) || [],
    }));

    return NextResponse.json(enriched);
  }

  // Paginated response
  const page = Math.max(1, parseInt(pageParam));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "50")));
  const skip = (page - 1) * limit;

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: includeRelations,
      orderBy: { dueDate: "desc" },
      skip,
      take: limit,
    }),
    prisma.payment.count({ where }),
  ]);

  // Enriquecer com notificacoes enviadas
  const paymentIds = payments.map((p) => p.id);
  const sentNotifications = paymentIds.length > 0
    ? await prisma.notification.findMany({
        where: { paymentId: { in: paymentIds }, status: "ENVIADO" },
        select: { paymentId: true, channel: true, sentAt: true },
        orderBy: { sentAt: "desc" },
      })
    : [];
  const notifByPayment = new Map<string, { channel: string; sentAt: Date | null }[]>();
  for (const n of sentNotifications) {
    if (!n.paymentId) continue;
    if (!notifByPayment.has(n.paymentId)) notifByPayment.set(n.paymentId, []);
    notifByPayment.get(n.paymentId)!.push({ channel: n.channel, sentAt: n.sentAt });
  }
  const enriched = payments.map((p) => ({
    ...p,
    notifications: notifByPayment.get(p.id) || [],
  }));

  return NextResponse.json({
    data: enriched,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requirePagePermission("financeiro");
  if (isAuthError(auth)) return auth;
  const body = await request.json();
  const { contractId, tenantId, ownerId, value, dueDate } = body;
  if (!contractId || !tenantId || !ownerId || !value || !dueDate) {
    return NextResponse.json(
      { error: "Campos obrigatórios: contractId, tenantId, ownerId, value, dueDate" },
      { status: 400 }
    );
  }
  // Auto-generate code if not provided or placeholder
  let code = body.code;
  if (!code || code === "AUTO") {
    const allCodes = await prisma.payment.findMany({
      select: { code: true },
    });
    let maxNumber = 0;
    for (const p of allCodes) {
      const match = p.code.match(/PAG-(\d+)/);
      if (match) {
        const num = parseInt(match[1]);
        if (num > maxNumber) maxNumber = num;
      }
    }
    code = `PAG-${String(maxNumber + 1).padStart(3, "0")}`;
  }

  try {
    const payment = await prisma.payment.create({
      data: {
        code, contractId, tenantId, ownerId,
        value: parseFloat(value),
        dueDate: new Date(dueDate.includes("T") ? dueDate : dueDate + "T12:00:00"),
        status: body.status || "PENDENTE",
        description: body.description || null,
        paymentMethod: body.paymentMethod || null,
        paidValue: body.paidValue ? parseFloat(body.paidValue) : null,
        paidAt: body.paidAt ? new Date(String(body.paidAt).includes("T") ? body.paidAt : body.paidAt + "T12:00:00") : null,
        fineValue: body.fineValue ? parseFloat(body.fineValue) : null,
        interestValue: body.interestValue ? parseFloat(body.interestValue) : null,
        discountValue: body.discountValue ? parseFloat(body.discountValue) : null,
        splitOwnerValue: body.splitOwnerValue ? parseFloat(body.splitOwnerValue) : null,
        splitAdminValue: body.splitAdminValue ? parseFloat(body.splitAdminValue) : null,
        lateFee: body.lateFee ? parseFloat(body.lateFee) : null,
        totalDue: body.totalDue ? parseFloat(body.totalDue) : null,
        irrfValue: body.irrfValue ? parseFloat(body.irrfValue) : null,
        irrfRate: body.irrfRate ? parseFloat(body.irrfRate) : null,
        grossToOwner: body.grossToOwner ? parseFloat(body.grossToOwner) : null,
        netToOwner: body.netToOwner ? parseFloat(body.netToOwner) : null,
        intermediationFee: body.intermediationFee ? parseFloat(body.intermediationFee) : null,
        notes: body.notes || null,
        createdById: auth.user.id,
      },
      include: {
        tenant: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
      },
    });
    return NextResponse.json(payment, { status: 201 });
  } catch (error: any) {
    console.error("[Payments POST] Erro:", error);
    // Handle unique constraint violation on code
    if (error?.code === "P2002") {
      return NextResponse.json(
        { error: `Código ${code} já existe. Tente novamente.` },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: error?.message || "Erro ao criar pagamento" },
      { status: 500 }
    );
  }
}
