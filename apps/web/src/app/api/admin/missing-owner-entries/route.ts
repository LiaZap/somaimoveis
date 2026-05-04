import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";
import { isAdmin } from "@/lib/rbac";

/**
 * GET /api/admin/missing-owner-entries
 *
 * Compara TenantEntries com destination=PROPRIETARIO contra OwnerEntries
 * existentes (linkados pelo tenantEntryId no notes). Reporta o que esta
 * "faltando" — ou seja, lancamentos do locatario que deveriam gerar
 * credito no proprietario mas o credito nao existe no banco.
 *
 * Util pra ver o que precisa ser regenerado apos uma limpeza ou para
 * descobrir bugs do billing.
 *
 * Query params:
 *   ?from=YYYY-MM  → considera so tenant entries com dueDate >= esse mes
 *   ?to=YYYY-MM    → considera so tenant entries com dueDate <= esse mes
 *
 * Apenas ADMIN.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  if (!isAdmin(auth.user.role)) {
    return NextResponse.json(
      { error: "Apenas administradores podem rodar este script" },
      { status: 403 },
    );
  }

  const { searchParams } = new URL(request.url);
  const fromStr = searchParams.get("from"); // YYYY-MM
  const toStr = searchParams.get("to"); // YYYY-MM

  const dueDateFilter: { gte?: Date; lte?: Date } = {};
  if (fromStr && /^\d{4}-\d{2}$/.test(fromStr)) {
    const [y, m] = fromStr.split("-").map(Number);
    dueDateFilter.gte = new Date(y, m - 1, 1);
  }
  if (toStr && /^\d{4}-\d{2}$/.test(toStr)) {
    const [y, m] = toStr.split("-").map(Number);
    dueDateFilter.lte = new Date(y, m, 0, 23, 59, 59, 999);
  }

  // Tenant entries com destination=PROPRIETARIO, status=PENDENTE
  const tenantEntries = await prisma.tenantEntry.findMany({
    where: {
      destination: "PROPRIETARIO",
      status: "PENDENTE",
      ...(Object.keys(dueDateFilter).length > 0 ? { dueDate: dueDateFilter } : {}),
    },
    select: {
      id: true,
      tenantId: true,
      tenant: { select: { name: true } },
      type: true,
      category: true,
      description: true,
      value: true,
      dueDate: true,
      installmentNumber: true,
      installmentTotal: true,
    },
  });

  if (tenantEntries.length === 0) {
    return NextResponse.json({
      message: "Nenhum lancamento do locatario com destino PROPRIETARIO encontrado.",
      missingFound: 0,
    });
  }

  // Pega todos os OwnerEntries que tem tenantEntryId no notes
  const allOwnerEntries = await prisma.ownerEntry.findMany({
    where: {
      status: "PENDENTE",
      notes: { contains: "tenantEntryId" },
    },
    select: { id: true, notes: true },
  });

  const linkedTenantEntryIds = new Set<string>();
  for (const oe of allOwnerEntries) {
    if (!oe.notes) continue;
    try {
      const parsed = JSON.parse(oe.notes);
      if (typeof parsed.tenantEntryId === "string") {
        linkedTenantEntryIds.add(parsed.tenantEntryId);
      }
    } catch {
      // ignore
    }
  }

  // Identifica os "missing"
  const missing = tenantEntries.filter((te) => !linkedTenantEntryIds.has(te.id));

  // Agrupa por mês de dueDate pra facilitar análise
  const byMonth = new Map<string, number>();
  for (const m of missing) {
    if (!m.dueDate) continue;
    const d = new Date(m.dueDate);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    byMonth.set(key, (byMonth.get(key) || 0) + 1);
  }

  return NextResponse.json({
    totalTenantEntries: tenantEntries.length,
    missingFound: missing.length,
    byMonth: Array.from(byMonth.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, count]) => ({ month, count })),
    preview: missing.slice(0, 50).map((m) => ({
      id: m.id,
      tenant: m.tenant?.name,
      category: m.category,
      description: m.description,
      installment: m.installmentNumber && m.installmentTotal
        ? `${m.installmentNumber}/${m.installmentTotal}`
        : null,
      value: m.value,
      dueDate: m.dueDate,
    })),
    hint: "Para regenerar, rode 'Gerar Cobrancas' para cada mes listado em byMonth.",
  });
}
