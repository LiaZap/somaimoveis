import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";
import { buildSearchWhere } from "@/lib/search";

/**
 * Aggregated totals for the lancamentos summary cards.
 * Uses Prisma aggregate so the DB does the SUM — no row payload over the wire.
 *
 * Query params: source, type, status, search (same as /api/entries)
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  const { searchParams } = new URL(request.url);
  const source = (searchParams.get("source") || "todos").toLowerCase();
  const type = searchParams.get("type");
  const status = searchParams.get("status");
  const search = (searchParams.get("search") || "").trim();

  const includeTenant = source !== "proprietario";
  const includeOwner = source !== "locatario";

  function buildWhere(target: "tenant" | "owner", forType?: string) {
    const where: Record<string, unknown> = {};
    if (forType) where.type = forType;
    else if (type === "DEBITO" || type === "CREDITO") where.type = type;
    // For totals we ignore CANCELADO
    if (status && status !== "todos") where.status = status;
    else where.status = { not: "CANCELADO" };
    const fields = target === "tenant"
      ? ["description", "category", "tenant.name", "tenant.cpfCnpj"]
      : ["description", "category", "owner.name", "owner.cpfCnpj"];
    const searchWhere = buildSearchWhere(search, fields);
    if (searchWhere) {
      where.AND = [...((where.AND as any[]) || []), ...searchWhere];
    }
    return where;
  }

  const [tDebito, tCredito, oDebito, oCredito, tCount, oCount] = await Promise.all([
    includeTenant
      ? prisma.tenantEntry.aggregate({ _sum: { value: true }, where: buildWhere("tenant", "DEBITO") })
      : Promise.resolve({ _sum: { value: 0 } } as any),
    includeTenant
      ? prisma.tenantEntry.aggregate({ _sum: { value: true }, where: buildWhere("tenant", "CREDITO") })
      : Promise.resolve({ _sum: { value: 0 } } as any),
    includeOwner
      ? prisma.ownerEntry.aggregate({ _sum: { value: true }, where: buildWhere("owner", "DEBITO") })
      : Promise.resolve({ _sum: { value: 0 } } as any),
    includeOwner
      ? prisma.ownerEntry.aggregate({ _sum: { value: true }, where: buildWhere("owner", "CREDITO") })
      : Promise.resolve({ _sum: { value: 0 } } as any),
    includeTenant ? prisma.tenantEntry.count({ where: buildWhere("tenant") }) : Promise.resolve(0),
    includeOwner ? prisma.ownerEntry.count({ where: buildWhere("owner") }) : Promise.resolve(0),
  ]);

  const totalDebitos = (tDebito._sum.value || 0) + (oDebito._sum.value || 0);
  const totalCreditos = (tCredito._sum.value || 0) + (oCredito._sum.value || 0);
  const total = tCount + oCount;

  return NextResponse.json({ total, totalDebitos, totalCreditos });
}
