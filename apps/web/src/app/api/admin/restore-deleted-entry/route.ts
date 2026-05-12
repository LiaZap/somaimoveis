import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * GET  /api/admin/restore-deleted-entry?entity=OwnerEntry&limit=50
 *   Lista DELETEs recentes do AuditLog (entries que podem ser restauradas).
 *
 * POST /api/admin/restore-deleted-entry
 *   Body: { auditLogId: string }
 *   Restaura a entry a partir do snapshot guardado no AuditLog.
 *   Verifica se a entry NAO existe mais antes de criar.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  const { searchParams } = new URL(request.url);
  const entity = searchParams.get("entity") || "OwnerEntry"; // OwnerEntry | TenantEntry
  const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") || "50")));

  const logs = await prisma.auditLog.findMany({
    where: {
      action: "DELETE",
      entity,
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { user: { select: { name: true, email: true } } },
  });

  return NextResponse.json({
    total: logs.length,
    logs: logs.map((l) => {
      let snapshot: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(l.changes || "{}");
        snapshot = parsed.snapshot || {};
      } catch { /* ignore */ }
      return {
        auditLogId: l.id,
        entityId: l.entityId,
        entityName: l.entityName,
        deletedAt: l.createdAt,
        deletedBy: l.user?.name || l.userId,
        snapshot: {
          type: (snapshot as any).type,
          category: (snapshot as any).category,
          description: (snapshot as any).description,
          value: (snapshot as any).value,
          status: (snapshot as any).status,
          dueDate: (snapshot as any).dueDate,
          ownerId: (snapshot as any).ownerId,
          tenantId: (snapshot as any).tenantId,
          contractId: (snapshot as any).contractId,
        },
      };
    }),
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  try {
    const body = await request.json();
    const { auditLogId } = body;
    if (!auditLogId || typeof auditLogId !== "string") {
      return NextResponse.json({ error: "auditLogId obrigatorio" }, { status: 400 });
    }

    const log = await prisma.auditLog.findUnique({ where: { id: auditLogId } });
    if (!log) return NextResponse.json({ error: "AuditLog nao encontrado" }, { status: 404 });
    if (log.action !== "DELETE") {
      return NextResponse.json({ error: "AuditLog nao e de DELETE" }, { status: 400 });
    }

    let snapshot: any = {};
    try {
      const parsed = JSON.parse(log.changes || "{}");
      snapshot = parsed.snapshot || {};
    } catch {
      return NextResponse.json({ error: "Snapshot invalido no AuditLog" }, { status: 500 });
    }

    if (!snapshot.id) {
      return NextResponse.json({ error: "Snapshot nao tem ID — entry nao pode ser restaurada" }, { status: 500 });
    }

    // Verifica que a entry NAO existe (idempotencia)
    if (log.entity === "OwnerEntry") {
      const existing = await prisma.ownerEntry.findUnique({ where: { id: snapshot.id } });
      if (existing) {
        return NextResponse.json({
          message: "Entry ja existe — nada feito",
          entryId: snapshot.id,
        });
      }
      // Recria preservando o ID original
      const created = await prisma.ownerEntry.create({
        data: {
          id: snapshot.id,
          type: snapshot.type,
          category: snapshot.category,
          description: snapshot.description,
          value: snapshot.value,
          dueDate: snapshot.dueDate ? new Date(snapshot.dueDate) : null,
          paidAt: snapshot.paidAt ? new Date(snapshot.paidAt) : null,
          status: snapshot.status || "PENDENTE",
          ownerId: snapshot.ownerId,
          contractId: snapshot.contractId || null,
          propertyId: snapshot.propertyId || null,
          notes: snapshot.notes || null,
          isRecurring: snapshot.isRecurring || false,
          recurringDay: snapshot.recurringDay || null,
          destination: snapshot.destination || null,
          installmentNumber: snapshot.installmentNumber || null,
          installmentTotal: snapshot.installmentTotal || null,
          parentEntryId: snapshot.parentEntryId || null,
          createdById: snapshot.createdById || null,
        },
      });
      return NextResponse.json({ message: "OwnerEntry restaurada", entry: created });
    } else if (log.entity === "TenantEntry") {
      const existing = await prisma.tenantEntry.findUnique({ where: { id: snapshot.id } });
      if (existing) {
        return NextResponse.json({ message: "Entry ja existe", entryId: snapshot.id });
      }
      const created = await prisma.tenantEntry.create({
        data: {
          id: snapshot.id,
          type: snapshot.type,
          category: snapshot.category,
          description: snapshot.description,
          value: snapshot.value,
          dueDate: snapshot.dueDate ? new Date(snapshot.dueDate) : null,
          paidAt: snapshot.paidAt ? new Date(snapshot.paidAt) : null,
          status: snapshot.status || "PENDENTE",
          tenantId: snapshot.tenantId,
          contractId: snapshot.contractId || null,
          propertyId: snapshot.propertyId || null,
          notes: snapshot.notes || null,
          isRecurring: snapshot.isRecurring || false,
          recurringDay: snapshot.recurringDay || null,
          destination: snapshot.destination || null,
          installmentNumber: snapshot.installmentNumber || null,
          installmentTotal: snapshot.installmentTotal || null,
          parentEntryId: snapshot.parentEntryId || null,
          createdById: snapshot.createdById || null,
        },
      });
      return NextResponse.json({ message: "TenantEntry restaurada", entry: created });
    }

    return NextResponse.json({ error: `Entity ${log.entity} nao suportado` }, { status: 400 });
  } catch (error) {
    console.error("[restore-deleted-entry] Erro:", error);
    return NextResponse.json(
      { error: "Erro", details: error instanceof Error ? error.message : "desconhecido" },
      { status: 500 }
    );
  }
}
