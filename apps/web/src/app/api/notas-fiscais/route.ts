import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";

/**
 * GET /api/notas-fiscais?month=YYYY-MM
 * Lista as notas fiscais a emitir no mes (taxa de administracao de cada contrato).
 * Cada contrato ativo gera uma NF da taxa de administracao.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
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
    const mLabel = `${String(targetMonth + 1).padStart(2, "0")}/${targetYear}`;

    // Buscar entries REPASSE/GARANTIA do mes com notes (que tem adminFee)
    const entries = await prisma.ownerEntry.findMany({
      where: {
        type: "CREDITO",
        category: { in: ["REPASSE", "GARANTIA"] },
        dueDate: { gte: monthStart, lte: monthEnd },
        status: { not: "CANCELADO" },
      },
      include: {
        owner: { select: { id: true, name: true, cpfCnpj: true } },
      },
      orderBy: [{ owner: { name: "asc" } }, { createdAt: "asc" }],
    });

    // Buscar contratos relacionados
    const contractIds = entries
      .map((e) => e.contractId)
      .filter((id): id is string => !!id);
    const contracts = contractIds.length > 0
      ? await prisma.contract.findMany({
          where: { id: { in: contractIds } },
          select: { id: true, code: true, rentalValue: true, adminFeePercent: true },
        })
      : [];
    const contractMap = new Map(contracts.map((c) => [c.id, c]));

    // Buscar Payments do mes para capturar descontos do locatario
    const payments = contractIds.length > 0
      ? await prisma.payment.findMany({
          where: {
            contractId: { in: contractIds },
            dueDate: { gte: monthStart, lte: monthEnd },
          },
          select: { id: true, contractId: true, notes: true },
        })
      : [];
    // Mapa: contractId -> total de descontos/creditos do locatario nesse mes
    const descontoByContract = new Map<string, number>();
    for (const p of payments) {
      if (!p.contractId || !p.notes) continue;
      try {
        const n = JSON.parse(p.notes);
        if (Array.isArray(n.lancamentos)) {
          for (const l of n.lancamentos as Array<{ tipo?: string; valor?: number }>) {
            if (l.tipo === "CREDITO" && typeof l.valor === "number" && l.valor > 0) {
              descontoByContract.set(
                p.contractId,
                (descontoByContract.get(p.contractId) || 0) + l.valor
              );
            }
          }
        }
      } catch {
        // notes nao eh JSON
      }
    }

    // Buscar status de NF emitida do AppSetting
    const nfKey = `nf_emitidas_${targetYear}_${String(targetMonth + 1).padStart(2, "0")}`;
    const nfSetting = await prisma.appSetting.findUnique({ where: { key: nfKey } });
    const nfEmitidas: Record<string, { emitida: boolean; numero?: string; data?: string }> =
      nfSetting ? JSON.parse(nfSetting.value) : {};

    // Buscar Invoices ja persistidas (vinculadas via ownerEntryId) — fornece
    // invoiceId/status real do banco pra UI chamar cancel/download.
    const ownerEntryIds = entries.map((e) => e.id);
    const invoices = ownerEntryIds.length > 0
      ? await prisma.invoice.findMany({
          where: { ownerEntryId: { in: ownerEntryIds } },
          select: {
            id: true,
            ownerEntryId: true,
            status: true,
            numero: true,
            chaveAcesso: true,
            pdfUrl: true,
            dataEmissao: true,
          },
        })
      : [];
    const invoiceByEntry = new Map(
      invoices.filter((i) => i.ownerEntryId).map((i) => [i.ownerEntryId as string, i])
    );

    const notas = entries.map((entry) => {
      const contract = entry.contractId ? contractMap.get(entry.contractId) || null : null;
      let adminFeePercent = contract?.adminFeePercent || 10;
      let aluguelBrutoTotal = 0;       // aluguel bruto TOTAL do contrato
      let adminFeeValueTotal = 0;       // taxa adm TOTAL do contrato
      let sharePercent = 100;           // porcentagem deste proprietario (100 se sozinho)

      if (entry.notes) {
        try {
          const n = JSON.parse(entry.notes);
          if (n.adminFeePercent) adminFeePercent = n.adminFeePercent;
          if (n.adminFeeValue) adminFeeValueTotal = n.adminFeeValue;
          if (n.aluguelBruto) aluguelBrutoTotal = n.aluguelBruto;
          if (typeof n.sharePercent === "number" && n.sharePercent > 0) {
            sharePercent = n.sharePercent;
          }
        } catch {}
      }

      // Se nao tem valores nos notes, calcular a partir do contrato
      if (!aluguelBrutoTotal && contract) {
        aluguelBrutoTotal = contract.rentalValue;
      }
      if (!adminFeeValueTotal && aluguelBrutoTotal) {
        adminFeeValueTotal = Math.round(aluguelBrutoTotal * (adminFeePercent / 100) * 100) / 100;
      }

      // Aplicar desconto do locatario sobre a base (aluguel liquido efetivo)
      const descontoTotal = entry.contractId
        ? descontoByContract.get(entry.contractId) || 0
        : 0;
      const aluguelLiquidoTotal = Math.max(0, aluguelBrutoTotal - descontoTotal);

      // Recalcular taxa adm sobre o aluguel liquido (com desconto aplicado)
      // Isso segue o padrao Via Imob: taxa sobre valor efetivamente cobrado do locatario
      const adminFeeEfetivoTotal = Math.round(
        aluguelLiquidoTotal * (adminFeePercent / 100) * 100
      ) / 100;

      // Aplicar sharePercent (% deste proprietario no imovel)
      const share = sharePercent / 100;
      const aluguelBruto = Math.round(aluguelLiquidoTotal * share * 100) / 100;
      const adminFeeValue = Math.round(adminFeeEfetivoTotal * share * 100) / 100;

      const nfStatus = nfEmitidas[entry.id] || { emitida: false };
      const inv = invoiceByEntry.get(entry.id);
      // Considera emitida se: marcada no AppSetting OU tem Invoice AUTORIZADA no banco
      const realmenteEmitida = nfStatus.emitida || inv?.status === "AUTORIZADA";

      return {
        entryId: entry.id,
        owner: entry.owner,
        contract,
        aluguelBruto,              // aluguel liquido (com desconto) x % do proprietario
        aluguelBrutoOriginal: Math.round(aluguelBrutoTotal * 100) / 100,
        descontoAplicado: Math.round(descontoTotal * 100) / 100,
        sharePercent,
        adminFeePercent,
        adminFeeValue,             // taxa sobre aluguel liquido x % do proprietario
        repasseValue: entry.value,
        nfEmitida: realmenteEmitida,
        nfNumero: nfStatus.numero || inv?.numero || "",
        nfData: nfStatus.data || (inv?.dataEmissao ? inv.dataEmissao.toISOString() : ""),
        // Novos campos pra UI chamar cancel/download
        invoiceId: inv?.id || null,
        invoiceStatus: inv?.status || null,
        invoicePdfUrl: inv?.pdfUrl || null,
      };
    });

    const totalAdminFee = notas.reduce((s, n) => s + n.adminFeeValue, 0);
    const totalEmitidas = notas.filter((n) => n.nfEmitida).length;

    return NextResponse.json({
      month: mLabel,
      total: notas.length,
      emitidas: totalEmitidas,
      pendentes: notas.length - totalEmitidas,
      totalAdminFee: Math.round(totalAdminFee * 100) / 100,
      notas,
    });
  } catch (error) {
    console.error("[Notas Fiscais GET]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/notas-fiscais
 * Marca NFs como emitidas ou pendentes.
 * Body: { month: "YYYY-MM", entryIds: string[], emitida: boolean, numero?: string }
 */
