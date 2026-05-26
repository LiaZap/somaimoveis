/**
 * POST /api/invoices/:id/cancel
 *
 * Cancela uma NFS-e. Roteia para o provedor configurado em FiscalSettings.
 * Body: { justification: string }
 *
 * Atualmente suportado:
 *   - SPEDY (via DELETE /service-invoices/{spedyId})
 *   - Outros: retorna 501 (nao implementado)
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePagePermission, isAuthError } from "@/lib/api-auth";
import { safeDecryptString } from "@/lib/crypto";
import { cancelarNFSeSpedy, type SpedyAmbiente } from "@/lib/nfse-spedy-client";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requirePagePermission("notas_fiscais");
  if (isAuthError(auth)) return auth;

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const justification = typeof body.justification === "string"
    ? body.justification.trim()
    : "";

  if (!justification) {
    return NextResponse.json(
      { error: "Justificativa obrigatoria (minimo 1 caractere)." },
      { status: 400 },
    );
  }

  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice) {
    return NextResponse.json({ error: "Nota fiscal nao encontrada" }, { status: 404 });
  }

  if (invoice.status === "CANCELADA") {
    return NextResponse.json({ error: "Nota ja esta cancelada" }, { status: 400 });
  }

  const settings = await prisma.fiscalSettings.findFirst();
  if (!settings) {
    return NextResponse.json(
      { error: "Configuracoes fiscais nao definidas" },
      { status: 400 },
    );
  }

  const provedor = (settings.provedor || "NFSE_NACIONAL").toUpperCase();

  if (provedor !== "SPEDY") {
    return NextResponse.json(
      {
        error: `Cancelamento via API ainda nao implementado para o provedor ${provedor}. ` +
          "Cancele direto no portal da prefeitura/provedor.",
      },
      { status: 501 },
    );
  }

  if (!settings.apiToken) {
    return NextResponse.json(
      { error: "Chave Spedy nao configurada" },
      { status: 400 },
    );
  }

  // chaveAcesso guarda o id do Spedy (vide emit route)
  const spedyId = invoice.chaveAcesso;
  if (!spedyId) {
    return NextResponse.json(
      { error: "Identificador Spedy nao encontrado nesta nota" },
      { status: 400 },
    );
  }

  const apiKey = safeDecryptString(settings.apiToken);
  if (!apiKey) {
    return NextResponse.json(
      { error: "API Key Spedy vazia apos decifragem. Re-cadastre em /configuracoes/fiscal." },
      { status: 500 },
    );
  }

  const ambiente = (settings.ambiente || "HOMOLOGACAO").toUpperCase() as SpedyAmbiente;

  try {
    const result = await cancelarNFSeSpedy(ambiente, apiKey, spedyId, justification);

    // FIX: respeita o status retornado pela Spedy. Cancelamento nem sempre
    // e imediato — depende da prefeitura. Estados conhecidos:
    //   canceled / cancellation_succeeded  -> CANCELADA definitiva
    //   cancellation_request_succeeded     -> requisicao aceita mas pode levar
    //                                          tempo (Sao Paulo cancela em batch).
    //                                          Trata como PROCESSANDO ate webhook /
    //                                          check-status confirmar.
    //   <qualquer outro / processing_*>    -> PROCESSANDO (em andamento)
    // Antes: marcava CANCELADA sempre, mesmo quando a Spedy ainda estava
    // tramitando o pedido — UI mostrava cancelada mas a nota ainda existia.
    const statusSpedy = String((result as any)?.status || "").toLowerCase();
    const ehCancelDefinitivo =
      statusSpedy === "canceled" ||
      statusSpedy === "cancelled" ||
      statusSpedy === "cancellation_succeeded";
    const novoStatus = ehCancelDefinitivo ? "CANCELADA" : "PROCESSANDO";

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status: novoStatus,
        respostaXml: JSON.stringify(result),
        cancelamentoMotivo: justification,
        // dataCancelamento so quando o cancel e definitivo. Se a Spedy ainda
        // estiver tramitando, deixamos null pro webhook/check-status preencher
        // quando confirmar.
        ...(ehCancelDefinitivo ? { dataCancelamento: new Date() } : {}),
      },
    });

    return NextResponse.json({ ok: true, status: novoStatus, result });
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string; body?: unknown };
    console.error("[Invoice Cancel] Spedy:", err);
    return NextResponse.json(
      {
        error: err.message || "Erro ao cancelar nota",
        details: err.body,
      },
      { status: err.status || 500 },
    );
  }
}
