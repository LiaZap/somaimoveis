import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";
import { sicrediCancelBoleto } from "@/lib/sicredi-client";
import { nextBusinessDay } from "@/lib/business-days";

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
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const _request = request;
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

    const oldNossoNumero = payment.nossoNumero;

    // 1.5. Buscar dueDate atual — se ja passou, ajusta pra proximo dia util
    //      (Sicredi nao aceita criar boleto com data no passado)
    const fullPayment = await prisma.payment.findUnique({
      where: { id },
      select: { dueDate: true, value: true },
    });
    let dueDateAdjusted: Date | null = null;
    if (fullPayment?.dueDate) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const due = new Date(fullPayment.dueDate);
      due.setHours(0, 0, 0, 0);
      if (due < today) {
        // Move pra hoje (ou proximo dia util se hoje for fim de semana)
        const newRaw = new Date();
        newRaw.setHours(12, 0, 0, 0);
        dueDateAdjusted = nextBusinessDay(newRaw);
      }
    }

    // 2. Limpar campos do boleto no banco pra permitir regenerar +
    //    ajustar dueDate se necessario
    await prisma.payment.update({
      where: { id },
      data: {
        nossoNumero: null,
        linhaDigitavel: null,
        codigoBarras: null,
        pixCopiaECola: null,
        boletoStatus: "CANCELADO",
        // Limpa snapshot tambem — vai pegar config nova no proximo registro
        multaTipoBoleto: null,
        multaValorBoleto: null,
        jurosTipoBoleto: null,
        jurosValorBoleto: null,
        ...(dueDateAdjusted && { dueDate: dueDateAdjusted }),
      },
    });

    // 3. Re-emitir o boleto na sequencia chamando a rota interna
    //    (POST /api/payments/[id]/boleto). Reusa toda a logica que ja
    //    pega BillingSettings + config do contrato + salva snapshot.
    const cookie = _request.headers.get("cookie") || "";
    const baseUrl = new URL(_request.url).origin;
    const reemissaoRes = await fetch(`${baseUrl}/api/payments/${id}/boleto`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
    });
    const reemissaoData = await reemissaoRes.json().catch(() => ({}));

    if (!reemissaoRes.ok) {
      return NextResponse.json(
        {
          warning: "Boleto antigo cancelado, mas falhou ao re-emitir.",
          oldNossoNumero,
          reemissaoError: reemissaoData?.error || `HTTP ${reemissaoRes.status}`,
          message:
            "Use o botao 'Gerar Boleto' na tela do pagamento pra emitir manualmente " +
            "com a config atual.",
        },
        { status: 207 }, // multi-status: cancelou OK, re-emissao falhou
      );
    }

    return NextResponse.json({
      success: true,
      message:
        "Boleto regerado com sucesso usando a config atual." +
        (dueDateAdjusted
          ? ` ⚠ Vencimento ajustado pra ${dueDateAdjusted.toLocaleDateString("pt-BR")} (data antiga estava no passado).`
          : ""),
      oldNossoNumero,
      newNossoNumero: reemissaoData?.nossoNumero,
      dueDateAdjusted: dueDateAdjusted?.toISOString() || null,
      payment: {
        id: payment.id,
        code: payment.code,
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