export async function PATCH(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  try {
    const body = await request.json();
    const { month, entryIds, emitida, numero } = body;

    if (!month || !Array.isArray(entryIds) || entryIds.length === 0) {
      return NextResponse.json({ error: "month e entryIds obrigatorios" }, { status: 400 });
    }

    const [y, m] = month.split("-").map(Number);
    const nfKey = `nf_emitidas_${y}_${String(m).padStart(2, "0")}`;

    const existing = await prisma.appSetting.findUnique({ where: { key: nfKey } });
    const nfEmitidas: Record<string, { emitida: boolean; numero?: string; data?: string }> =
      existing ? JSON.parse(existing.value) : {};

    const now = new Date().toISOString().split("T")[0];
    for (const id of entryIds) {
      nfEmitidas[id] = {
        emitida: emitida !== false,
        numero: numero || nfEmitidas[id]?.numero || "",
        data: emitida !== false ? now : "",
      };
    }

    await prisma.appSetting.upsert({
      where: { key: nfKey },
      update: { value: JSON.stringify(nfEmitidas) },
      create: { key: nfKey, value: JSON.stringify(nfEmitidas) },
    });

    return NextResponse.json({
      updated: entryIds.length,
      message: `${entryIds.length} NF(s) ${emitida !== false ? "marcada(s) como emitida(s)" : "revertida(s) para pendente"}`,
    });
  } catch (error) {
    console.error("[Notas Fiscais PATCH]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro" },
      { status: 500 }
    );
  }
}
