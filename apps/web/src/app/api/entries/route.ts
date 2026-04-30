import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";
import { buildSearchWhere } from "@/lib/search";

/**
 * Unified GET endpoint for tenant + owner entries used by /lancamentos page.
 * Supports server-side pagination, filtering and search to avoid loading
 * thousands of records on the client.
 *
 * Query params:
 *  - page (default 1)
 *  - limit (default 50, max 200)
 *  - source: "todos" | "locatario" | "proprietario"
 *  - type: "DEBITO" | "CREDITO"
 *  - status: "PENDENTE" | "PAGO" | "CANCELADO"
 *  - search: nome da pessoa OR descricao
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") || "50")));
  const source = (searchParams.get("source") || "todos").toLowerCase();
  const type = searchParams.get("type"); // DEBITO | CREDITO | null
  const status = searchParams.get("status"); // PENDENTE | PAGO | CANCELADO | null
  const search = (searchParams.get("search") || "").trim();

  const tenantWhere: Record<string, unknown> = {};
  const ownerWhere: Record<string, unknown> = {};

  if (type === "DEBITO" || type === "CREDITO") {
    tenantWhere.type = type;
    ownerWhere.type = type;
  }
  if (status && status !== "todos") {
    tenantWhere.status = status;
    ownerWhere.status = status;
  }
  // Busca tokenizada em ambos lados.
  const tenantSearch = buildSearchWhere(search, [
    "description",
    "category",
    "tenant.name",
    "tenant.cpfCnpj",
  ]);
  if (tenantSearch) {
    tenantWhere.AND = [...((tenantWhere.AND as any[]) || []), ...tenantSearch];
  }
  const ownerSearch = buildSearchWhere(search, [
    "description",
    "category",
    "owner.name",
    "owner.cpfCnpj",
  ]);
  if (ownerSearch) {
    ownerWhere.AND = [...((ownerWhere.AND as any[]) || []), ...ownerSearch];
  }

  const includeTenant = !["proprietario"].includes(source);
  const includeOwner = !["locatario"].includes(source);

  // Count totals first (cheap thanks to indexes)
  const [tenantCount, ownerCount] = await Promise.all([
    includeTenant ? prisma.tenantEntry.count({ where: tenantWhere }) : Promise.resolve(0),
    includeOwner ? prisma.ownerEntry.count({ where: ownerWhere }) : Promise.resolve(0),
  ]);
  const total = tenantCount + ownerCount;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  // To paginate across two tables, we fetch up to (page * limit) from each
  // sorted by createdAt desc, merge, sort and slice. This caps the work at
  // O(page * limit) records loaded, which is fine for typical browsing.
  // For deep pages (rare in this UI) we still beat loading everything.
  const headSize = page * limit;

  const baseSelect = {
    id: true,
    type: true,
    category: true,
    description: true,
    value: true,
    dueDate: true,
    status: true,
    notes: true,
    createdAt: true,
    installmentNumber: true,
    installmentTotal: true,
    parentEntryId: true,
    isRecurring: true,
    recurringDay: true,
    destination: true,
  } as const;

  const [tenantRows, ownerRows] = await Promise.all([
    includeTenant
      ? prisma.tenantEntry.findMany({
          where: tenantWhere,
          select: {
            ...baseSelect,
            tenantId: true,
            tenant: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: "desc" },
          take: headSize,
        })
      : Promise.resolve([] as any[]),
    includeOwner
      ? prisma.ownerEntry.findMany({
          where: ownerWhere,
          select: {
            ...baseSelect,
            ownerId: true,
            owner: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: "desc" },
          take: headSize,
        })
      : Promise.resolve([] as any[]),
  ]);

  type Row = typeof tenantRows[number] & { entrySource: "tenant" | "owner"; personName: string };
  const merged: Row[] = [];
  for (const r of tenantRows) {
    merged.push({
      ...(r as any),
      entrySource: "tenant",
      personName: (r as any).tenant?.name || "N/A",
    });
  }
  for (const r of ownerRows) {
    merged.push({
      ...(r as any),
      entrySource: "owner",
      personName: (r as any).owner?.name || "N/A",
    });
  }

  merged.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const start = (page - 1) * limit;
  const data = merged.slice(start, start + limit);

  return NextResponse.json({
    data,
    pagination: { page, limit, total, totalPages },
  });
}
