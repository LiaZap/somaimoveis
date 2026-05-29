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
    const entry = await prisma.ownerEntry.findUnique({
      where: { id },
      include: { owner: true },
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
    if (body.isRecurring !== undefined) data.isRecurring = body.isRecurring;
    if (body.destination !== undefined) data.destination = body.destination;
    if (body.value !== undefined) data.value = parseFloat(body.value as string);
    if (body.dueDate !== undefined) {
      const d = String(body.dueDate);
      data.dueDate = body.dueDate ? new Date(d.includes("T") ? d : d + "T12:00:00") : null;
    }
    if (body.paidAt !== undefined) {
      const d = String(body.paidAt);
      data.paidAt = body.paidAt ? new Date(d.includes("T") ? d : d + "T12:00:00") : null;
    }
    if (body.recurringDay !== undefined) data.recurringDay = body.recurringDay ? parseInt(body.recurringDay as string) : null;
    if (body.installmentNumber !== undefined) data.installmentNumber = body.installmentNumber ? parseInt(body.installmentNumber as string) : null;
    if (body.installmentTotal !== undefined) data.installmentTotal = body.installmentTotal ? parseInt(body.installmentTotal as string) : null;
    if (body.contractId !== undefined) data.contractId = body.contractId || null;
    if (body.propertyId !== undefined) data.propertyId = body.propertyId || null;

    const entry = await prisma.ownerEntry.update({
      where: { id },
      data,
      include: { owner: true },
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
    // Captura snapshot antes de deletar pra log de auditoria — permite
    // recriar manualmente se exclusao foi por engano.
    const snapshot = await prisma.ownerEntry.findUnique({ where: { id } });
    if (!snapshot) {
      return NextResponse.json({ error: "Lançamento não encontrado" }, { status: 404 });
    }
    await prisma.ownerEntry.delete({ where: { id } });
    await logAudit({
      userId: auth.user.id,
      action: "DELETE",
      entity: "OwnerEntry",
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
