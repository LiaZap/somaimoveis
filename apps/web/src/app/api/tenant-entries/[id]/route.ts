import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, requirePagePermission, isAuthError } from "@/lib/api-auth";
import { logAudit } from "@/lib/audit-log";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;
  try {
    const { id } = await params;
    const entry = await prisma.tenantEntry.findUnique({
      where: { id },
      include: { tenant: true },
    });
    if (!entry) {
      return NextResponse.json({ error: "Lançamento não encontrado" }, { status: 404 });
    }
    return NextResponse.json(entry);
  } catch (error) {
    return NextResponse.json({ error: "Erro ao buscar lançamento" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requirePagePermission("lancamentos");
  if (isAuthError(auth)) return auth;
  try {
    const { id } = await params;
    const body = await request.json();

    // Whitelist allowed fields to prevent mass assignment
    const data: Record<string, unknown> = {};
    if (body.type !== undefined) data.type = body.type;
    if (body.category !== undefined) data.category = body.category;
    if (body.description !== undefined) data.description = body.description;
    if (body.status !== undefined) data.status = body.status;
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.destination !== undefined) data.destination = body.destination;
    // Fix Paulo 19/05/2026: permitir vincular contractId/propertyId em entries
    // legadas. Era critico pra dedupe TenantEntry x OwnerEntry no demonstrativo
    // (TenantEntry destination=PROPRIETARIO sem contractId nao deduplicava com
    // OwnerEntry (50%) — IPTU aparecia em dobro para coproprietarios).
    if (body.contractId !== undefined) data.contractId = body.contractId || null;
    if (body.propertyId !== undefined) data.propertyId = body.propertyId || null;
    if (body.isRecurring !== undefined) data.isRecurring = body.isRecurring;
    if (body.recurringDay !== undefined) data.recurringDay = body.recurringDay ? parseInt(body.recurringDay) : null;
    if (body.value !== undefined) data.value = parseFloat(body.value as string);
    if (body.dueDate !== undefined) {
      const d = String(body.dueDate);
      data.dueDate = body.dueDate ? new Date(d.includes("T") ? d : d + "T12:00:00") : null;
    }
    if (body.paidAt !== undefined) {
      const d = String(body.paidAt);
      data.paidAt = body.paidAt ? new Date(d.includes("T") ? d : d + "T12:00:00") : null;
    }

    const entry = await prisma.tenantEntry.update({
      where: { id },
      data,
      include: { tenant: true },
    });
    return NextResponse.json(entry);
  } catch (error: any) {
    if (error?.code === "P2025") {
      return NextResponse.json({ error: "Lançamento não encontrado" }, { status: 404 });
    }
    return NextResponse.json({ error: "Erro ao atualizar lançamento" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requirePagePermission("lancamentos");
  if (isAuthError(auth)) return auth;
  try {
    const { id } = await params;
    // Captura snapshot pra log de auditoria — permite recriar se exclusao
    // for por engano.
    const snapshot = await prisma.tenantEntry.findUnique({ where: { id } });
    if (!snapshot) {
      return NextResponse.json({ error: "Lançamento não encontrado" }, { status: 404 });
    }
    await prisma.tenantEntry.delete({ where: { id } });
    await logAudit({
      userId: auth.user.id,
      action: "DELETE",
      entity: "TenantEntry",
      entityId: id,
      entityName: snapshot.description,
      changes: { snapshot: snapshot as unknown as Record<string, unknown> },
      request,
    });
    return NextResponse.json({ message: "Lançamento excluído com sucesso" });
  } catch (error: any) {
    if (error?.code === "P2025") {
      return NextResponse.json({ error: "Lançamento não encontrado" }, { status: 404 });
    }
    return NextResponse.json({ error: "Erro ao excluir lançamento" }, { status: 500 });
  }
}
