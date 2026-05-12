import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, requirePagePermission, isAuthError } from "@/lib/api-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;
  const { searchParams } = new URL(request.url);
  const tenantId = searchParams.get("tenantId");
  const type = searchParams.get("type");
  const status = searchParams.get("status");
  const contractId = searchParams.get("contractId");

  const where: Record<string, unknown> = {};
  if (tenantId) where.tenantId = tenantId;
  if (type) where.type = type;
  if (status && status !== "all") where.status = status;
  if (contractId) where.contractId = contractId;

  const includeRelations = {
    tenant: { select: { id: true, name: true } },
  };

  const pageParam = searchParams.get("page");
  if (!pageParam) {
    // Legacy: return all as array
    const entries = await prisma.tenantEntry.findMany({
      where,
      include: includeRelations,
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(entries);
  }

  // Paginated response
  const page = Math.max(1, parseInt(pageParam));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "50")));
  const skip = (page - 1) * limit;

  const [entries, total] = await Promise.all([
    prisma.tenantEntry.findMany({
      where,
      include: includeRelations,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.tenantEntry.count({ where }),
  ]);

  return NextResponse.json({
    data: entries,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requirePagePermission("lancamentos");
  if (isAuthError(auth)) return auth;
  const body = await request.json();
  const { type, category, description, value, tenantId } = body;
  if (!type || !category || !description || !value || !tenantId) {
    return NextResponse.json(
      { error: "Campos obrigatórios: type, category, description, value, tenantId" },
      { status: 400 }
    );
  }

  const validTypes = ["DEBITO", "CREDITO"];
  if (!validTypes.includes(type)) {
    return NextResponse.json(
      { error: "Tipo inválido. Use: DEBITO ou CREDITO" },
      { status: 400 }
    );
  }

  const validCategories = [
    "ALUGUEL", "CONDOMINIO", "IPTU", "AGUA", "LUZ", "GAS",
    "MULTA", "REPARO", "DESCONTO", "SEGURO_FIANCA", "SEGURO_INCENDIO", "ACORDO", "OUTROS",
  ];
  if (!validCategories.includes(category)) {
    return NextResponse.json(
      { error: `Categoria inválida. Use: ${validCategories.join(", ")}` },
      { status: 400 }
    );
  }

  // Fix Bug 17: limita installments a 60 (5 anos) pra evitar DoS.
  const installmentsRaw = parseInt(body.installments) || 1;
  const installments = Math.max(1, Math.min(60, installmentsRaw));
  // Valida value como numero finito
  const valueNum = parseFloat(body.value as string);
  if (!Number.isFinite(valueNum) || valueNum < 0) {
    return NextResponse.json({ error: "value deve ser um numero positivo finito" }, { status: 400 });
  }
  const isRecurring = body.isRecurring === true;
  const destination = body.destination || null;
  const baseDueDate = body.dueDate
    ? new Date(String(body.dueDate).includes("T") ? body.dueDate : body.dueDate + "T12:00:00")
    : null;
  const recurringDay = body.recurringDay
    ? parseInt(body.recurringDay)
    : baseDueDate
      ? baseDueDate.getDate()
      : null;

  const includeRelations = {
    tenant: { select: { id: true, name: true } },
  };

  // Installments: create N entries with split value and incremented due dates
  if (installments > 1) {
    const totalVal = parseFloat(value);
    const installmentValue = Math.round((totalVal / installments) * 100) / 100;
    // Last installment compensates rounding: total - (installmentValue * (N-1))
    const lastInstallmentValue = Math.round((totalVal - installmentValue * (installments - 1)) * 100) / 100;
    const entries = [];

    // Create first entry
    const firstEntry = await prisma.tenantEntry.create({
      data: {
        type,
        category,
        description: `${description} ${1}/${installments}`,
        value: installmentValue,
        tenantId,
        dueDate: baseDueDate,
        contractId: body.contractId || null,
        propertyId: body.propertyId || null,
        status: body.status || "PENDENTE",
        notes: body.notes || null,
        installmentNumber: 1,
        installmentTotal: installments,
        parentEntryId: null,
        isRecurring,
        recurringDay: isRecurring ? recurringDay : null,
        destination,
        createdById: auth.user.id,
      },
      include: includeRelations,
    });
    entries.push(firstEntry);

    // Create subsequent entries
    for (let i = 2; i <= installments; i++) {
      const entryDueDate = baseDueDate ? new Date(baseDueDate) : null;
      if (entryDueDate) {
        entryDueDate.setMonth(entryDueDate.getMonth() + (i - 1));
      }
      const entry = await prisma.tenantEntry.create({
        data: {
          type,
          category,
          description: `${description} ${i}/${installments}`,
          value: i === installments ? lastInstallmentValue : installmentValue,
          tenantId,
          dueDate: entryDueDate,
          contractId: body.contractId || null,
          propertyId: body.propertyId || null,
          status: body.status || "PENDENTE",
          notes: body.notes || null,
          installmentNumber: i,
          installmentTotal: installments,
          parentEntryId: firstEntry.id,
          isRecurring,
          recurringDay: isRecurring ? recurringDay : null,
          destination,
          createdById: auth.user.id,
        },
        include: includeRelations,
      });
      entries.push(entry);
    }

    return NextResponse.json(entries, { status: 201 });
  }

  // Single entry (with optional recurring)
  const entry = await prisma.tenantEntry.create({
    data: {
      type,
      category,
      description,
      value: parseFloat(value),
      tenantId,
      dueDate: baseDueDate,
      contractId: body.contractId || null,
      propertyId: body.propertyId || null,
      status: body.status || "PENDENTE",
      notes: body.notes || null,
      isRecurring,
      recurringDay: isRecurring ? recurringDay : null,
      destination,
      createdById: auth.user.id,
    },
    include: includeRelations,
  });
  return NextResponse.json(entry, { status: 201 });
}
