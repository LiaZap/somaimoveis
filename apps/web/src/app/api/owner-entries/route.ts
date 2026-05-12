import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, requirePagePermission, isAuthError } from "@/lib/api-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;
  const { searchParams } = new URL(request.url);
  const ownerId = searchParams.get("ownerId");
  const type = searchParams.get("type");
  const status = searchParams.get("status");
  const contractId = searchParams.get("contractId");

  const where: Record<string, unknown> = {};
  if (ownerId) where.ownerId = ownerId;
  if (type) where.type = type;
  if (status && status !== "all") {
    where.status = status;
  } else {
    // Fix Bug 19: exclui CANCELADO por default. Sem isso, retorno
    // CNAB e outras batch operations podiam pegar entries canceladas
    // e re-marcar como PAGO acidentalmente.
    where.status = { not: "CANCELADO" };
  }
  if (contractId) where.contractId = contractId;

  const includeRelations = {
    owner: { select: { id: true, name: true } },
  };

  const pageParam = searchParams.get("page");
  if (!pageParam) {
    // Legacy: return all as array
    const entries = await prisma.ownerEntry.findMany({
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
    prisma.ownerEntry.findMany({
      where,
      include: includeRelations,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.ownerEntry.count({ where }),
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
  const { type, category, description, value, ownerId } = body;
  if (!type || !category || !description || !value || !ownerId) {
    return NextResponse.json(
      { error: "Campos obrigatórios: type, category, description, value, ownerId" },
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
    "REPASSE", "REPARO", "TAXA_BANCARIA", "IPTU", "CONDOMINIO",
    "INTERMEDIACAO", "DESCONTO", "ACORDO", "GARANTIA", "OUTROS",
  ];
  if (!validCategories.includes(category)) {
    return NextResponse.json(
      { error: `Categoria inválida. Use: ${validCategories.join(", ")}` },
      { status: 400 }
    );
  }

  const installments = parseInt(body.installments) || 1;

  try {
  if (installments > 1) {
    // Create multiple installment entries
    const totalValue = parseFloat(value);
    const installmentValue = Math.round((totalValue / installments) * 100) / 100;
    const lastInstallmentValue = Math.round((totalValue - installmentValue * (installments - 1)) * 100) / 100;
    const baseDueDate = body.dueDate
      ? new Date(String(body.dueDate).includes("T") ? body.dueDate : body.dueDate + "T12:00:00")
      : new Date();

    // Create first entry
    const firstDueDate = new Date(baseDueDate);
    const firstEntry = await prisma.ownerEntry.create({
      data: {
        type,
        category,
        description,
        value: installmentValue,
        ownerId,
        dueDate: firstDueDate,
        contractId: body.contractId || null,
        propertyId: body.propertyId || null,
        status: body.status || "PENDENTE",
        notes: body.notes || null,
        installmentNumber: 1,
        installmentTotal: installments,
        isRecurring: body.isRecurring || false,
        recurringDay: body.recurringDay ? parseInt(body.recurringDay) : null,
        destination: body.destination || null,
        createdById: auth.user.id,
      },
      include: {
        owner: { select: { id: true, name: true } },
      },
    });

    // Create remaining entries linked to parent
    const remaining = await Promise.all(
      Array.from({ length: installments - 1 }, (_, idx) => {
        const dueDate = new Date(baseDueDate);
        dueDate.setMonth(dueDate.getMonth() + idx + 1);
        const isLastInstallment = idx === installments - 2;
        return prisma.ownerEntry.create({
          data: {
            type,
            category,
            description,
            value: isLastInstallment ? lastInstallmentValue : installmentValue,
            ownerId,
            dueDate,
            contractId: body.contractId || null,
            propertyId: body.propertyId || null,
            status: body.status || "PENDENTE",
            notes: body.notes || null,
            installmentNumber: idx + 2,
            installmentTotal: installments,
            parentEntryId: firstEntry.id,
            isRecurring: body.isRecurring || false,
            recurringDay: body.recurringDay ? parseInt(body.recurringDay) : null,
            destination: body.destination || null,
            createdById: auth.user.id,
          },
          include: {
            owner: { select: { id: true, name: true } },
          },
        });
      })
    );

    return NextResponse.json([firstEntry, ...remaining], { status: 201 });
  }

  // Single entry
  const entry = await prisma.ownerEntry.create({
    data: {
      type,
      category,
      description,
      value: parseFloat(value),
      ownerId,
      dueDate: body.dueDate
        ? new Date(String(body.dueDate).includes("T") ? body.dueDate : body.dueDate + "T12:00:00")
        : null,
      contractId: body.contractId || null,
      propertyId: body.propertyId || null,
      status: body.status || "PENDENTE",
      notes: body.notes || null,
      isRecurring: body.isRecurring || false,
      recurringDay: body.recurringDay ? parseInt(body.recurringDay) : null,
      destination: body.destination || null,
      createdById: auth.user.id,
    },
    include: {
      owner: { select: { id: true, name: true } },
    },
  });
  return NextResponse.json(entry, { status: 201 });
  } catch (error) {
    console.error("[OwnerEntries POST] Error:", error);
    return NextResponse.json({ error: "Erro interno do servidor" }, { status: 500 });
  }
}
