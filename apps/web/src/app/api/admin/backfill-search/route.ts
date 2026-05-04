import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";
import { isAdmin } from "@/lib/rbac";
import { normalizeForSearch } from "@/lib/search";

/**
 * POST /api/admin/backfill-search
 *
 * Endpoint one-shot pra popular as colunas nameNormalized e titleNormalized
 * em registros existentes. Roda apos a migration que adicionou as colunas.
 * Idempotente — pode rodar quantas vezes quiser.
 *
 * Apenas ADMIN pode rodar.
 *
 * Uso:
 *   curl -X POST https://seudominio.com/api/admin/backfill-search \
 *        -H "Cookie: next-auth.session-token=..."
 */
export async function POST(_request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  if (!isAdmin(auth.user.role)) {
    return NextResponse.json(
      { error: "Apenas administradores podem rodar este backfill" },
      { status: 403 },
    );
  }

  const result = {
    owners: 0,
    tenants: 0,
    properties: 0,
  };

  // Owners
  const owners = await prisma.owner.findMany({ select: { id: true, name: true } });
  for (const o of owners) {
    await prisma.owner.update({
      where: { id: o.id },
      data: { nameNormalized: normalizeForSearch(o.name) },
    });
    result.owners++;
  }

  // Tenants
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  for (const t of tenants) {
    await prisma.tenant.update({
      where: { id: t.id },
      data: { nameNormalized: normalizeForSearch(t.name) },
    });
    result.tenants++;
  }

  // Properties
  const properties = await prisma.property.findMany({ select: { id: true, title: true } });
  for (const p of properties) {
    await prisma.property.update({
      where: { id: p.id },
      data: { titleNormalized: normalizeForSearch(p.title) },
    });
    result.properties++;
  }

  return NextResponse.json({
    message: `Backfill concluido: ${result.owners} owners, ${result.tenants} tenants, ${result.properties} properties.`,
    ...result,
  });
}

// Tambem aceita GET pra facilitar (apenas admin)
export async function GET(request: NextRequest) {
  return POST(request);
}
