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
  // Forms de associacao podem passar ?includeInactive=true para incluir
  // todos os registros (mesmo inativos) — evita "sumir" no select.
  const includeInactive = searchParams.get("includeInactive") === "true";

  // Normaliza o termo de busca: detecta se é provavelmente um CPF/CNPJ
  // (contém pelo menos 3 digitos consecutivos ou é predominantemente numérico)
  const searchDigits = search ? search.replace(/\D/g, "") : "";
  const isNumericSearch = !!search && searchDigits.length >= 3;

  const where: Record<string, unknown> = includeInactive ? {} : { active: true };

  // Busca tokenizada: cada palavra precisa estar em algum campo.
  // Ex: "Joao Silva" encontra "Joao da Silva", "Silva, Joao Manuel" etc.
  const searchWhere = buildSearchWhere(
    search,
    ["name", "email", "phone", "cpfCnpj"],
    { numericFields: ["cpfCnpj", "phone"] },
  );
  if (searchWhere) {
    where.AND = [...((where.AND as any[]) || []), ...searchWhere];
  }

  const includeRelations = {
    properties: { select: { id: true } },
    contracts: { where: { status: "ATIVO" }, select: { id: true, rentalValue: true } },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enrich = (owners: any[]) =>
    owners.map((owner) => ({
      ...owner,
      propertyCount: owner.properties.length,
      activeContractCount: owner.contracts.length,
      monthlyIncome: owner.contracts.reduce((sum: number, c: { rentalValue: number }) => sum + c.rentalValue, 0),
    }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filterByNormalizedCpf = (owners: any[]) => {
    if (!isNumericSearch) return owners;
    // Já vieram filtrados pelo Prisma, mas pode ter perdido casos com formatação
    // diferente. Se não houver match exato, fazer post-filter normalizando.
    const matchedDirect = owners.some((o: any) => {
      const c = (o.cpfCnpj || "").replace(/\D/g, "");
      return c.includes(searchDigits);
    });
    if (matchedDirect) return owners;
    // Fallback: re-filtrar normalizando
    return owners.filter((o: any) => {
      const c = (o.cpfCnpj || "").replace(/\D/g, "");
      const n = (o.name || "").toLowerCase();
      const e = (o.email || "").toLowerCase();
      const t = search!.toLowerCase();
      return c.includes(searchDigits) || n.includes(t) || e.includes(t);
    });
  };

  const pageParam = searchParams.get("page");
  if (!pageParam) {
    // Legacy: return all as array
    let owners = await prisma.owner.findMany({
      where,
      include: includeRelations,
      orderBy: { name: "asc" },
    });

    // Se a busca é numérica e veio pouca coisa, garantir busca normalizada full
    if (isNumericSearch && owners.length === 0 && search) {
      // Fallback: buscar todos active e filtrar no JS por CPF normalizado
      const all = await prisma.owner.findMany({
        where: { active: true },
        include: includeRelations,
        orderBy: { name: "asc" },
      });
      owners = all.filter((o: any) => {
        const c = (o.cpfCnpj || "").replace(/\D/g, "");
        return c.includes(searchDigits);
      });
    }

    return NextResponse.json(enrich(filterByNormalizedCpf(owners)));
  }

  // Paginated response
  const page = Math.max(1, parseInt(pageParam));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "50")));
  const skip = (page - 1) * limit;

  let [owners, total] = await Promise.all([
    prisma.owner.findMany({
      where,
      include: includeRelations,
      orderBy: { name: "asc" },
      skip,
      take: limit,
    }),
    prisma.owner.count({ where }),
  ]);

  // Fallback paginado para busca numérica que não retorna nada
  if (isNumericSearch && total === 0 && search) {
    const all = await prisma.owner.findMany({
      where: { active: true },
      include: includeRelations,
      orderBy: { name: "asc" },
    });
    const filtered = all.filter((o: any) => {
      const c = (o.cpfCnpj || "").replace(/\D/g, "");
      return c.includes(searchDigits);
    });
    total = filtered.length;
    owners = filtered.slice(skip, skip + limit);
  }

  return NextResponse.json({
    data: enrich(owners),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requirePagePermission("proprietarios");
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
  const existing = await prisma.owner.findUnique({ where: { cpfCnpj } });
  if (existing) {
    return NextResponse.json(
      { error: "Ja existe um proprietario com este CPF/CNPJ" },
      { status: 409 }
    );
  }
  try {
    const owner = await prisma.owner.create({
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
        bankName: body.bankName || null,
        bankAgency: body.bankAgency || null,
        bankAccount: body.bankAccount || null,
        bankPix: body.bankPix || null,
        bankPixType: body.bankPixType || null,
        thirdPartyName: body.thirdPartyName || null,
        thirdPartyDocument: body.thirdPartyDocument || null,
        thirdPartyBank: body.thirdPartyBank || null,
        thirdPartyAgency: body.thirdPartyAgency || null,
        thirdPartyAccount: body.thirdPartyAccount || null,
        thirdPartyPixKeyType: body.thirdPartyPixKeyType || null,
        thirdPartyPix: body.thirdPartyPix || null,
        birthDate: body.birthDate ? new Date(body.birthDate + "T12:00:00") : null,
        rgIssuer: body.rgIssuer || null,
        paymentDay: body.paymentDay ? parseInt(body.paymentDay) : 10,
        notes: body.notes || null,
        createdById: auth.user.id,
      },
    });
    await logAudit({
      userId: auth.user.id,
      action: "CREATE",
      entity: "Owner",
      entityId: owner.id,
      entityName: owner.name,
      entityCode: owner.cpfCnpj,
      request,
    });
    return NextResponse.json(owner, { status: 201 });
  } catch (error) {
    console.error("[Owners POST] Error:", error);
    return NextResponse.json({ error: "Erro interno do servidor" }, { status: 500 });
  }
}
