import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * POST /api/repasses/propagate-discounts?month=YYYY-MM
 *
 * Propaga TenantEntries do mes com destination=PROPRIETARIO para o
 * proprietario correspondente, criando OwnerEntries.
 *
 * DEDUP ESTRITA: usa APENAS `notes.tenantEntryId` para evitar duplicar.
 * Se o billing/generate ja processou o TenantEntry, a OwnerEntry criada
 * tem `tenantEntryId` nos notes — entao NAO propaga.
 * Se nao tem, cria.
 *
 * Regra de tipo:
 * - TenantEntry DEBITO (cobranca extra do locatario) → OwnerEntry CREDITO (proprietario recebe)
 * - TenantEntry CREDITO (desconto dado ao locatario) → OwnerEntry DEBITO (proprietario banca)
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const monthStr = searchParams.get("month");

    let targetYear: number, targetMonth: number;
    if (monthStr && /^\d{4}-\d{2}$/.test(monthStr)) {
      const [y, m] = monthStr.split("-").map(Number);
      targetYear = y;
      targetMonth = m - 1;
    } else {
      const now = new Date();
      targetYear = now.getFullYear();
      targetMonth = now.getMonth();
    }

    const monthStart = new Date(targetYear, targetMonth, 1);
    const monthEnd = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59, 999);

    // 1. TenantEntries do mes com destination=PROPRIETARIO (nao cancelados)
    const tenantEntries = await prisma.tenantEntry.findMany({
      where: {
        destination: "PROPRIETARIO",
        dueDate: { gte: monthStart, lte: monthEnd },
        status: { not: "CANCELADO" },
      },
      select: {
        id: true,
        type: true,
        category: true,
        description: true,
        value: true,
        dueDate: true,
        tenantId: true,
        installmentNumber: true,
        installmentTotal: true,
      },
    });

    if (tenantEntries.length === 0) {
      return NextResponse.json({
        month: `${String(targetMonth + 1).padStart(2, "0")}/${targetYear}`,
        total: 0,
        propagados: 0,
        jaExistentes: 0,
        mensagem: "Nenhum lancamento do locatario com destino ao proprietario neste mes.",
      });
    }

    // 2. Buscar TODAS as OwnerEntries que tem tenantEntryId nas notes
    // (usando contains para filtrar no banco — evita carregar tudo)
    const tenantEntryIds = tenantEntries.map((t) => t.id);
    const existingOwnerEntries = await prisma.ownerEntry.findMany({
      where: {
        OR: tenantEntryIds.map((id) => ({
          notes: { contains: id },
        })),
      },
      select: { notes: true },
    });

    const alreadyPropagatedIds = new Set<string>();
    for (const oe of existingOwnerEntries) {
      if (!oe.notes) continue;
      try {
        const n = JSON.parse(oe.notes);
        if (n.tenantEntryId && typeof n.tenantEntryId === "string") {
          alreadyPropagatedIds.add(n.tenantEntryId);
        }
      } catch {
        // ignore
      }
    }

    // 3. Para cada TenantEntry nao propagado, criar a OwnerEntry
    let propagados = 0;
    let jaExistentes = 0;
    const detalhes: { desc: string; result: string }[] = [];

    for (const te of tenantEntries) {
      if (alreadyPropagatedIds.has(te.id)) {
        jaExistentes++;
        continue;
      }

      // Buscar contrato do locatario
      const contract = await prisma.contract.findFirst({
        where: {
          tenantId: te.tenantId,
          OR: [{ status: "ATIVO" }, { status: "PENDENTE_RENOVACAO" }],
        },
        orderBy: { startDate: "desc" },
        select: { id: true, code: true, ownerId: true, propertyId: true },
      });

      if (!contract) {
        detalhes.push({
          desc: te.description || te.category,
          result: "Locatario sem contrato ativo - ignorado",
        });
        continue;
      }

      const propertyShares = contract.propertyId
        ? await prisma.propertyOwner.findMany({
            where: { propertyId: contract.propertyId },
          })
        : [];

      const ownerType = te.type === "DEBITO" ? "CREDITO" : "DEBITO";
      const installmentLabel =
        te.installmentNumber && te.installmentTotal
          ? ` ${te.installmentNumber}/${te.installmentTotal}`
          : "";

      const d = te.dueDate || monthStart;
      const mRef = `${String(new Date(d).getMonth() + 1).padStart(2, "0")}/${new Date(d).getFullYear()}`;
      const baseDescription = `${te.description || te.category}${installmentLabel} ${mRef} - ${contract.code}`;

      const notesData = {
        tenantEntryId: te.id,
        originalDescription: te.description,
        destination: "PROPRIETARIO",
        type: te.type === "DEBITO" ? "cobranca_locatario" : "desconto_locatario",
        autoCreated: true,
        syncedFromTenant: true,
      };

      if (propertyShares.length > 0) {
        const totalPct = propertyShares.reduce((s, sh) => s + sh.percentage, 0);
        for (const share of propertyShares) {
          const portion = Math.round(te.value * (share.percentage / 100) * 100) / 100;
          await prisma.ownerEntry.create({
            data: {
              type: ownerType,
              category: te.category || (te.type === "DEBITO" ? "OUTROS" : "DESCONTO"),
              description: `${baseDescription} (${share.percentage}%)`,
              value: portion,
              dueDate: te.dueDate,
              status: "PENDENTE",
              ownerId: share.ownerId,
              contractId: contract.id,
              propertyId: contract.propertyId || null,
              notes: JSON.stringify(notesData),
            },
          });
        }
        const contractOwnerInShares = propertyShares.some(
          (s) => s.ownerId === contract.ownerId
        );
        if (totalPct < 100 && !contractOwnerInShares) {
          const remainPct = Math.round((100 - totalPct) * 100) / 100;
          const remainVal = Math.round(te.value * (remainPct / 100) * 100) / 100;
          await prisma.ownerEntry.create({
            data: {
              type: ownerType,
              category: te.category || (te.type === "DEBITO" ? "OUTROS" : "DESCONTO"),
              description: `${baseDescription} (${remainPct}%)`,
              value: remainVal,
              dueDate: te.dueDate,
              status: "PENDENTE",
              ownerId: contract.ownerId,
              contractId: contract.id,
              propertyId: contract.propertyId || null,
              notes: JSON.stringify(notesData),
            },
          });
        }
      } else {
        await prisma.ownerEntry.create({
          data: {
            type: ownerType,
            category: te.category || (te.type === "DEBITO" ? "OUTROS" : "DESCONTO"),
            description: baseDescription,
            value: te.value,
            dueDate: te.dueDate,
            status: "PENDENTE",
            ownerId: contract.ownerId,
            contractId: contract.id,
            propertyId: contract.propertyId || null,
            notes: JSON.stringify(notesData),
          },
        });
      }

      propagados++;
      const sinal = ownerType === "CREDITO" ? "+" : "-";
      detalhes.push({
        desc: te.description || te.category,
        result: `${ownerType}: ${sinal} R$ ${te.value.toFixed(2)} (${contract.code})`,
      });
    }

    return NextResponse.json({
      month: `${String(targetMonth + 1).padStart(2, "0")}/${targetYear}`,
      total: tenantEntries.length,
      propagados,
      jaExistentes,
      mensagem:
        propagados === 0
          ? `Nada para propagar. Todos os ${tenantEntries.length} lancamento(s) ja tem OwnerEntry correspondente.`
          : `${propagados} lancamento(s) propagado(s) para o proprietario${
              jaExistentes > 0 ? ` (${jaExistentes} ja existentes foram ignorados)` : ""
            }.`,
      detalhes,
    });
  } catch (error) {
    console.error("[Propagate Discounts]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro ao propagar descontos" },
      { status: 500 }
    );
  }
}
