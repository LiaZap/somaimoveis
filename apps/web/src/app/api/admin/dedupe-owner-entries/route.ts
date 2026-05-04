import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";
import { isAdmin } from "@/lib/rbac";

/**
 * GET /api/admin/dedupe-owner-entries
 *
 * Limpa lancamentos de proprietario duplicados criados por re-geracao de
 * cobrancas. Mantem o mais antigo de cada grupo (mais provavel de ja ter
 * sido conferido), descarta os demais.
 *
 * Identifica duplicata pelo conjunto:
 *  - ownerId + contractId + dueDate + description + type + value
 *  - status = PENDENTE
 *
 * Apenas ADMIN pode rodar. Idempotente.
 */
export async function GET(_request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  if (!isAdmin(auth.user.role)) {
    return NextResponse.json(
      { error: "Apenas administradores podem rodar este script" },
      { status: 403 },
    );
  }

  const allEntries = await prisma.ownerEntry.findMany({
    where: { status: "PENDENTE" },
    select: {
      id: true,
      ownerId: true,
      contractId: true,
      dueDate: true,
      description: true,
      type: true,
      category: true,
      value: true,
      notes: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" }, // mais recente primeiro
  });

  // Helper: extrai o codigo do contrato da descricao (ex: 'IPTU 04/2026 - CTR-19 (50%)' → 'CTR-19')
  function extractContractCode(description: string): string | null {
    const match = description.match(/\b(CTR-[\w-]+|\d{3,})\b/);
    return match ? match[1] : null;
  }

  // Helper: extrai tenantEntryId do notes (entries criadas a partir de
  // lancamentos do locatario com destination=PROPRIETARIO)
  function extractTenantEntryId(notes: string | null): string | null {
    if (!notes) return null;
    try {
      const parsed = JSON.parse(notes);
      return typeof parsed.tenantEntryId === "string" ? parsed.tenantEntryId : null;
    } catch {
      return null;
    }
  }

  // Helper: extrai sharePercent do notes
  function extractSharePercent(notes: string | null): number | null {
    if (!notes) return null;
    try {
      const parsed = JSON.parse(notes);
      return typeof parsed.sharePercent === "number" ? parsed.sharePercent : null;
    } catch {
      return null;
    }
  }

  // Agrupa em duas categorias:
  // 1) Entries com tenantEntryId no notes → chave: (ownerId, tenantEntryId, value)
  //    O mesmo lancamento do locatario nao deve gerar 2 entradas pro mesmo
  //    proprietario. Diferentes mLabels (descricoes) sao a mesma coisa.
  // 2) Entries sem tenantEntryId (REPASSE, etc) → chave: (ownerId, contractId,
  //    dueDate, description, type, value) — match exato como antes.
  const groups = new Map<string, typeof allEntries>();
  for (const entry of allEntries) {
    const tenantEntryId = extractTenantEntryId(entry.notes);
    let key: string;
    if (tenantEntryId) {
      // Mesmo lancamento de origem → so pode existir 1 por proprietario+share.
      // NAO usa contractId na chave porque entries antigas podem ter
      // contractId=null mas referirem ao mesmo contrato (CTR-XX na descricao).
      const share = extractSharePercent(entry.notes);
      key = [
        "TE",
        entry.ownerId,
        tenantEntryId,
        share !== null ? share.toFixed(2) : "100",
      ].join("|");
    } else {
      // Sem tenantEntryId (REPASSE etc) → match exato
      key = [
        "EX",
        entry.ownerId,
        entry.contractId || "null",
        entry.dueDate?.toISOString() || "null",
        entry.description,
        entry.type,
        entry.value.toFixed(2),
      ].join("|");
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }

  // Identifica IDs a deletar (manter o MAIS RECENTE de cada grupo —
  // ele reflete o estado atual do banco apos o ultimo billing)
  const idsToDelete: string[] = [];
  let groupsWithDupes = 0;
  for (const [, entries] of groups) {
    if (entries.length > 1) {
      groupsWithDupes++;
      // Como ordenamos createdAt: "desc", o primeiro eh o mais recente.
      // Descarta os demais (mais antigos).
      for (let i = 1; i < entries.length; i++) {
        idsToDelete.push(entries[i].id);
      }
    }
  }

  if (idsToDelete.length === 0) {
    return NextResponse.json({
      message: "Nenhuma duplicata encontrada.",
      deleted: 0,
      groupsAnalyzed: groups.size,
    });
  }

  // Deleta em lote
  const result = await prisma.ownerEntry.deleteMany({
    where: { id: { in: idsToDelete } },
  });

  return NextResponse.json({
    message: `Deduplicado: ${result.count} lancamentos removidos de ${groupsWithDupes} grupos com duplicatas.`,
    deleted: result.count,
    groupsAnalyzed: groups.size,
    groupsWithDupes,
  });
}
