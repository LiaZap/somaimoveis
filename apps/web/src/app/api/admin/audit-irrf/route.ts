import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * GET  /api/admin/audit-irrf?dry=1  — lista pagamentos com IRRF aplicado errado
 * POST /api/admin/audit-irrf?apply=1 — zera o IRRF nesses pagamentos
 *
 * Regra fiscal: IRRF SO se aplica quando locador eh PF e locatario eh PJ.
 * Em qualquer outro caso (PJ owner, ou PF+PF) o IRRF deveria ser 0.
 *
 * Esse endpoint encontra Payments com irrfValue > 0 onde a regra nao
 * deveria aplicar e (em apply mode) zera os campos. Tambem atualiza o
 * notes das OwnerEntries REPASSE correspondentes pra remover o irrfValue
 * — assim o demonstrativo nao mostra mais a linha "IRRF Retido".
 */
export async function GET(request: NextRequest) {
  return audit(request, false);
}

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const apply = searchParams.get("apply") === "1";
  return audit(request, apply);
}

async function audit(request: NextRequest, apply: boolean) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  // Buscar todos os pagamentos com IRRF > 0
  const payments = await prisma.payment.findMany({
    where: { irrfValue: { gt: 0 } },
    select: {
      id: true,
      code: true,
      value: true,
      paidValue: true,
      irrfValue: true,
      irrfRate: true,
      paidAt: true,
      dueDate: true,
      contractId: true,
      contract: {
        select: {
          owner: {
            select: { id: true, name: true, cpfCnpj: true, personType: true },
          },
          tenant: {
            select: { id: true, name: true, cpfCnpj: true, personType: true },
          },
        },
      },
    },
  });

  // Lei 15.270/2025 — desde 01/01/2026 isencao IRRF aluguel ate R$ 5.000/mes
  const NEW_RULE_START = new Date("2026-01-01T00:00:00Z");
  const NEW_RULE_FLOOR = 5000;
  // Antes era R$ 2.259,20
  const OLD_RULE_FLOOR = 2259.2;

  /**
   * Detecta PF ou PJ. Primeiro pelo personType explicito; se nulo,
   * inferimos pela quantidade de digitos do CPF/CNPJ:
   *   - 11 digitos -> CPF -> PF
   *   - 14 digitos -> CNPJ -> PJ
   *   - outros -> assume PF (default seguro)
   */
  function detectPersonType(
    personType: string | null | undefined,
    cpfCnpj: string | null | undefined,
  ): { type: "PF" | "PJ"; source: "personType" | "doc-length" | "default" } {
    if (personType) {
      const t = personType.toUpperCase();
      if (t === "PF" || t === "PJ") return { type: t, source: "personType" };
    }
    const digits = (cpfCnpj || "").replace(/\D/g, "");
    if (digits.length === 14) return { type: "PJ", source: "doc-length" };
    if (digits.length === 11) return { type: "PF", source: "doc-length" };
    return { type: "PF", source: "default" };
  }

  type IncorrectItem = {
    paymentId: string;
    code: string;
    irrfValue: number;
    ownerName: string;
    ownerType: string;
    ownerDoc: string;
    ownerDetectionSource: string;
    tenantName: string;
    tenantType: string;
    tenantDoc: string;
    tenantDetectionSource: string;
    motivo: string;
    motivoCategoria: "OWNER_PJ" | "TENANT_PF" | "ABAIXO_PISO";
    paidAt: string | null;
    dueDate: string | null;
    valor: number;
  };

  const incorrect: IncorrectItem[] = [];

  for (const p of payments) {
    const ownerInfo = detectPersonType(
      p.contract?.owner?.personType,
      p.contract?.owner?.cpfCnpj,
    );
    const tenantInfo = detectPersonType(
      p.contract?.tenant?.personType,
      p.contract?.tenant?.cpfCnpj,
    );

    const ownerIsPF = ownerInfo.type === "PF";
    const tenantIsPJ = tenantInfo.type === "PJ";

    // 1. Regra basica: owner=PF E tenant=PJ
    let motivo = "";
    let motivoCategoria: IncorrectItem["motivoCategoria"] | null = null;

    if (!ownerIsPF) {
      motivo = "Locador eh PJ — sem retencao na fonte (PJ recebe valor cheio)";
      motivoCategoria = "OWNER_PJ";
    } else if (!tenantIsPJ) {
      motivo = "Locatario eh PF — sem retencao na fonte (PF nao retem aluguel)";
      motivoCategoria = "TENANT_PF";
    } else {
      // Owner PF + Tenant PJ — caso valido em principio. Mas verifica o piso:
      // 2. Lei 15.270/2025 — desde 01/01/2026 isencao ate R$ 5.000
      const refDate = p.dueDate || p.paidAt;
      const isNew = refDate ? refDate >= NEW_RULE_START : true;
      const piso = isNew ? NEW_RULE_FLOOR : OLD_RULE_FLOOR;
      const valor = p.paidValue ?? p.value ?? 0;

      if (valor <= piso) {
        motivo = `Aluguel ${formatBRL(valor)} <= piso ${formatBRL(piso)} (${
          isNew ? "Lei 15.270/2025 — isento ate R$ 5.000" : "isencao R$ 2.259,20"
        }) — IRRF nao deveria aplicar`;
        motivoCategoria = "ABAIXO_PISO";
      }
    }

    if (!motivoCategoria) continue; // este pagamento esta correto

    incorrect.push({
      paymentId: p.id,
      code: p.code,
      irrfValue: p.irrfValue ?? 0,
      ownerName: p.contract?.owner?.name || "?",
      ownerType: ownerInfo.type,
      ownerDoc: p.contract?.owner?.cpfCnpj || "",
      ownerDetectionSource: ownerInfo.source,
      tenantName: p.contract?.tenant?.name || "?",
      tenantType: tenantInfo.type,
      tenantDoc: p.contract?.tenant?.cpfCnpj || "",
      tenantDetectionSource: tenantInfo.source,
      motivo,
      motivoCategoria,
      paidAt: p.paidAt?.toISOString() || null,
      dueDate: p.dueDate?.toISOString() || null,
      valor: p.paidValue ?? p.value ?? 0,
    });
  }

  function formatBRL(v: number): string {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
  }

  const totalIrrfIncorreto = incorrect.reduce((s, x) => s + x.irrfValue, 0);

  if (!apply) {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const limited = isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 50;

    // Agrupar por proprietario pra facilitar conferencia
    const byOwner = new Map<string, { name: string; type: string; doc: string; count: number; total: number }>();
    for (const x of incorrect) {
      const key = x.ownerName + "|" + x.ownerType;
      if (!byOwner.has(key)) {
        byOwner.set(key, { name: x.ownerName, type: x.ownerType, doc: x.ownerDoc, count: 0, total: 0 });
      }
      const g = byOwner.get(key)!;
      g.count++;
      g.total += x.irrfValue;
    }
    const resumoPorOwner = Array.from(byOwner.values())
      .map((g) => ({ ...g, total: Math.round(g.total * 100) / 100 }))
      .sort((a, b) => b.total - a.total);

    // Estatisticas de tipo de erro
    const ownerEhPJ = incorrect.filter((x) => x.motivoCategoria === "OWNER_PJ").length;
    const tenantEhPF = incorrect.filter((x) => x.motivoCategoria === "TENANT_PF").length;
    const abaixoPiso = incorrect.filter((x) => x.motivoCategoria === "ABAIXO_PISO").length;
    const detectadoPorDoc = incorrect.filter(
      (x) => x.ownerDetectionSource === "doc-length" || x.tenantDetectionSource === "doc-length",
    ).length;

    return NextResponse.json({
      mode: "DRY_RUN",
      totalPagamentosComIrrf: payments.length,
      totalCorretos: payments.length - incorrect.length,
      totalIncorretos: incorrect.length,
      totalIrrfIncorreto: Math.round(totalIrrfIncorreto * 100) / 100,
      breakdown: {
        ownerEhPJ,                       // owner CNPJ — IRRF incabivel
        tenantEhPF_ownerPF: tenantEhPF,  // PF -> PF — IRRF incabivel
        abaixoPiso,                      // PF->PJ mas aluguel abaixo do piso (R$ 5.000 em 2026)
        detectadoPorDocumento: detectadoPorDoc, // detectado pela qty de digitos
      },
      resumoPorOwner,
      incorretos: incorrect.slice(0, limited),
      truncated: incorrect.length > limited,
      mensagem:
        incorrect.length === 0
          ? "Nenhum IRRF aplicado incorretamente — tudo ok."
          : `${incorrect.length} pagamentos com IRRF aplicado incorretamente. POST com ?apply=1 pra corrigir TODOS.`,
    });
  }

  // APPLY: zera IRRF e RECALCULA netToOwner sem o IRRF (caso contrario
  // o demonstrativo continuaria mostrando total errado)
  let updatedPayments = 0;
  for (const item of incorrect) {
    const p = payments.find((py) => py.id === item.paymentId);
    if (!p) continue;

    // splitOwnerValue ja eh o valor liquido apos taxa adm (sem IRRF na regra)
    // netToOwner = splitOwnerValue (sem mais descontar o IRRF que era zero)
    // Recalcula: pega o splitAdminValue e netToOwner direto do banco
    const paymentRecord = await prisma.payment.findUnique({
      where: { id: p.id },
      select: {
        paidValue: true,
        value: true,
        splitOwnerValue: true,
        splitAdminValue: true,
        netToOwner: true,
        irrfValue: true,
      },
    });
    if (!paymentRecord) continue;

    const oldIrrf = paymentRecord.irrfValue ?? 0;
    // Se o netToOwner atual = splitOwnerValue - irrf, precisamos restaurar
    // o irrf de volta no netToOwner
    const oldNet = paymentRecord.netToOwner ?? 0;
    const splitOwner = paymentRecord.splitOwnerValue ?? 0;
    // Novo netToOwner = splitOwnerValue (sem desconto de IRRF)
    const newNet = splitOwner > 0 ? splitOwner : oldNet + oldIrrf;

    await prisma.payment.update({
      where: { id: p.id },
      data: {
        irrfValue: 0,
        irrfRate: 0,
        netToOwner: Math.round(newNet * 100) / 100,
      },
    });
    updatedPayments++;
  }

  // Atualizar OwnerEntries REPASSE/GARANTIA correspondentes — limpa irrfValue do notes
  // Match por contractId + dueDate (mesmo mes do pagamento)
  let updatedEntries = 0;
  for (const item of incorrect) {
    const payment = payments.find((p) => p.id === item.paymentId);
    if (!payment || !payment.contractId || !payment.dueDate) continue;

    const monthStart = new Date(payment.dueDate);
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const monthEnd = new Date(monthStart);
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);

    const entries = await prisma.ownerEntry.findMany({
      where: {
        contractId: payment.contractId,
        category: { in: ["REPASSE", "GARANTIA"] },
        dueDate: { gte: monthStart, lt: monthEnd },
      },
    });

    for (const e of entries) {
      if (!e.notes) continue;
      try {
        const n = JSON.parse(e.notes);
        if (n.irrfValue || n.irrfRate) {
          n.irrfValue = 0;
          n.irrfRate = 0;
          await prisma.ownerEntry.update({
            where: { id: e.id },
            data: { notes: JSON.stringify(n) },
          });
          updatedEntries++;
        }
      } catch { /* notes nao eh JSON valido */ }
    }
  }

  return NextResponse.json({
    mode: "APPLIED",
    totalPagamentosComIrrf: payments.length,
    totalCorretos: payments.length - incorrect.length,
    totalIncorretos: incorrect.length,
    totalIrrfIncorreto: Math.round(totalIrrfIncorreto * 100) / 100,
    pagamentosAtualizados: updatedPayments,
    ownerEntriesAtualizadas: updatedEntries,
    mensagem:
      `Zerado IRRF em ${updatedPayments} pagamentos e ${updatedEntries} repasses. ` +
      `Demonstrativos novos nao vao mais mostrar IRRF nesses casos.`,
    incorretos: incorrect.slice(0, 50),
  });
}
