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
import { decryptString } from "@/lib/crypto";
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

  let apiKey: string;
  try {
    apiKey = decryptString(settings.apiToken);
  } catch (err) {
    console.error("[Invoice Cancel] decryptString:", err);
    return NextResponse.json(
      { error: "Erro ao acessar chave Spedy" },
      { status: 500 },
    );
  }

  const ambiente = (settings.ambiente || "HOMOLOGACAO").toUpperCase() as SpedyAmbiente;

  try {
    const result = await cancelarNFSeSpedy(ambiente, apiKey, spedyId, justification);

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status: "CANCELADA",
        respostaXml: JSON.stringify(result),
      },
    });

    return NextResponse.json({ ok: true, result });
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
