import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, requirePagePermission, isAuthError } from "@/lib/api-auth";
import { logAudit } from "@/lib/audit-log";

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const type = searchParams.get("type");
  const search = searchParams.get("search");
  const includeInactive = searchParams.get("includeInactive") === "true";

  const where: Record<string, unknown> = includeInactive ? {} : { active: true };
  if (status && status !== "all") where.status = status;
  if (type && type !== "all") where.type = type;
  if (search) {
    where.OR = [
      { title: { contains: search } },
      { street: { contains: search } },
      { neighborhood: { contains: search } },
      { city: { contains: search } },
      { owner: { name: { contains: search } } },
    ];
  }

  const includeRelations = {
    photos: { orderBy: { order: "asc" as const }, take: 3 },
    owner: { select: { id: true, name: true } },
  };

  const pageParam = searchParams.get("page");
  if (!pageParam) {
    // Legacy: return all as array
    const properties = await prisma.property.findMany({
      where,
      include: includeRelations,
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(properties);
  }

  // Paginated response
  const page = Math.max(1, parseInt(pageParam));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "50")));
  const skip = (page - 1) * limit;

  const [properties, total] = await Promise.all([
    prisma.property.findMany({
      where,
      include: includeRelations,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.property.count({ where }),
  ]);

  return NextResponse.json({
    data: properties,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requirePagePermission("imoveis");
  if (isAuthError(auth)) return auth;
  const body = await request.json();
  const { title, type, street, number, neighborhood, city, state, zipCode, ownerId } = body;
  if (!title || !type || !street || !number || !neighborhood || !city || !state || !zipCode || !ownerId) {
    return NextResponse.json(
      { error: "Campos obrigatórios: title, type, street, number, neighborhood, city, state, zipCode, ownerId" },
      { status: 400 }
    );
  }
  try {
    const property = await prisma.property.create({
      data: {
        title, type, street, number, neighborhood, city, state, zipCode, ownerId,
        description: body.description || null,
        complement: body.complement || null,
        status: body.status || "DISPONIVEL",
        area: body.area ? parseFloat(body.area) : null,
        bedrooms: body.bedrooms ? parseInt(body.bedrooms) : 0,
        bathrooms: body.bathrooms ? parseInt(body.bathrooms) : 0,
        parkingSpaces: body.parkingSpaces ? parseInt(body.parkingSpaces) : 0,
        furnished: body.furnished || false,
        rentalValue: body.rentalValue ? parseFloat(body.rentalValue) : null,
        saleValue: body.saleValue ? parseFloat(body.saleValue) : null,
        condoFee: body.condoFee ? parseFloat(body.condoFee) : null,
        iptuValue: body.iptuValue ? parseFloat(body.iptuValue) : null,
        registrationNumber: body.registrationNumber || null,
        iptuNumber: body.iptuNumber || null,
        energyMeter: body.energyMeter || null,
        waterMeter: body.waterMeter || null,
        gasMeter: body.gasMeter || null,
        condoAdmin: body.condoAdmin || null,
        notes: body.notes || null,
        createdById: auth.user.id,
      },
      include: { owner: { select: { id: true, name: true } } },
    });
    await logAudit({
      userId: auth.user.id,
      action: "CREATE",
      entity: "Property",
      entityId: property.id,
      entityName: property.title,
      request,
    });
    return NextResponse.json(property, { status: 201 });
  } catch (error) {
    console.error("[Properties POST] Error:", error);
    return NextResponse.json({ error: "Erro interno do servidor" }, { status: 500 });
  }
}
