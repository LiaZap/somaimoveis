/**
 * GET /api/invoices/:id/download?format=xml|pdf
 *
 * Baixa o XML ou PDF da NFS-e. Roteia para o provedor:
 *   - SPEDY: chama API de download (publica, sem auth)
 *   - Outros: 501 (use pdfUrl/respostaXml direto)
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePagePermission, isAuthError } from "@/lib/api-auth";
import {
  baixarXmlSpedy,
  baixarPdfSpedy,
  type SpedyAmbiente,
} from "@/lib/nfse-spedy-client";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requirePagePermission("notas_fiscais");
  if (isAuthError(auth)) return auth;

  const { id } = await params;
  const url = new URL(request.url);
  const format = (url.searchParams.get("format") || "pdf").toLowerCase();

  if (format !== "xml" && format !== "pdf") {
    return NextResponse.json(
      { error: "format deve ser 'xml' ou 'pdf'" },
      { status: 400 },
    );
  }

  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice) {
    return NextResponse.json({ error: "Nota fiscal nao encontrada" }, { status: 404 });
  }

  const settings = await prisma.fiscalSettings.findFirst();
  const provedor = (settings?.provedor || "NFSE_NACIONAL").toUpperCase();

  if (provedor !== "SPEDY") {
    return NextResponse.json(
      {
        error: `Download via API ainda nao implementado para ${provedor}.`,
        hint: format === "pdf"
          ? "Use pdfUrl da nota direto."
          : "Use respostaXml/dpsXml direto do banco.",
      },
      { status: 501 },
    );
  }

  const spedyId = invoice.chaveAcesso;
  if (!spedyId) {
    return NextResponse.json(
      { error: "Identificador Spedy nao encontrado nesta nota" },
      { status: 400 },
    );
  }

  const ambiente = (settings?.ambiente || "HOMOLOGACAO").toUpperCase() as SpedyAmbiente;

  try {
    const buf = format === "xml"
      ? await baixarXmlSpedy(ambiente, spedyId)
      : await baixarPdfSpedy(ambiente, spedyId);

    const filename = `nfse-${invoice.numero || invoice.id}.${format}`;
    const contentType = format === "xml" ? "application/xml" : "application/pdf";
    // Headers compatíveis com Web Standard Response — converte Buffer pra Uint8Array
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    console.error("[Invoice Download] Spedy:", err);
    return NextResponse.json(
      { error: err.message || "Erro ao baixar arquivo" },
      { status: err.status || 500 },
    );
  }
}
