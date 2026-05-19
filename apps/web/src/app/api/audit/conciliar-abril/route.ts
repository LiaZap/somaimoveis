import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/audit/conciliar-abril
 *
 * Cruza os pagamentos dos inquilinos de Abril/2026 com os Repasses do
 * mesmo periodo para identificar discrepancias que fazem o demonstrativo
 * de abril ficar incompleto/errado.
 *
 * Estrategia:
 *   - Lista TODO TenantEntry com paidAt em 04/2026 (CREDITO, status=PAGO)
 *   - Lista TODO Payment com paidAt em 04/2026 (status=PAGO)
 *   - Lista TODO OwnerEntry REPASSE com paidAt em 04/2026
 *   - Para cada inquilino que pagou ALUGUEL em abril, verifica se o
 *     proprietario tem um REPASSE correspondente em abril
 *   - Reporta gaps (inquilino pagou mas owner nao tem repasse) e
 *     orfaos (repasse sem pagamento correspondente)
 *
 * Body opcional (POST): { aplicar: true } executa as correcoes.
 */

const APRIL_START = new Date("2026-04-01T00:00:00.000Z");
const APRIL_END = new Date("2026-04-30T23:59:59.999Z");

type GapItem = {
  tipo: "GAP_REPASSE" | "REPASSE_ORFAO" | "VALOR_DIVERGENTE" | "OK";
  contractCode: string | null;
  ownerName: string;
  tenantName: string | null;
  pagamentoInquilino: {
    fonte: "Payment" | "TenantEntry";
    id: string;
    valor: number;
    paidAt: string | null;
    categoria: string | null;
    description: string | null;
  } | null;
  repasseOwner: {
    id: string;
    valor: number;
    paidAt: string | null;
    description: string | null;
    editedManually: boolean;
  } | null;
  observacao: string;
};

export async function GET() {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  // 1) Pagamentos dos inquilinos em Abril
  const tenantPayments = await prisma.payment.findMany({
    where: {
      status: "PAGO",
      paidAt: { gte: APRIL_START, lte: APRIL_END },
    },
    include: {
      contract: { select: { id: true, code: true, ownerId: true, rentalValue: true, adminFeePercent: true } },
      tenant: { select: { id: true, name: true } },
      owner: { select: { id: true, name: true } },
    },
  });

  const tenantCreditEntries = await prisma.tenantEntry.findMany({
    where: {
      type: "CREDITO",
      status: "PAGO",
      paidAt: { gte: APRIL_START, lte: APRIL_END },
    },
    include: {
      tenant: { select: { id: true, name: true } },
    },
  });

  // TenantEntries de IPTU/aluguel pagos em abril (DEBITO + status PAGO)
  const tenantDebitPaid = await prisma.tenantEntry.findMany({
    where: {
      type: "DEBITO",
      status: "PAGO",
      paidAt: { gte: APRIL_START, lte: APRIL_END },
    },
    include: {
      tenant: { select: { id: true, name: true } },
    },
  });

  // 2) Repasses em Abril
  const aprilRepasses = await prisma.ownerEntry.findMany({
    where: {
      category: "REPASSE",
      paidAt: { gte: APRIL_START, lte: APRIL_END },
    },
    include: {
      owner: { select: { id: true, name: true } },
    },
  });

  // 3) Repasses em ABERTO (PENDENTE) com dueDate em abril — sem paidAt
  const aprilRepassesPendentes = await prisma.ownerEntry.findMany({
    where: {
      category: "REPASSE",
      status: "PENDENTE",
      paidAt: null,
      dueDate: { gte: APRIL_START, lte: APRIL_END },
    },
    include: {
      owner: { select: { id: true, name: true } },
    },
  });

  // ---- analise ----
  const gaps: GapItem[] = [];
  const seenContractsWithRepasse = new Set<string>();

  for (const r of aprilRepasses) {
    if (r.contractId) seenContractsWithRepasse.add(r.contractId);
  }

  // Para cada Payment pago em abril, verifica se contractId tem Repasse em abril
  for (const p of tenantPayments) {
    if (!p.contractId) continue;
    const repasse = aprilRepasses.find(
      (r) => r.contractId === p.contractId && r.ownerId === p.contract?.ownerId
    );
    const repassePend = aprilRepassesPendentes.find(
      (r) => r.contractId === p.contractId && r.ownerId === p.contract?.ownerId
    );

    if (!repasse && !repassePend) {
      gaps.push({
        tipo: "GAP_REPASSE",
        contractCode: p.contract?.code || null,
        ownerName: p.owner?.name || "—",
        tenantName: p.tenant?.name || null,
        pagamentoInquilino: {
          fonte: "Payment",
          id: p.id,
          valor: p.paidValue ?? p.value,
          paidAt: p.paidAt?.toISOString() ?? null,
          categoria: "ALUGUEL",
          description: p.description ?? `Pagamento ${p.code}`,
        },
        repasseOwner: null,
        observacao: "Inquilino pagou em abril; nao ha REPASSE para o proprietario neste mes.",
      });
    } else if (!repasse && repassePend) {
      gaps.push({
        tipo: "GAP_REPASSE",
        contractCode: p.contract?.code || null,
        ownerName: p.owner?.name || "—",
        tenantName: p.tenant?.name || null,
        pagamentoInquilino: {
          fonte: "Payment",
          id: p.id,
          valor: p.paidValue ?? p.value,
          paidAt: p.paidAt?.toISOString() ?? null,
          categoria: "ALUGUEL",
          description: p.description ?? `Pagamento ${p.code}`,
        },
        repasseOwner: {
          id: repassePend.id,
          valor: repassePend.value,
          paidAt: null,
          description: repassePend.description,
          editedManually: extractEditedManually(repassePend.notes),
        },
        observacao: "Inquilino pagou em abril; existe REPASSE PENDENTE com dueDate em abril mas sem paidAt — marcar como PAGO.",
      });
    } else if (repasse) {
      // Verifica valor
      const expectedOwnerValue = p.splitOwnerValue ?? p.netToOwner ?? null;
      const diff = expectedOwnerValue != null ? Math.abs(repasse.value - expectedOwnerValue) : 0;
      if (expectedOwnerValue != null && diff > 0.01 && !extractEditedManually(repasse.notes)) {
        gaps.push({
          tipo: "VALOR_DIVERGENTE",
          contractCode: p.contract?.code || null,
          ownerName: p.owner?.name || "—",
          tenantName: p.tenant?.name || null,
          pagamentoInquilino: {
            fonte: "Payment",
            id: p.id,
            valor: p.paidValue ?? p.value,
            paidAt: p.paidAt?.toISOString() ?? null,
            categoria: "ALUGUEL",
            description: p.description ?? `Pagamento ${p.code}`,
          },
          repasseOwner: {
            id: repasse.id,
            valor: repasse.value,
            paidAt: repasse.paidAt?.toISOString() ?? null,
            description: repasse.description,
            editedManually: extractEditedManually(repasse.notes),
          },
          observacao: `Repasse de R$ ${repasse.value.toFixed(2)} divergente do esperado R$ ${expectedOwnerValue.toFixed(2)}.`,
        });
      }
    }
  }

  // Repasses orfaos: existe Repasse em abril mas nao ha Payment correspondente em abril
  for (const r of aprilRepasses) {
    if (!r.contractId) continue;
    const hasPayment = tenantPayments.some(
      (p) => p.contractId === r.contractId
    );
    if (!hasPayment) {
      // Pode ser que tenant pagou via TenantEntry direto ao inves de Payment
      gaps.push({
        tipo: "REPASSE_ORFAO",
        contractCode: null,
        ownerName: r.owner?.name || "—",
        tenantName: null,
        pagamentoInquilino: null,
        repasseOwner: {
          id: r.id,
          valor: r.value,
          paidAt: r.paidAt?.toISOString() ?? null,
          description: r.description,
          editedManually: extractEditedManually(r.notes),
        },
        observacao: "REPASSE em abril sem Payment correspondente — investigar (PIX manual ou TenantEntry).",
      });
    }
  }

  // Resumo dos owners impactados
  const byOwner = new Map<string, { owner: string; gaps: number; pendentes: number; ok: number }>();
  for (const g of gaps) {
    const key = g.ownerName;
    if (!byOwner.has(key)) byOwner.set(key, { owner: key, gaps: 0, pendentes: 0, ok: 0 });
    const r = byOwner.get(key)!;
    if (g.tipo === "GAP_REPASSE") r.gaps++;
    if (g.tipo === "VALOR_DIVERGENTE") r.pendentes++;
  }

  return NextResponse.json({
    periodo: "Abril/2026",
    totals: {
      pagamentosInquilino_Payment: tenantPayments.length,
      pagamentosInquilino_TenantCredito: tenantCreditEntries.length,
      pagamentosInquilino_TenantDebito_PAGO: tenantDebitPaid.length,
      repasses_PAGOS_abril: aprilRepasses.length,
      repasses_PENDENTES_dueDate_abril: aprilRepassesPendentes.length,
    },
    gaps,
    resumoPorOwner: Array.from(byOwner.values()).sort((a, b) => b.gaps - a.gaps),
  });
}

