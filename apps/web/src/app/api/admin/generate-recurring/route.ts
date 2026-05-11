import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * POST /api/admin/generate-recurring?month=YYYY-MM&dryRun=true
 *
 * Gera OwnerEntries e TenantEntries recorrentes para o mes alvo.
 * O sistema marca entries como `isRecurring=true` no cadastro mas
 * nao tinha mecanismo automatico que criasse a entry do mes
 * seguinte — o que fazia DARFs, taxas mensais e outras
 * cobrancas recorrentes deixarem de aparecer.
 *
 * Estrategia:
 *  1. Busca TODAS as OwnerEntries com isRecurring=true (cadastro mestre)
 *  2. Pra cada uma, calcula a dueDate no mes alvo (usando recurringDay)
 *  3. Verifica se ja existe entry similar (mesmo ownerId/categoria/value/desc)
 *     com dueDate dentro do mes alvo
 *  4. Se nao existe, cria nova OwnerEntry copiando os campos da original
 *  5. Mesma logica pra TenantEntries
 *
 * Idempotente. Aceita ?dryRun=true (default false).
 */

function normalizeDesc(desc: string): string {
  // Remove referencia de mes "MM/YYYY" e "1/N" da descricao pra comparar
  return desc
    .replace(/\b\d{2}\/\d{4}\b/g, "")
    .replace(/\b\d+\/\d+\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const dryRun = searchParams.get("dryRun") === "true";
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
    const monthEnd = new Date(targetYear, targetMonth + 1, 1);

    // --- OwnerEntries recorrentes ---
    const recurringOwners = await prisma.ownerEntry.findMany({
      where: {
        isRecurring: true,
        status: { not: "CANCELADO" },
      },
      orderBy: { createdAt: "asc" },
    });

    // Agrupa por chave logica pra evitar processar duplicatas (multiplas
    // entries recorrentes do mesmo perfil mas em meses diferentes)
    const ownerByKey: Record<string, typeof recurringOwners[number]> = {};
    for (const e of recurringOwners) {
      const key = `${e.ownerId}|${e.category}|${e.type}|${normalizeDesc(e.description)}|${e.value.toFixed(2)}`;
      // Mantem a MAIS antiga (a origem da recorrencia)
      const existing = ownerByKey[key];
      if (!existing || (e.createdAt && existing.createdAt && e.createdAt < existing.createdAt)) {
        ownerByKey[key] = e;
      }
    }

    const ownerCreatesPlanejados: Array<{
      sourceId: string;
      ownerId: string;
      desc: string;
      value: number;
      newDueDate: string;
      skipReason?: string;
    }> = [];

    for (const [key, source] of Object.entries(ownerByKey)) {
      const day = source.recurringDay || (source.dueDate ? source.dueDate.getDate() : 10);
      const newDueDate = new Date(targetYear, targetMonth, Math.min(day, 28));

      // Verifica se ja existe entry similar no mes alvo
      const existsInMonth = recurringOwners.find((e) => {
        if (e.ownerId !== source.ownerId) return false;
        if (e.category !== source.category) return false;
        if (e.type !== source.type) return false;
        if (Math.abs(e.value - source.value) > 0.01) return false;
        if (normalizeDesc(e.description) !== normalizeDesc(source.description)) return false;
        if (!e.dueDate) return false;
        return e.dueDate >= monthStart && e.dueDate < monthEnd;
      });

      if (existsInMonth) {
        ownerCreatesPlanejados.push({
          sourceId: source.id,
          ownerId: source.ownerId,
          desc: source.description,
          value: source.value,
          newDueDate: newDueDate.toISOString().slice(0, 10),
          skipReason: `Ja existe entry ${existsInMonth.id} no mes`,
        });
        continue;
      }

      ownerCreatesPlanejados.push({
        sourceId: source.id,
        ownerId: source.ownerId,
        desc: source.description,
        value: source.value,
        newDueDate: newDueDate.toISOString().slice(0, 10),
      });
    }

    // --- TenantEntries recorrentes ---
    const recurringTenants = await prisma.tenantEntry.findMany({
      where: {
        isRecurring: true,
        status: { not: "CANCELADO" },
      },
      orderBy: { createdAt: "asc" },
    });

    const tenantByKey: Record<string, typeof recurringTenants[number]> = {};
    for (const e of recurringTenants) {
      const key = `${e.tenantId}|${e.category}|${e.type}|${normalizeDesc(e.description)}|${e.value.toFixed(2)}`;
      const existing = tenantByKey[key];
      if (!existing || (e.createdAt && existing.createdAt && e.createdAt < existing.createdAt)) {
        tenantByKey[key] = e;
      }
    }

    const tenantCreatesPlanejados: Array<{
      sourceId: string;
      tenantId: string;
      desc: string;
      value: number;
      newDueDate: string;
      skipReason?: string;
    }> = [];

    for (const [key, source] of Object.entries(tenantByKey)) {
      const day = source.recurringDay || (source.dueDate ? source.dueDate.getDate() : 10);
      const newDueDate = new Date(targetYear, targetMonth, Math.min(day, 28));

      const existsInMonth = recurringTenants.find((e) => {
        if (e.tenantId !== source.tenantId) return false;
        if (e.category !== source.category) return false;
        if (e.type !== source.type) return false;
        if (Math.abs(e.value - source.value) > 0.01) return false;
        if (normalizeDesc(e.description) !== normalizeDesc(source.description)) return false;
        if (!e.dueDate) return false;
        return e.dueDate >= monthStart && e.dueDate < monthEnd;
      });

      if (existsInMonth) {
        tenantCreatesPlanejados.push({
          sourceId: source.id,
          tenantId: source.tenantId,
          desc: source.description,
          value: source.value,
          newDueDate: newDueDate.toISOString().slice(0, 10),
          skipReason: `Ja existe entry ${existsInMonth.id} no mes`,
        });
        continue;
      }

      tenantCreatesPlanejados.push({
        sourceId: source.id,
        tenantId: source.tenantId,
        desc: source.description,
        value: source.value,
        newDueDate: newDueDate.toISOString().slice(0, 10),
      });
    }

    // Aplica
    const criadosOwner: string[] = [];
    const criadosTenant: string[] = [];

    if (!dryRun) {
      // OwnerEntries
      for (const p of ownerCreatesPlanejados) {
        if (p.skipReason) continue;
        const source = ownerByKey[Object.keys(ownerByKey).find((k) => ownerByKey[k].id === p.sourceId)!];
        const newDueDate = new Date(p.newDueDate + "T12:00:00");
        const created = await prisma.ownerEntry.create({
          data: {
            type: source.type,
            category: source.category,
            description: source.description.replace(/\b\d{2}\/\d{4}\b/g, `${String(targetMonth + 1).padStart(2, "0")}/${targetYear}`),
            value: source.value,
            dueDate: newDueDate,
            ownerId: source.ownerId,
            contractId: source.contractId,
            propertyId: source.propertyId,
            status: "PENDENTE",
            notes: source.notes,
            isRecurring: true,
            recurringDay: source.recurringDay,
            destination: source.destination,
            createdById: source.createdById,
          },
        });
        criadosOwner.push(created.id);
      }

      // TenantEntries
      for (const p of tenantCreatesPlanejados) {
        if (p.skipReason) continue;
        const source = tenantByKey[Object.keys(tenantByKey).find((k) => tenantByKey[k].id === p.sourceId)!];
        const newDueDate = new Date(p.newDueDate + "T12:00:00");
        const created = await prisma.tenantEntry.create({
          data: {
            type: source.type,
            category: source.category,
            description: source.description.replace(/\b\d{2}\/\d{4}\b/g, `${String(targetMonth + 1).padStart(2, "0")}/${targetYear}`),
            value: source.value,
            dueDate: newDueDate,
            tenantId: source.tenantId,
            contractId: source.contractId,
            propertyId: source.propertyId,
            status: "PENDENTE",
            notes: source.notes,
            isRecurring: true,
            recurringDay: source.recurringDay,
            destination: source.destination,
            createdById: source.createdById,
          },
        });
        criadosTenant.push(created.id);
      }
    }

    return NextResponse.json({
      mode: dryRun ? "DRY_RUN" : "APPLIED",
      mesAlvo: `${String(targetMonth + 1).padStart(2, "0")}/${targetYear}`,
      owner: {
        totalRecorrentes: Object.keys(ownerByKey).length,
        planejados: ownerCreatesPlanejados.filter((p) => !p.skipReason),
        ignorados: ownerCreatesPlanejados.filter((p) => p.skipReason),
        criados: criadosOwner.length,
      },
      tenant: {
        totalRecorrentes: Object.keys(tenantByKey).length,
        planejados: tenantCreatesPlanejados.filter((p) => !p.skipReason),
        ignorados: tenantCreatesPlanejados.filter((p) => p.skipReason),
        criados: criadosTenant.length,
      },
    });
  } catch (error) {
    console.error("[generate-recurring] Erro:", error);
    return NextResponse.json(
      { error: "Erro", details: error instanceof Error ? error.message : "desconhecido" },
      { status: 500 }
    );
  }
}
