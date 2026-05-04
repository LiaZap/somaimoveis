import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";
import { isAdmin } from "@/lib/rbac";

/**
 * GET /api/admin/restore-missing-owner-entries
 *
 * Para cada TenantEntry com destination=PROPRIETARIO que NAO tem
 * OwnerEntry correspondente (linkado pelo tenantEntryId no notes),
 * recria os OwnerEntries que estavam faltando — respeitando os
 * shares do PropertyOwner.
 *
 * NAO mexe em Payments — so recria os creditos no proprietario.
 *
 * Default: dry-run (so reporta).
 * Use ?delete=true para executar.
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
  const doRun = searchParams.get("execute") === "true";

  // 1) Pega todos os tenant entries com destination=PROPRIETARIO PENDENTES
  const tenantEntries = await prisma.tenantEntry.findMany({
    where: {
      destination: "PROPRIETARIO",
      status: "PENDENTE",
    },
    select: {
      id: true,
      tenantId: true,
      tenant: { select: { name: true } },
      type: true,
      category: true,
      description: true,
      value: true,
      dueDate: true,
      installmentNumber: true,
      installmentTotal: true,
      contractId: true,
    },
  });

  // 2) Pega todos os owner entries que linkam a tenant entries
  const allOwnerEntries = await prisma.ownerEntry.findMany({
    where: {
      status: "PENDENTE",
      notes: { contains: "tenantEntryId" },
    },
    select: { notes: true },
  });
  const linkedTenantEntryIds = new Set<string>();
  for (const oe of allOwnerEntries) {
    if (!oe.notes) continue;
    try {
      const parsed = JSON.parse(oe.notes);
      if (typeof parsed.tenantEntryId === "string") {
        linkedTenantEntryIds.add(parsed.tenantEntryId);
      }
    } catch {}
  }

  // 3) Identifica missing
  const missing = tenantEntries.filter((te) => !linkedTenantEntryIds.has(te.id));

  if (missing.length === 0) {
    return NextResponse.json({
      message: "Nenhum lancamento faltando.",
      restored: 0,
    });
  }

  // 4) Para cada missing, encontra o contrato + property + owners
  // Cache de contracts por tenantId
  const tenantContractMap = new Map<string, {
    contractId: string;
    propertyId: string | null;
    ownerId: string;
    contractCode: string;
  }>();

  // Busca contratos ATIVO/PENDENTE_RENOVACAO de cada tenant
  const tenantIds = Array.from(new Set(missing.map((m) => m.tenantId)));
  const contracts = await prisma.contract.findMany({
    where: {
      tenantId: { in: tenantIds },
      status: { in: ["ATIVO", "PENDENTE_RENOVACAO"] },
    },
    select: {
      id: true,
      code: true,
      propertyId: true,
      ownerId: true,
      tenantId: true,
    },
  });
  for (const c of contracts) {
    if (c.tenantId) {
      tenantContractMap.set(c.tenantId, {
        contractId: c.id,
        propertyId: c.propertyId,
        ownerId: c.ownerId,
        contractCode: c.code,
      });
    }
  }

  // Cache de PropertyOwner shares
  const propertyOwnerSharesMap = new Map<string, Array<{ ownerId: string; percentage: number }>>();
  const propertyIds = Array.from(
    new Set(
      Array.from(tenantContractMap.values())
        .map((c) => c.propertyId)
        .filter((id): id is string => !!id),
    ),
  );
  if (propertyIds.length > 0) {
    const shares = await prisma.propertyOwner.findMany({
      where: { propertyId: { in: propertyIds } },
      select: { propertyId: true, ownerId: true, percentage: true },
    });
    for (const s of shares) {
      if (!propertyOwnerSharesMap.has(s.propertyId)) {
        propertyOwnerSharesMap.set(s.propertyId, []);
      }
      propertyOwnerSharesMap.get(s.propertyId)!.push({
        ownerId: s.ownerId,
        percentage: s.percentage,
      });
    }
  }

  // 5) Para cada missing, planeja os owner entries a criar
  const plannedEntries: Array<{
    tenantEntryId: string;
    tenantName: string;
    description: string;
    contractCode: string;
    targets: Array<{ ownerId: string; sharePercent: number; portion: number }>;
    dueDate: Date | null;
    category: string;
    type: "CREDITO" | "DEBITO";
    value: number;
  }> = [];

  for (const te of missing) {
    const contract = tenantContractMap.get(te.tenantId);
    if (!contract) continue; // sem contrato vigente, pula

    const shares = contract.propertyId
      ? propertyOwnerSharesMap.get(contract.propertyId) || []
      : [];

    const totalSharePercent = shares.reduce((s, sh) => s + sh.percentage, 0);
    const contractOwnerInShares = shares.some((s) => s.ownerId === contract.ownerId);

    // Tipo: CREDITO se DEBITO no tenant (locatario paga, proprietario recebe)
    //       DEBITO se CREDITO no tenant (locatario tem desconto, proprietario absorve)
    const ownerType: "CREDITO" | "DEBITO" = te.type === "DEBITO" ? "CREDITO" : "DEBITO";

    // Categoria: mantem (IPTU, CONDOMINIO, etc)
    const ownerCategory = te.category;

    // Descricao com mes da dueDate (sem refMonth — eh recovery)
    const dueDate = te.dueDate ? new Date(te.dueDate) : null;
    const mLabel = dueDate
      ? `${String(dueDate.getMonth() + 1).padStart(2, "0")}/${dueDate.getFullYear()}`
      : "";
    const installmentLabel = te.installmentNumber && te.installmentTotal
      ? ` ${te.installmentNumber}/${te.installmentTotal}`
      : "";

    const targets: Array<{ ownerId: string; sharePercent: number; portion: number }> = [];

    if (shares.length > 0) {
      for (const share of shares) {
        const portion = Math.round(te.value * (share.percentage / 100) * 100) / 100;
        targets.push({
          ownerId: share.ownerId,
          sharePercent: share.percentage,
          portion,
        });
      }
      // Adiciona o restante pro proprietario do contrato se shares somam < 100
      if (totalSharePercent < 100 && !contractOwnerInShares) {
        const remainPct = Math.round((100 - totalSharePercent) * 100) / 100;
        const remainVal = Math.round(te.value * (remainPct / 100) * 100) / 100;
        targets.push({
          ownerId: contract.ownerId,
          sharePercent: remainPct,
          portion: remainVal,
        });
      }
    } else {
      // Sem shares — proprietario unico recebe 100%
      targets.push({
        ownerId: contract.ownerId,
        sharePercent: 100,
        portion: te.value,
      });
    }

    plannedEntries.push({
      tenantEntryId: te.id,
      tenantName: te.tenant?.name || "?",
      description: `${ownerCategory}${installmentLabel} ${mLabel} - ${contract.contractCode}`,
      contractCode: contract.contractCode,
      targets,
      dueDate,
      category: ownerCategory,
      type: ownerType,
      value: te.value,
    });
  }

  if (!doRun) {
    // Conta total de entries que serao criadas
    let totalToCreate = 0;
    for (const p of plannedEntries) totalToCreate += p.targets.length;
    return NextResponse.json({
      mode: "DRY_RUN",
      message: `${missing.length} tenant entries faltando, vai recriar ${totalToCreate} owner entries (multiplos por share). Use ?execute=true para rodar.`,
      tenantEntriesMissing: missing.length,
      ownerEntriesToCreate: totalToCreate,
      preview: plannedEntries.slice(0, 20).map((p) => ({
        tenantEntryId: p.tenantEntryId,
        tenant: p.tenantName,
        description: p.description,
        type: p.type,
        category: p.category,
        value: p.value,
        dueDate: p.dueDate,
        contractCode: p.contractCode,
        targets: p.targets,
      })),
    });
  }

  // Executa a criacao
  let created = 0;
  for (const p of plannedEntries) {
    if (!p.dueDate) continue; // pula sem dueDate
    const tenantContract = tenantContractMap.get(
      missing.find((m) => m.id === p.tenantEntryId)?.tenantId || "",
    );
    if (!tenantContract) continue;

    for (const target of p.targets) {
      const desc = p.targets.length > 1
        ? `${p.description} (${target.sharePercent}%)`
        : p.description;
      try {
        await prisma.ownerEntry.create({
          data: {
            type: p.type,
            category: p.category,
            description: desc,
            value: target.portion,
            dueDate: p.dueDate,
            ownerId: target.ownerId,
            contractId: tenantContract.contractId,
            propertyId: tenantContract.propertyId,
            status: "PENDENTE",
            notes: JSON.stringify({
              tenantEntryId: p.tenantEntryId,
              originalDescription:
                missing.find((m) => m.id === p.tenantEntryId)?.description || "",
              destination: "PROPRIETARIO",
              sharePercent: target.sharePercent,
              restoredFromMissing: true,
            }),
          },
        });
        created++;
      } catch (err) {
        console.error("[Restore Missing] Erro ao criar:", err);
      }
    }
  }

  return NextResponse.json({
    mode: "EXECUTED",
    message: `Recriados ${created} owner entries.`,
    created,
    tenantEntriesProcessed: plannedEntries.length,
  });
}
