import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";
import { isAdmin } from "@/lib/rbac";

/**
 * GET /api/admin/delete-legacy-owner-entries
 *
 * Apaga lancamentos do proprietario PENDENTES no formato "antigo" —
 * criados antes do refactor in-arrears. Identificados por:
 *  - status = PENDENTE
 *  - notes contem tenantEntryId (foi criado por billing, nao manual)
 *  - contractId IS NULL (formato antigo nao preenchia)
 *
 * Esses lancamentos serao recriados corretamente quando o usuario
 * gerar boletos dos meses correspondentes com a nova logica
 * (in-arrears, com contractId, descricao mes_referencia).
 *
 * Default: dry-run. Use ?delete=true para apagar.
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

  // Busca todas com tenantEntryId no notes E contractId null
  const candidates = await prisma.ownerEntry.findMany({
    where: {
      status: "PENDENTE",
      contractId: null,
      notes: { contains: "tenantEntryId" },
    },
    select: {
      id: true,
      ownerId: true,
      owner: { select: { name: true } },
      description: true,
      value: true,
      dueDate: true,
    },
  });

  if (candidates.length === 0) {
    return NextResponse.json({
      message: "Nenhum lancamento legacy encontrado.",
      legacyFound: 0,
    });
  }

  if (!doDelete) {
    return NextResponse.json({
      mode: "DRY_RUN",
      message: `${candidates.length} lancamento(s) legacy detectado(s). Use ?delete=true para apagar.`,
      legacyFound: candidates.length,
      preview: candidates.slice(0, 30).map((c) => ({
        id: c.id,
        owner: c.owner?.name,
        description: c.description,
        value: c.value,
        dueDate: c.dueDate,
      })),
      hint: "Esses serao recriados quando o usuario gerar boletos dos meses correspondentes com o codigo novo.",
    });
  }

  const idsToDelete = candidates.map((c) => c.id);
  const result = await prisma.ownerEntry.deleteMany({
    where: { id: { in: idsToDelete } },
  });

  return NextResponse.json({
    mode: "DELETED",
    message: `${result.count} lancamentos legacy apagados.`,
    deleted: result.count,
  });
}
