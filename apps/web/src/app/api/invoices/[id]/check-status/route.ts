/**
 * POST /api/invoices/:id/check-status
 *
 * Forca refresh de status da NFS-e consultando o provedor.
 * Util quando webhook nao chegou ou pra reconfirmar manualmente.
 *
 * Atualmente suporta SPEDY (chama POST /service-invoices/{id}/check-status
 * seguido de GET pra pegar o estado atualizado).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePagePermission, isAuthError } from "@/lib/api-auth";
import { safeDecryptString } from "@/lib/crypto";
import {
  checkStatusSpedy,
  consultarNFSeSpedy,
  type SpedyAmbiente,
} from "@/lib/nfse-spedy-client";

function mapSpedyStatusToInvoiceStatus(spedyStatus: string): string {
  const s = (spedyStatus || "").toLowerCase();
  if (s === "authorized") return "AUTORIZADA";
  if (s === "canceled" || s === "cancelled") return "CANCELADA";
  if (s === "rejected" || s === "denied") return "REJEITADA";
  if (s === "processing" || s === "enqueued") return "PROCESSANDO";
  return "PENDENTE";
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requirePagePermission("notas_fiscais");
  if (isAuthError(auth)) return auth;

  const { id } = await params;
  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice) {
    return NextResponse.json({ error: "Nota fiscal nao encontrada" }, { status: 404 });
  }

  const settings = await prisma.fiscalSettings.findFirst();
  const provedor = (settings?.provedor || "NFSE_NACIONAL").toUpperCase();

  if (provedor !== "SPEDY") {
    return NextResponse.json(
      { error: `check-status nao implementado para o provedor ${provedor}` },
      { status: 501 }
    );
  }

  if (!settings?.apiToken) {
    return NextResponse.json({ error: "Chave Spedy nao configurada" }, { status: 400 });
  }

  const spedyId = invoice.chaveAcesso;
  if (!spedyId) {
    return NextResponse.json(
      { error: "Identificador Spedy nao encontrado nesta nota" },
      { status: 400 }
    );
  }

  const apiKey = safeDecryptString(settings.apiToken);
  if (!apiKey) {
    return NextResponse.json(
      { error: "API Key Spedy vazia apos decifragem. Re-cadastre em /configuracoes/fiscal." },
      { status: 500 }
    );
  }

  const ambiente = (settings.ambiente || "HOMOLOGACAO").toUpperCase() as SpedyAmbiente;

  try {
    // Primeiro forca a Spedy consultar a prefeitura (atualiza estado interno)
    await checkStatusSpedy(ambiente, apiKey, spedyId);
    // Depois consulta o estado atualizado
    const nf = await consultarNFSeSpedy(ambiente, apiKey, spedyId);
    const novoStatus = mapSpedyStatusToInvoiceStatus(nf.status || "");

    const updateData: Record<string, unknown> = {
      status: novoStatus,
    };

    // FIX: so sobrescreve respostaXml se a nova resposta tiver conteudo
    // util OU se o status mudou. Antes, qualquer check-status reescrevia
    // respostaXml com a resposta atual da Spedy — em casos onde a Spedy
    // retornava payload minimo (ex: ainda processando, sem detalhes), o
    // XML rico anterior (com authorization, totals, etc) era perdido.
    const novaResposta = JSON.stringify(nf);
    const respostaAtual = invoice.respostaXml || "";
    const statusMudou = novoStatus !== invoice.status;
    const novaTemMaisInfo = novaResposta.length >= respostaAtual.length;
    if (statusMudou || novaTemMaisInfo) {
      updateData.respostaXml = novaResposta;
    }

    if (nf.number) updateData.numero = String(nf.number);
    if (nf.rps?.series) updateData.serie = nf.rps.series;
    if (nf.authorization?.protocol) updateData.codigoVerificacao = nf.authorization.protocol;
    if (nf.issuedOn) updateData.dataEmissao = new Date(nf.issuedOn);
    if (novoStatus === "REJEITADA") {
      updateData.rejeicaoCodigo = nf.processingDetail?.code || nf.status;
      updateData.rejeicaoMotivo = nf.processingDetail?.message ||
        `Status: ${nf.status}`;
    } else if (novoStatus === "AUTORIZADA") {
      updateData.rejeicaoCodigo = null;
      updateData.rejeicaoMotivo = null;
    } else if (novoStatus === "CANCELADA" && !invoice.dataCancelamento) {
      // Confirma o cancelamento quando a Spedy reconhece o status final
      // (cancel route deixa dataCancelamento null se a Spedy ainda estiver
      // tramitando — aqui fecha o ciclo).
      updateData.dataCancelamento = nf.issuedOn ? new Date(nf.issuedOn) : new Date();
    }

    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: updateData,
    });

    return NextResponse.json({
      ok: true,
      status: novoStatus,
      spedy: {
        id: nf.id,
        status: nf.status,
        number: nf.number,
        processingDetail: nf.processingDetail,
      },
      invoice: {
        id: updated.id,
        status: updated.status,
        numero: updated.numero,
      },
    });
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string; body?: unknown };
    console.error("[Invoice CheckStatus] Spedy:", err);
    return NextResponse.json(
      {
        error: err.message || "Erro ao consultar status",
        details: err.body,
      },
      { status: err.status || 500 }
    );
  }
}
