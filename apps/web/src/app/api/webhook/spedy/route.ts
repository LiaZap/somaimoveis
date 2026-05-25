/**
 * POST /api/webhook/spedy
 *
 * Webhook receiver da Spedy NFe. A Spedy envia eventos do tipo
 * `invoice.status_changed` quando uma NFS-e muda de estado
 * (enqueued -> processing -> authorized | rejected | denied | canceled).
 *
 * Body tipico:
 *   {
 *     "event": "invoice.status_changed",
 *     "data": {
 *       "id": "uuid-spedy",
 *       "status": "authorized",
 *       "number": 15,
 *       "rps": { "number": 15, "series": "1" },
 *       "issuedOn": "2026-05-15T10:02:00",
 *       "authorization": { "date": "...", "protocol": "..." },
 *       "processingDetail": { "status": "success", "message": "...", "code": "100" },
 *       "integrationId": "id-do-ownerEntry"
 *     }
 *   }
 *
 * Estrategia:
 * - Localiza Invoice via chaveAcesso=spedyId (preferencial) ou integrationId
 * - Atualiza status, numero, dataEmissao, codigoVerificacao
 * - Persiste respostaXml = JSON.stringify(data) pra rastreabilidade
 *
 * Seguranca: Spedy nao tem assinatura HMAC documentada em llms.txt. Se quiser
 * adicionar protecao, configure WEBHOOK_SPEDY_SECRET no env e a Spedy
 * enviara header X-Webhook-Secret (verificar implementacao deles).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

interface SpedyWebhookEvent {
  event?: string;
  data?: {
    id?: string;
    status?: string;
    number?: number | null;
    rps?: { number?: number; series?: string };
    issuedOn?: string;
    authorization?: { date?: string; protocol?: string };
    processingDetail?: { status?: string; message?: string | null; code?: string | null };
    integrationId?: string;
  };
}

function mapSpedyStatusToInvoiceStatus(spedyStatus: string): string {
  const s = spedyStatus.toLowerCase();
  if (s === "authorized") return "AUTORIZADA";
  if (s === "canceled" || s === "cancelled") return "CANCELADA";
  if (s === "rejected" || s === "denied") return "REJEITADA";
  if (s === "processing" || s === "enqueued") return "PROCESSANDO";
  return "PENDENTE";
}

export async function POST(request: NextRequest) {
  // Verifica secret opcional (se configurado)
  const expectedSecret = process.env.WEBHOOK_SPEDY_SECRET;
  if (expectedSecret) {
    const received = request.headers.get("x-webhook-secret") ||
      request.headers.get("X-Webhook-Secret");
    if (received !== expectedSecret) {
      console.warn("[Webhook Spedy] X-Webhook-Secret invalido ou ausente");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let payload: SpedyWebhookEvent;
  try {
    payload = (await request.json()) as SpedyWebhookEvent;
  } catch (err) {
    console.error("[Webhook Spedy] Body invalido:", err);
    return NextResponse.json({ error: "Body invalido" }, { status: 400 });
  }

  const data = payload.data || {};
  const spedyId = data.id;
  const newStatus = data.status;

  if (!spedyId) {
    console.warn("[Webhook Spedy] Evento sem data.id, ignorado:", payload);
    return NextResponse.json({ ok: true, ignored: "sem data.id" });
  }

  if (!newStatus) {
    return NextResponse.json({ ok: true, ignored: "sem data.status" });
  }

  // Localiza Invoice — tentativa 1: chaveAcesso = spedyId (padrao da nossa emit)
  let invoice = await prisma.invoice.findFirst({
    where: { chaveAcesso: spedyId },
    select: { id: true, status: true },
  });

  // Tentativa 2: via integrationId (que e o ownerEntryId)
  if (!invoice && data.integrationId) {
    invoice = await prisma.invoice.findFirst({
      where: { ownerEntryId: data.integrationId },
      select: { id: true, status: true },
    });
  }

  if (!invoice) {
    console.warn(`[Webhook Spedy] Invoice nao encontrada pra spedyId=${spedyId}`);
    // Retorna 200 mesmo assim pra Spedy nao reenviar — pode ser nota emitida
    // antes da nossa integracao
    return NextResponse.json({ ok: true, ignored: "invoice nao encontrada" });
  }

  const invoiceStatus = mapSpedyStatusToInvoiceStatus(newStatus);

  const updateData: {
    status: string;
    respostaXml: string;
    numero?: string;
    serie?: string;
    codigoVerificacao?: string;
    dataEmissao?: Date;
    chaveAcesso?: string;
    rejeicaoCodigo?: string | null;
    rejeicaoMotivo?: string | null;
  } = {
    status: invoiceStatus,
    respostaXml: JSON.stringify(data),
  };

  if (data.number) updateData.numero = String(data.number);
  if (data.rps?.series) updateData.serie = data.rps.series;
  if (data.authorization?.protocol) updateData.codigoVerificacao = data.authorization.protocol;
  if (data.issuedOn) updateData.dataEmissao = new Date(data.issuedOn);
  // Garante chaveAcesso = spedyId (caso a Invoice tenha sido criada sem)
  updateData.chaveAcesso = spedyId;

  if (invoiceStatus === "REJEITADA") {
    updateData.rejeicaoCodigo = data.processingDetail?.code || newStatus;
    updateData.rejeicaoMotivo = data.processingDetail?.message ||
      `Status final: ${newStatus}`;
  } else if (invoiceStatus === "AUTORIZADA") {
    // Limpa rejeicao anterior caso a nota tenha sido reemitida com sucesso
    updateData.rejeicaoCodigo = null;
    updateData.rejeicaoMotivo = null;
  }

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: updateData,
  });

  console.log(
    `[Webhook Spedy] Invoice ${invoice.id} atualizada: ${invoice.status} -> ${invoiceStatus}`
  );

  return NextResponse.json({ ok: true, invoiceId: invoice.id, status: invoiceStatus });
}
