import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";
import { isAdmin } from "@/lib/rbac";

/**
 * GET /api/admin/dedupe-tenant-entries
 *
 * Detecta lancamentos do locatario que parecem duplicatas:
 *  - Mesmo tenantId + mesma categoria + mesmo valor
 *  - Existe versao parcelada (installmentNumber/Total) E versao
 *    sem parcelamento, ambos com mesmo valor
 *  - Modo padrao: APENAS REPORTA (dry-run). Use ?delete=true para
 *    realmente apagar as nao-parceladas (mantendo as parceladas).
 *
 * Tambem deleta os OwnerEntries linkados aos tenant entries que vao
 * ser apagados (cascade).
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
  const doDelete = searchParams.get("delete") === "true";

  // Pega todos os PENDENTES com installmentNumber preenchido
  const installmentEntries = await prisma.tenantEntry.findMany({
    where: {
      status: "PENDENTE",
      installmentNumber: { not: null },
      installmentTotal: { not: null },
    },
    select: {
      id: true,
      tenantId: true,
      category: true,
      value: true,
      contractId: true,
    },
  });

  // Cria um set de chaves (tenantId|category|value|contractId) que tem parcelado
  const installmentKeys = new Set<string>();
  for (const e of installmentEntries) {
    const key = [
      e.tenantId,
      e.category,
      e.value.toFixed(2),
      e.contractId || "null",
    ].join("|");
    installmentKeys.add(key);
  }

  // Agora pega os PENDENTES SEM parcelamento e checa se existe parcelado
  // com mesma chave
  const nonInstallmentEntries = await prisma.tenantEntry.findMany({
    where: {
      status: "PENDENTE",
      installmentNumber: null,
    },
    select: {
      id: true,
      tenantId: true,
      tenant: { select: { name: true } },
      category: true,
      value: true,
      contractId: true,
      description: true,
      dueDate: true,
    },
  });

  const duplicates = nonInstallmentEntries.filter((e) => {
    const key = [
      e.tenantId,
      e.category,
      e.value.toFixed(2),
      e.contractId || "null",
    ].join("|");
    return installmentKeys.has(key);
  });

  if (duplicates.length === 0) {
    return NextResponse.json({
      message: "Nenhuma duplicata encontrada.",
      duplicatesFound: 0,
    });
  }

  // Modo dry-run: so reporta
  if (!doDelete) {
    return NextResponse.json({
      mode: "DRY_RUN",
      message: `${duplicates.length} duplicata(s) detectada(s). Use ?delete=true para deletar.`,
      duplicatesFound: duplicates.length,
      preview: duplicates.slice(0, 30).map((d) => ({
        id: d.id,
        tenant: d.tenant?.name,
        category: d.category,
        description: d.description,
        value: d.value,
        dueDate: d.dueDate,
      })),
      hint: "Mantemos as versoes parceladas (com X/Y) e apagamos as sem parcela.",
    });
  }

  // Modo delete real
  const idsToDelete = duplicates.map((d) => d.id);

  // Primeiro deleta os OwnerEntries linkados a esses tenant entries
  // (notes contem o tenantEntryId)
  let ownerEntriesDeleted = 0;
  for (const id of idsToDelete) {
    const linked = await prisma.ownerEntry.deleteMany({
      where: {
        notes: { contains: id },
        status: "PENDENTE",
      },
    });
    ownerEntriesDeleted += linked.count;
  }

  // Depois deleta os tenant entries
  const tenantResult = await prisma.tenantEntry.deleteMany({
    where: { id: { in: idsToDelete } },
  });

  return NextResponse.json({
    mode: "DELETED",
    message: `Apagado: ${tenantResult.count} lancamentos do locatario + ${ownerEntriesDeleted} lancamentos do proprietario linkados.`,
    tenantEntriesDeleted: tenantResult.count,
    ownerEntriesDeleted,
  });
}
