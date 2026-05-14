import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * POST /api/audit/criar-faltantes-mes-05
 *
 * Recebe lista de OwnerEntries a criar como PAGO para resolver gaps identificados
 * na auditoria de maio/2026 (planilha Repasses_vs_Inquilinos_Mes05.xlsx).
 *
 * Body: { entries: Array<{ ctr, ownerName, share, cat, type, value, desc, fonte }>, atualizar?: [...] }
 *
 * Comportamento:
 * - Resolve contractId pelo code (CTR-XXX)
 * - Resolve ownerId pelo nome (match case-insensitive trim)
 * - Cria OwnerEntry status=PAGO, paidAt=2026-05-10, dueDate=2026-05-10
 * - Adiciona notes JSON com auditTag="MES05_FALTANTES" e fonte
 * - Retorna relatório completo com sucessos e erros
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  const body = await request.json();
  const entries: Array<{
    ctr: string;
    owner: string;
    share: number;
    cat: string;
    type: "CREDITO" | "DEBITO";
    value: number;
    desc: string;
    fonte: string;
    grupo: string;
  }> = body.entries || [];

  const atualizar: Array<{
    ctr: string;
    owner: string;
    cat: string;
    valorAntigo: number;
    valorNovo: number;
  }> = body.atualizar || [];

  const dryRun = body.dryRun !== false; // default true para segurança

  const created: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const errors: Array<{ entry: Record<string, unknown>; error: string }> = [];
  const skipped: Array<{ entry: Record<string, unknown>; reason: string }> = [];

  // Pre-load all contracts and owners
  const allContracts = await prisma.contract.findMany({
    select: {
      id: true,
      code: true,
      tenantId: true,
      ownerId: true,
      propertyId: true,
      owner: { select: { id: true, name: true } },
      property: {
        select: {
          id: true,
          ownerShares: {
            select: {
              ownerId: true,
              percentage: true,
              owner: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  });
  const contractsByCode = new Map(allContracts.map((c) => [c.code, c]));

  const allOwners = await prisma.owner.findMany({ select: { id: true, name: true } });
  const ownersByName = new Map<string, string>();
  for (const o of allOwners) {
    ownersByName.set(o.name.toLowerCase().trim().replace(/\s+/g, " "), o.id);
  }

  const dueDate = new Date("2026-05-10T12:00:00Z");
  const paidAt = new Date("2026-05-10T12:00:00Z");

  for (const e of entries) {
    try {
      const contract = contractsByCode.get(e.ctr);
      if (!contract) {
        errors.push({ entry: e as unknown as Record<string, unknown>, error: `Contrato ${e.ctr} não encontrado` });
        continue;
      }

      // Resolver ownerId
      const ownerKey = (e.owner || "").toLowerCase().trim().replace(/\s+/g, " ");
      let ownerId = ownersByName.get(ownerKey);

      // Tentar match parcial se não encontrou
      if (!ownerId) {
        for (const [key, id] of ownersByName) {
          if (key.startsWith(ownerKey.substring(0, Math.min(15, ownerKey.length))) ||
              ownerKey.startsWith(key.substring(0, Math.min(15, key.length)))) {
            ownerId = id;
            break;
          }
        }
      }

      if (!ownerId) {
        errors.push({ entry: e as unknown as Record<string, unknown>, error: `Owner "${e.owner}" não encontrado` });
        continue;
      }

      // Verificar duplicação - se já existe OwnerEntry similar
      const existing = await prisma.ownerEntry.findFirst({
        where: {
          ownerId,
          contractId: contract.id,
          category: e.cat,
          type: e.type,
          value: e.value,
          dueDate: { gte: new Date("2026-05-01"), lt: new Date("2026-06-01") },
          status: { not: "CANCELADO" },
        },
      });

      if (existing) {
        skipped.push({
          entry: e as unknown as Record<string, unknown>,
          reason: `Já existe OwnerEntry similar: ${existing.id} status=${existing.status}`,
        });
        continue;
      }

      // Calcular valor proporcional se share != 100
      const valueFinal = e.value;

      const notes = JSON.stringify({
        auditTag: "MES05_FALTANTES_2026-05-14",
        fonte: e.fonte,
        grupo: e.grupo,
        ctr: e.ctr,
        sharePercent: e.share,
        backfilledAt: new Date().toISOString(),
      });

      const shareLabel = e.share === 100 ? "" : ` (${e.share}%)`;
      const description = `${e.desc} 05/2026 - ${e.ctr}${shareLabel}`;

      if (dryRun) {
        created.push({
          dryRun: true,
          ctr: e.ctr,
          owner: e.owner,
          ownerId,
          contractId: contract.id,
          propertyId: contract.propertyId,
          category: e.cat,
          type: e.type,
          value: valueFinal,
          description,
        });
      } else {
        const newEntry = await prisma.ownerEntry.create({
          data: {
            type: e.type,
            category: e.cat,
            description,
            value: valueFinal,
            ownerId,
            contractId: contract.id,
            propertyId: contract.propertyId,
            status: "PAGO",
            dueDate,
            paidAt,
            notes,
            createdById: auth.user.id,
          },
        });
        created.push({
          id: newEntry.id,
          ctr: e.ctr,
          owner: e.owner,
          category: e.cat,
          type: e.type,
          value: valueFinal,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push({ entry: e as unknown as Record<string, unknown>, error: errMsg });
    }
  }

  // ATUALIZAR entries (caso CTR-557 Heitor R$48.90 → R$137.26)
  for (const u of atualizar) {
    try {
      const contract = contractsByCode.get(u.ctr);
      if (!contract) {
        errors.push({ entry: u as unknown as Record<string, unknown>, error: `Contrato ${u.ctr} não encontrado` });
        continue;
      }

      const ownerKey = (u.owner || "").toLowerCase().trim().replace(/\s+/g, " ");
      const ownerId = ownersByName.get(ownerKey);
      if (!ownerId) {
        errors.push({ entry: u as unknown as Record<string, unknown>, error: `Owner não encontrado` });
        continue;
      }

      // Encontrar entry com valor antigo
      const target = await prisma.ownerEntry.findFirst({
        where: {
          ownerId,
          contractId: contract.id,
          category: u.cat,
          value: u.valorAntigo,
          dueDate: { gte: new Date("2026-04-01"), lt: new Date("2026-06-01") },
          status: { not: "CANCELADO" },
        },
        orderBy: { createdAt: "asc" },
      });

      if (!target) {
        errors.push({ entry: u as unknown as Record<string, unknown>, error: `Entry com valor R$${u.valorAntigo} não encontrada` });
        continue;
      }

      if (dryRun) {
        updated.push({ dryRun: true, id: target.id, ...u });
      } else {
        await prisma.ownerEntry.update({
          where: { id: target.id },
          data: {
            value: u.valorNovo,
            notes: JSON.stringify({
              ...(target.notes ? JSON.parse(target.notes) : {}),
              auditFixedAt: new Date().toISOString(),
              auditTag: "MES05_VALOR_CORRIGIDO",
              valorAntigo: u.valorAntigo,
            }),
          },
        });
        updated.push({ id: target.id, ...u });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push({ entry: u as unknown as Record<string, unknown>, error: errMsg });
    }
  }

  return NextResponse.json({
    dryRun,
    summary: {
      requestedCreate: entries.length,
      requestedUpdate: atualizar.length,
      created: created.length,
      updated: updated.length,
      skipped: skipped.length,
      errors: errors.length,
      totalCredito: entries
        .filter((e) => e.type === "CREDITO")
        .reduce((s, e) => s + e.value, 0),
      totalDebito: entries
        .filter((e) => e.type === "DEBITO")
        .reduce((s, e) => s + e.value, 0),
    },
    created,
    updated,
    skipped,
    errors,
  });
}
