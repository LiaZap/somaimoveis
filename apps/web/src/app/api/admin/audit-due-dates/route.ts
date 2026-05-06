import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * GET /api/admin/audit-due-dates
 * Lista boletos PENDENTES/EMITIDOS cujo dueDate nao bate com o
 * paymentDay do contrato (ex: contrato editado depois do boleto
 * ser gerado, ou paymentDay alterado sem regenerar boleto).
 *
 * Tolera ajuste pra proximo dia util (ate +5 dias do paymentDay).
 */
export async function GET(_request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  // Buscar todos os pagamentos PENDENTES/ATRASADOS (nao pagos ainda)
  const payments = await prisma.payment.findMany({
    where: {
      status: { in: ["PENDENTE", "ATRASADO"] },
    },
    select: {
      id: true,
      code: true,
      dueDate: true,
      value: true,
      contract: {
        select: {
          id: true,
          code: true,
          paymentDay: true,
          tenant: { select: { name: true } },
          owner: { select: { name: true } },
        },
      },
    },
  });

  type Inconsistent = {
    paymentId: string;
    code: string;
    contractCode: string;
    contractPaymentDay: number;
    boletoDueDay: number;
    dueDate: string;
    diffDays: number;
    valor: number;
    locatario: string;
    proprietario: string;
  };

  const inconsistent: Inconsistent[] = [];

  for (const p of payments) {
    if (!p.contract) continue;
    const expectedDay = p.contract.paymentDay;
    const actualDay = p.dueDate.getUTCDate();
    // Tolera ate 5 dias (ajuste pra proximo dia util cobre fim de semana + feriados)
    const diff = actualDay - expectedDay;
    // Se diff for negativo OU maior que 5, considera inconsistente
    if (diff < 0 || diff > 5) {
      inconsistent.push({
        paymentId: p.id,
        code: p.code,
        contractCode: p.contract.code,
        contractPaymentDay: expectedDay,
        boletoDueDay: actualDay,
        dueDate: p.dueDate.toISOString(),
        diffDays: diff,
        valor: p.value,
        locatario: p.contract.tenant?.name || "?",
        proprietario: p.contract.owner?.name || "?",
      });
    }
  }

  // Agrupar por contrato pra visao limpa
  const byContract = new Map<string, {
    contractCode: string;
    contractPaymentDay: number;
    locatario: string;
    proprietario: string;
    boletos: Array<{
      paymentId: string;
      code: string;
      boletoDueDay: number;
      dueDate: string;
      diffDays: number;
      valor: number;
    }>;
  }>();
  for (const x of inconsistent) {
    if (!byContract.has(x.contractCode)) {
      byContract.set(x.contractCode, {
        contractCode: x.contractCode,
        contractPaymentDay: x.contractPaymentDay,
        locatario: x.locatario,
        proprietario: x.proprietario,
        boletos: [],
      });
    }
    byContract.get(x.contractCode)!.boletos.push({
      paymentId: x.paymentId,
      code: x.code,
      boletoDueDay: x.boletoDueDay,
      dueDate: x.dueDate,
      diffDays: x.diffDays,
      valor: x.valor,
    });
  }

  return NextResponse.json({
    totalBoletosNaoPagos: payments.length,
    totalInconsistentes: inconsistent.length,
    porContrato: Array.from(byContract.values()).sort(
      (a, b) => b.boletos.length - a.boletos.length,
    ),
    inconsistentes: inconsistent.slice(0, 200),
    mensagem:
      inconsistent.length === 0
        ? "Todos os boletos pendentes batem com o paymentDay do contrato."
        : `${inconsistent.length} boletos pendentes em ${byContract.size} contrato(s) tem dueDate divergente do paymentDay. Provavel causa: contrato editado apos boleto ser gerado.`,
  });
}
