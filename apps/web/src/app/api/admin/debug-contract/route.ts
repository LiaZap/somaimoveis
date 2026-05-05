import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";
import { isAdmin } from "@/lib/rbac";

/**
 * GET /api/admin/debug-contract?code=CTR-19
 *
 * Dump rapido do estado de um contrato:
 *  - Dados do contrato + locatario + proprietario
 *  - Lancamentos PENDENTES do locatario
 *  - Lancamentos PENDENTES do proprietario (ligados a esse contrato)
 *
 * Util pra entender de onde vem duplicatas.
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
  const code = searchParams.get("code");
  if (!code) {
    return NextResponse.json(
      { error: "Parametro ?code=CTR-XX obrigatorio" },
      { status: 400 },
    );
  }

  const contract = await prisma.contract.findFirst({
    where: { code },
    include: {
      tenant: { select: { id: true, name: true, cpfCnpj: true } },
      owner: { select: { id: true, name: true, cpfCnpj: true } },
      property: { select: { id: true, title: true } },
    },
  });

  if (!contract) {
    return NextResponse.json({ error: `Contrato ${code} nao encontrado` }, { status: 404 });
  }

  // Lancamentos do locatario PENDENTES
  const tenantEntries = contract.tenantId
    ? await prisma.tenantEntry.findMany({
        where: {
          tenantId: contract.tenantId,
          status: "PENDENTE",
        },
        select: {
          id: true,
          type: true,
          category: true,
          description: true,
          value: true,
          dueDate: true,
          installmentNumber: true,
          installmentTotal: true,
          parentEntryId: true,
          destination: true,
          contractId: true,
        },
        orderBy: { dueDate: "asc" },
      })
    : [];

  // Lancamentos do proprietario PENDENTES — busca por contractId OU
  // descricao contendo o codigo do contrato (entries com contractId null
  // podem aparecer no /repasses mas nao no filtro por contractId direto)
  const ownerEntries = await prisma.ownerEntry.findMany({
    where: {
      status: "PENDENTE",
      OR: [
        { contractId: contract.id },
        { description: { contains: contract.code } },
      ],
    },
    select: {
      id: true,
      ownerId: true,
      contractId: true,
      owner: { select: { name: true } },
      type: true,
      category: true,
      description: true,
      value: true,
      dueDate: true,
      notes: true,
      createdAt: true,
    },
    orderBy: { description: "asc" },
  });

  // Helper: extrai tenantEntryId do notes
  const enrichedOwnerEntries = ownerEntries.map((e) => {
    let tenantEntryId: string | null = null;
    let sharePercent: number | null = null;
    if (e.notes) {
      try {
        const p = JSON.parse(e.notes);
        if (typeof p.tenantEntryId === "string") tenantEntryId = p.tenantEntryId;
        if (typeof p.sharePercent === "number") sharePercent = p.sharePercent;
      } catch {}
    }
    return {
      id: e.id,
      ownerId: e.ownerId,
      ownerName: e.owner?.name,
      contractId: e.contractId,
      contractIdMatchesContract: e.contractId === contract.id,
      type: e.type,
      category: e.category,
      description: e.description,
      value: e.value,
      dueDate: e.dueDate,
      createdAt: e.createdAt,
      sharePercent,
      tenantEntryId,
      tenantEntryExists: tenantEntryId
        ? tenantEntries.some((t) => t.id === tenantEntryId)
        : null,
    };
  });

  return NextResponse.json({
    contract: {
      id: contract.id,
      code: contract.code,
      status: contract.status,
      rentalValue: contract.rentalValue,
      paymentDay: contract.paymentDay,
      startDate: contract.startDate,
      endDate: contract.endDate,
      lastAdjustmentDate: (contract as any).lastAdjustmentDate,
      lastAdjustmentPercent: (contract as any).lastAdjustmentPercent,
      adjustmentMonth: (contract as any).adjustmentMonth,
      tenant: contract.tenant,
      owner: contract.owner,
      property: contract.property,
    },
    tenantEntries: {
      count: tenantEntries.length,
      entries: tenantEntries,
    },
    ownerEntries: {
      count: ownerEntries.length,
      entries: enrichedOwnerEntries,
    },
  });
}
