import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";
import { isAdmin } from "@/lib/rbac";

/**
 * GET /api/admin/delete-orphan-owner-entries
 *
 * Detecta OwnerEntries PENDENTES que foram criados a partir de um
 * TenantEntry (tem tenantEntryId no notes) mas o TenantEntry de origem
 * NAO EXISTE MAIS (foi apagado depois).
 *
 * Sao "lancamentos fantasmas" no proprietario que ficam pendurados sem
 * razao depois que o usuario corrigiu/refez o lancamento no locatario.
 *
 * Default: dry-run (so reporta).
 * Use ?delete=true para deletar.
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

  // Pega owner entries PENDENTES que tem tenantEntryId no notes
  const candidates = await prisma.ownerEntry.findMany({
    where: {
      status: "PENDENTE",
      notes: { contains: "tenantEntryId" },
    },
    select: {
      id: true,
      ownerId: true,
      contractId: true,
      description: true,
      value: true,
      dueDate: true,
      notes: true,
      owner: { select: { name: true } },
    },
  });

  // Extrai o tenantEntryId de cada notes
  const orphans: Array<{
    id: string;
    owner: string;
    description: string;
    value: number;
    dueDate: Date | null;
    tenantEntryId: string;
  }> = [];

  // Para evitar N queries, junta todos os tenantEntryIds e checa em batch
  const candidateMap = new Map<string, typeof candidates[number]>();
  for (const c of candidates) {
    if (!c.notes) continue;
    try {
      const parsed = JSON.parse(c.notes);
      if (typeof parsed.tenantEntryId === "string") {
        candidateMap.set(c.id, c);
      }
    } catch {
      // ignore
    }
  }

  // Coleta os tenantEntryIds unicos
  const tenantEntryIds = new Set<string>();
  for (const c of candidateMap.values()) {
    try {
      const parsed = JSON.parse(c.notes!);
      tenantEntryIds.add(parsed.tenantEntryId);
    } catch {}
  }

  // Busca quais existem
  const existing = await prisma.tenantEntry.findMany({
    where: { id: { in: Array.from(tenantEntryIds) } },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((e) => e.id));

  // Identifica orfaos (tenantEntryId nao existe)
  for (const c of candidateMap.values()) {
    let tEntryId: string | null = null;
    try {
      const parsed = JSON.parse(c.notes!);
      tEntryId = parsed.tenantEntryId;
    } catch {}
    if (tEntryId && !existingIds.has(tEntryId)) {
      orphans.push({
        id: c.id,
        owner: c.owner?.name || "?",
        description: c.description,
        value: c.value,
        dueDate: c.dueDate,
        tenantEntryId: tEntryId,
      });
    }
  }

  if (orphans.length === 0) {
    return NextResponse.json({
      message: "Nenhum lancamento orfao encontrado.",
      orphansFound: 0,
    });
  }

  if (!doDelete) {
    return NextResponse.json({
      mode: "DRY_RUN",
      message: `${orphans.length} orfao(s) detectado(s). Use ?delete=true para apagar.`,
      orphansFound: orphans.length,
      preview: orphans.slice(0, 30),
    });
  }

  const idsToDelete = orphans.map((o) => o.id);
  const result = await prisma.ownerEntry.deleteMany({
    where: { id: { in: idsToDelete } },
  });

  return NextResponse.json({
    mode: "DELETED",
    message: `Apagados ${result.count} lancamentos orfaos do proprietario.`,
    orphansFound: orphans.length,
    deleted: result.count,
  });
}
