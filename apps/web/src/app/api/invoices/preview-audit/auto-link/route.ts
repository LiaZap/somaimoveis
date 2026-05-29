/**
 * POST /api/invoices/preview-audit/auto-link
 * Body: { month: "YYYY-MM" }
 *
 * Tenta vincular AUTOMATICAMENTE contratos em entries que estao sem
 * contractId, usando heuristicas seguras (em ordem de confianca):
 *
 *   1. Codigo de contrato no description ("CTR-201", "CTR-105", etc)
 *      -> match exato com contract.code
 *   2. entry.propertyId direto -> contract ATIVO com mesma property
 *   3. Owner com 1 unico contrato ATIVO -> vincula
 *   4. Match por valor proximo: REPASSE.value bate com
 *      contract.rentalValue * (1 - adminFeePercent/100) +- 1%
 *
 * Retorna relatorio com:
 *   - vinculados (por owner+contrato + heuristica usada)
 *   - ambiguos (multiplos candidatos com mesma confianca)
 *   - puladas (sem nenhuma fonte para inferir)
 *
 * NAO toca em entries que ja tem contractId.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePagePermission, isAuthError } from "@/lib/api-auth";

interface LinkResult {
  entryId: string;
  ownerName: string;
  contractCode?: string;
  contractId?: string;
  heuristic?: string;
  reason?: string;
  candidates?: Array<{ id: string; code: string }>;
}

export async function POST(request: NextRequest) {
  const auth = await requirePagePermission("notas_fiscais");
  if (isAuthError(auth)) return auth;

  const body = await request.json().catch(() => ({}));
  const month: string | undefined = body.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "month invalido (YYYY-MM)" }, { status: 400 });
  }

  const [y, m] = month.split("-").map(Number);
  const inicio = new Date(y, m - 1, 1);
  const fim = new Date(y, m, 1);

  // Carrega entries SEM contractId do mes
  const entries = await prisma.ownerEntry.findMany({
    where: {
      type: "CREDITO",
      category: { in: ["REPASSE", "INTERMEDIACAO"] },
      contractId: null,
      dueDate: { gte: inicio, lt: fim },
      status: { not: "CANCELADO" },
    },
    select: {
      id: true, description: true, value: true, ownerId: true,
      propertyId: true,
      owner: { select: { name: true } },
    },
  });

  if (entries.length === 0) {
    return NextResponse.json({
      vinculados: [],
      ambiguos: [],
      pulados: [],
      summary: { total: 0, vinculados: 0, ambiguos: 0, pulados: 0 },
    });
  }

  // Carrega TODOS os contratos ATIVOS dos owners afetados (pra heuristicas).
  // Inclui property pra heuristica de 'mesmo endereco' decidir empates.
  const ownerIds = [...new Set(entries.map((e) => e.ownerId))];
  const contracts = await prisma.contract.findMany({
    where: {
      ownerId: { in: ownerIds },
      status: { in: ["ATIVO", "PENDENTE_RENOVACAO"] },
    },
    select: {
      id: true, code: true, ownerId: true, propertyId: true,
      rentalValue: true, adminFeePercent: true, createdAt: true,
      property: { select: { id: true, street: true, number: true, zipCode: true } },
    },
    orderBy: { createdAt: "desc" }, // mais recente primeiro
  });
  const contractsByOwner = new Map<string, typeof contracts>();
  const contractsByCode = new Map<string, (typeof contracts)[number]>();
  for (const c of contracts) {
    const arr = contractsByOwner.get(c.ownerId) || [];
    arr.push(c);
    contractsByOwner.set(c.ownerId, arr);
    contractsByCode.set(c.code.toUpperCase(), c);
  }

  const vinculados: LinkResult[] = [];
  const ambiguos: LinkResult[] = [];
  const pulados: LinkResult[] = [];

  // Regex pra extrair codigo CTR-N do description
  const CONTRACT_CODE_REGEX = /\b(CTR[-\s]?\d+)\b/i;

  for (const entry of entries) {
    const ownerContracts = contractsByOwner.get(entry.ownerId) || [];
    const ownerName = entry.owner?.name || "(sem nome)";

    if (ownerContracts.length === 0) {
      pulados.push({
        entryId: entry.id,
        ownerName,
        reason: "Proprietario nao tem contratos ATIVOS",
      });
      continue;
    }

    let chosen: (typeof contracts)[number] | null = null;
    let heuristic: string | null = null;
    let candidates: typeof contracts = [];

    // Heuristica 1: codigo no description
    if (entry.description) {
      const match = entry.description.match(CONTRACT_CODE_REGEX);
      if (match) {
        const codeNorm = match[1].toUpperCase().replace(/\s/g, "-");
        const found = contractsByCode.get(codeNorm)
          || contractsByCode.get(match[1].toUpperCase().replace("-", ""));
        if (found && found.ownerId === entry.ownerId) {
          chosen = found;
          heuristic = "DESCRIPTION_CODE";
        }
      }
    }

    // Heuristica 2: entry.propertyId direto
    if (!chosen && entry.propertyId) {
      const matchProp = ownerContracts.filter((c) => c.propertyId === entry.propertyId);
      if (matchProp.length === 1) {
        chosen = matchProp[0];
        heuristic = "ENTRY_PROPERTY_ID";
      } else if (matchProp.length > 1) {
        candidates = matchProp;
      }
    }

    // Heuristica 3: owner com unico contrato ATIVO
    if (!chosen && ownerContracts.length === 1) {
      chosen = ownerContracts[0];
      heuristic = "OWNER_UNIQUE_CONTRACT";
    }

    // Heuristica 4: match por valor proximo (REPASSE.value ~= rentalValue * (1 - adminFeePercent/100))
    if (!chosen && entry.value > 0) {
      const matches = ownerContracts
        .map((c) => {
          const pct = (c.adminFeePercent || 10) / 100;
          const expectedNet = (c.rentalValue || 0) * (1 - pct);
          const diff = Math.abs(entry.value - expectedNet);
          const pctDiff = expectedNet > 0 ? diff / expectedNet : 1;
          return { c, pctDiff };
        })
        .filter((x) => x.pctDiff <= 0.05) // tolerancia 5% (era 2%)
        .sort((a, b) => a.pctDiff - b.pctDiff);
      if (matches.length === 1) {
        chosen = matches[0].c;
        heuristic = "RENTAL_VALUE_MATCH";
      } else if (matches.length > 1 && matches[0].pctDiff < matches[1].pctDiff * 0.5) {
        // Vencedor claro (1o eh pelo menos 50% melhor que o 2o)
        chosen = matches[0].c;
        heuristic = "RENTAL_VALUE_MATCH_BEST";
      } else if (matches.length > 1) {
        candidates = matches.map((x) => x.c);
      }
    }

    // Heuristica 5: TODOS os contratos do owner compartilham o MESMO ENDERECO
    // (street+number+zip). Quando ambiguidade vem de contratos no mesmo
    // imovel (ex: contratos sucessivos com inquilinos diferentes), o
    // ibsCbs.property vai ser identico. Vincula no mais recente (1o da
    // lista, ordenada desc por createdAt).
    if (!chosen && ownerContracts.length > 1) {
      const ref = ownerContracts[0].property;
      const allSameAddress = ref && ownerContracts.every((c) =>
        c.property &&
        c.property.street === ref.street &&
        c.property.number === ref.number &&
        c.property.zipCode === ref.zipCode
      );
      if (allSameAddress) {
        chosen = ownerContracts[0]; // mais recente
        heuristic = "ALL_SAME_PROPERTY_NEWEST";
        candidates = []; // limpa
      }
    }

    if (chosen && heuristic) {
      // Aplica
      try {
        await prisma.ownerEntry.update({
          where: { id: entry.id },
          data: { contractId: chosen.id, propertyId: chosen.propertyId || entry.propertyId },
        });
        vinculados.push({
          entryId: entry.id,
          ownerName,
          contractCode: chosen.code,
          contractId: chosen.id,
          heuristic,
        });
      } catch (err) {
        pulados.push({
          entryId: entry.id,
          ownerName,
          reason: `Erro ao salvar: ${err instanceof Error ? err.message : "?"}`,
        });
      }
    } else if (candidates.length > 0) {
      ambiguos.push({
        entryId: entry.id,
        ownerName,
        candidates: candidates.map((c) => ({ id: c.id, code: c.code })),
        reason: `Multiplos candidatos (${candidates.length}) — vincule manualmente`,
      });
    } else {
      pulados.push({
        entryId: entry.id,
        ownerName,
        reason: "Nenhuma heuristica retornou candidato confiavel",
      });
    }
  }

  return NextResponse.json({
    vinculados,
    ambiguos,
    pulados,
    summary: {
      total: entries.length,
      vinculados: vinculados.length,
      ambiguos: ambiguos.length,
      pulados: pulados.length,
    },
  });
}
