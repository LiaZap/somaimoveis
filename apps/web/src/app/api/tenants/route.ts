import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, requirePagePermission, isAuthError } from "@/lib/api-auth";
import { logAudit } from "@/lib/audit-log";
import { buildSearchWhere } from "@/lib/search";

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;
  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search");
  const includeInactive = searchParams.get("includeInactive") === "true";
  const searchDigits = search ? search.replace(/\D/g, "") : "";
  const isNumericSearch = !!search && searchDigits.length >= 3;

  const where: Record<string, unknown> = includeInactive ? {} : { active: true };

  // Busca tokenizada: cada palavra precisa estar em algum campo.
  const searchWhere = buildSearchWhere(
    search,
    ["name", "email", "phone", "cpfCnpj"],
    { numericFields: ["cpfCnpj", "phone"] },
  );
  if (searchWhere) {
    where.AND = [...((where.AND as any[]) || []), ...searchWhere];
  }

  const includeRelations = {
    contracts: {
      where: { status: "ATIVO" },
      include: { property: { select: { title: true } } },
      take: 1,
    },
    payments: {
      orderBy: { dueDate: "desc" as const },
      take: 1,
      select: { status: true },
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enrich = (tenants: any[]) =>
    tenants.map((tenant) => ({
      ...tenant,
      currentProperty: tenant.contracts[0]?.property?.title || null,
      contractEndDate: tenant.contracts[0]
        ? (tenant.contracts[0] as { endDate: Date }).endDate
        : null,
      paymentStatus: tenant.payments[0]?.status || "SEM_COBRANCA",
    }));

  const pageParam = searchParams.get("page");
  if (!pageParam) {
    // Legacy: return all as array
    let tenants = await prisma.tenant.findMany({
      where,
      include: includeRelations,
      orderBy: { name: "asc" },
    });
    // Fallback: busca numérica sem resultado, normalizar CPF
    if (isNumericSearch && tenants.length === 0 && search) {
      const all = await prisma.tenant.findMany({
        where: { active: true },
        include: includeRelations,
        orderBy: { name: "asc" },
      });
      tenants = all.filter((t: any) => {
        const c = (t.cpfCnpj || "").replace(/\D/g, "");
        return c.includes(searchDigits);
      });
    }
    return NextResponse.json(enrich(tenants));
  }

  // Paginated response
  const page = Math.max(1, parseInt(pageParam));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "50")));
  const skip = (page - 1) * limit;

  let [tenants, total] = await Promise.all([
    prisma.tenant.findMany({
      where,
      include: includeRelations,
      orderBy: { name: "asc" },
      skip,
      take: limit,
    }),
    prisma.tenant.count({ where }),
  ]);

  if (isNumericSearch && total === 0 && search) {
    const all = await prisma.tenant.findMany({
      where: { active: true },
      include: includeRelations,
      orderBy: { name: "asc" },
    });
    const filtered = all.filter((t: any) => {
      const c = (t.cpfCnpj || "").replace(/\D/g, "");
      return c.includes(searchDigits);
    });
    total = filtered.length;
    tenants = filtered.slice(skip, skip + limit);
  }

  return NextResponse.json({
    data: enrich(tenants),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requirePagePermission("locatarios");
  if (isAuthError(auth)) return auth;
  const body = await request.json();
  const { name, cpfCnpj } = body;
  if (!name || !cpfCnpj) {
    return NextResponse.json(
      { error: "Campos obrigatórios: name, cpfCnpj" },
      { status: 400 }
    );
  }
  // Check duplicate CPF/CNPJ
  const existing = await prisma.tenant.findUnique({ where: { cpfCnpj } });
  if (existing) {
    return NextResponse.json(
      { error: "Ja existe um locatario com este CPF/CNPJ" },
      { status: 409 }
    );
  }
  const tenant = await prisma.tenant.create({
    data: {
      name, cpfCnpj,
      email: body.email || null,
      phone: body.phone || null,
      phone2: body.phone2 || null,
      email2: body.email2 || null,
      personType: body.personType || "PF",
      stateRegistration: body.stateRegistration || null,
      street: body.street || null,
      number: body.number || null,
      complement: body.complement || null,
      neighborhood: body.neighborhood || null,
      city: body.city || null,
      state: body.state || null,
      zipCode: body.zipCode || null,
      rgNumber: body.rgNumber || null,
      rgIssuer: body.rgIssuer || null,
      birthDate: body.birthDate ? new Date(body.birthDate + "T12:00:00") : null,
      occupation: body.occupation || null,
      monthlyIncome: body.monthlyIncome ? parseFloat(body.monthlyIncome) : null,
      paymentDay: body.paymentDay ? parseInt(body.paymentDay) : 5,
      notes: body.notes || null,
      createdById: auth.user.id,
    },
  });
  await logAudit({
    userId: auth.user.id,
    action: "CREATE",
    entity: "Tenant",
    entityId: tenant.id,
    entityName: tenant.name,
    entityCode: tenant.cpfCnpj,
    request,
  });
  return NextResponse.json(tenant, { status: 201 });
}