/**
 * POST /api/audit/conciliar-abril
 *
 * Body: { aplicar: true, gapsIds: string[] }
 * - Marca os Repasses PENDENTE com dueDate em abril como PAGO,
 *   preenchendo paidAt com a data do Payment correspondente.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  const body = await request.json();
  const aplicar = body.aplicar === true;
  const apenasIds: string[] | null = Array.isArray(body.repasseIds) ? body.repasseIds : null;

  if (!aplicar) {
    return NextResponse.json({ error: "Confirmar com aplicar: true" }, { status: 400 });
  }

  // Busca repasses PENDENTES com dueDate em abril e o Payment correspondente
  const repassesPend = await prisma.ownerEntry.findMany({
    where: {
      category: "REPASSE",
      status: "PENDENTE",
      paidAt: null,
      dueDate: { gte: APRIL_START, lte: APRIL_END },
      ...(apenasIds ? { id: { in: apenasIds } } : {}),
    },
  });

  let atualizados = 0;
  const log: Array<{ repasseId: string; paidAt: string }> = [];

  for (const r of repassesPend) {
    if (!r.contractId) continue;
    const payment = await prisma.payment.findFirst({
      where: {
        contractId: r.contractId,
        status: "PAGO",
        paidAt: { gte: APRIL_START, lte: APRIL_END },
      },
      orderBy: { paidAt: "desc" },
    });
    if (!payment || !payment.paidAt) continue;

    await prisma.ownerEntry.update({
      where: { id: r.id },
      data: { status: "PAGO", paidAt: payment.paidAt },
    });
    log.push({ repasseId: r.id, paidAt: payment.paidAt.toISOString() });
    atualizados++;
  }

  return NextResponse.json({ atualizados, total: repassesPend.length, log });
}

function extractEditedManually(notes: string | null): boolean {
  if (!notes) return false;
  try {
    const n = JSON.parse(notes);
    return n.editedManually === true;
  } catch {
    return false;
  }
}
