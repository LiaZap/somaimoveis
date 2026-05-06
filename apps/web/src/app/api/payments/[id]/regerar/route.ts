import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";
import { sicrediCancelBoleto } from "@/lib/sicredi-client";

/**
 * POST /api/payments/[id]/regerar
 *
 * Cancela o boleto atual no Sicredi e gera novo com as regras atuais
 * de multa/juros (do BillingSettings) e a data atual do contrato.
 *
 * Util quando:
 *  - Boleto foi emitido sem multa/juros configurado e precisa ter
 *  - paymentDay do contrato mudou apos boleto ja emitido
 *  - Qualquer outra mudanca que invalide o boleto atual
 *
 * NAO regenera se:
 *  - Boleto ja foi PAGO
 *  - Boleto foi CANCELADO
 *
 * Apos cancelar com sucesso no Sicredi, chama o endpoint POST
 * /api/payments/[id]/boleto que recria o boleto com as regras atuais.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  try {
    const { id } = await params;
    const payment = await prisma.payment.findUnique({
      where: { id },
      select: {
        id: true,
        code: true,
        status: true,
        nossoNumero: true,
        boletoStatus: true,
      },
    });
    if (!payment) {
      return NextResponse.json({ error: "Pagamento nao encontrado" }, { status: 404 });
    }
    if (payment.status === "PAGO") {
      return NextResponse.json(
        { error: "Pagamento ja foi pago — nao pode ser regerado" },
        { status: 400 },
      );
    }
    if (payment.status === "CANCELADO") {
      return NextResponse.json(
        { error: "Pagamento esta cancelado — nao pode ser regerado" },
        { status: 400 },
      );
    }
    if (!payment.nossoNumero) {
      return NextResponse.json(
        { error: "Boleto ainda nao foi emitido — use o botao Gerar Boleto normal" },
        { status: 400 },
      );
    }

    // 1. Cancelar boleto atual no Sicredi
    const cancelResult = await sicrediCancelBoleto(payment.nossoNumero);
    if (!cancelResult.success) {
      return NextResponse.json(
        {
          error: `Falha ao cancelar boleto atual no Sicredi: ${cancelResult.error || "?"}`,
          step: "CANCELAR",
        },
        { status: 500 },
      );
    }

    // 2. Limpar campos do boleto no banco pra permitir regenerar
    await prisma.payment.update({
      where: { id },
      data: {
        nossoNumero: null,
        linhaDigitavel: null,
        codigoBarras: null,
        pixCopiaECola: null,
        boletoStatus: "CANCELADO",
      },
    });

    return NextResponse.json({
      success: true,
      message:
        "Boleto antigo cancelado. Use o botao 'Gerar Boleto' pra criar novo " +
        "com as regras atuais de juros/multa.",
      payment: {
        id: payment.id,
        code: payment.code,
        oldNossoNumero: payment.nossoNumero,
      },
    });
  } catch (error: any) {
    console.error("[Payment Regerar]", error);
    return NextResponse.json(
      { error: error?.message || "Erro ao regerar boleto" },
      { status: 500 },
    );
  }
}
