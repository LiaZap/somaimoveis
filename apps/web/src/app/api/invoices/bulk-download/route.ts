/**
 * GET /api/invoices/bulk-download?month=YYYY-MM&format=pdf|xml|both
 *
 * Empacota PDFs e/ou XMLs de todas as NFs AUTORIZADAS do mes (ou de
 * uma lista especifica de IDs) num arquivo ZIP unico pra download.
 *
 * Query params:
 *   - month   : YYYY-MM (filtra por dataEmissao OU competencia)
 *   - ids     : lista CSV de invoice IDs (opcional, override do month)
 *   - format  : "pdf" | "xml" | "both" (default: "both")
 *
 * So implementado pra provedor SPEDY (outros retornam 501).
 */
import { NextRequest, NextResponse } from "next/server";
import archiver from "archiver";
import { prisma } from "@/lib/prisma";
import { requirePagePermission, isAuthError } from "@/lib/api-auth";
import {
  baixarXmlSpedy,
  baixarPdfSpedy,
  type SpedyAmbiente,
} from "@/lib/nfse-spedy-client";

type Format = "pdf" | "xml" | "both";

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9-_.]/g, "_").slice(0, 80);
}

export async function GET(request: NextRequest) {
  const auth = await requirePagePermission("notas_fiscais");
  if (isAuthError(auth)) return auth;

  const url = new URL(request.url);
  const month = url.searchParams.get("month");
  const idsParam = url.searchParams.get("ids");
  const formatRaw = (url.searchParams.get("format") || "both").toLowerCase();
  const format: Format = formatRaw === "pdf" || formatRaw === "xml" ? formatRaw : "both";

  if (!month && !idsParam) {
    return NextResponse.json(
      { error: "Informe ?month=YYYY-MM ou ?ids=A,B,C" },
      { status: 400 },
    );
  }

  const settings = await prisma.fiscalSettings.findFirst();
  const provedor = (settings?.provedor || "NFSE_NACIONAL").toUpperCase();
  if (provedor !== "SPEDY") {
    return NextResponse.json(
      { error: `Download em massa so implementado pra SPEDY. Provedor atual: ${provedor}` },
      { status: 501 },
    );
  }

  const ambiente = (settings?.ambiente || "HOMOLOGACAO").toUpperCase() as SpedyAmbiente;

  // Carrega invoices alvo (filtra por month ou ids)
  let invoices: Array<{
    id: string;
    numero: string | null;
    chaveAcesso: string | null;
    tomadorNome: string | null;
    status: string;
  }>;

  if (idsParam) {
    const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
    invoices = await prisma.invoice.findMany({
      where: { id: { in: ids }, status: "AUTORIZADA" },
      select: { id: true, numero: true, chaveAcesso: true, tomadorNome: true, status: true },
    });
  } else {
    const [y, m] = month!.split("-").map(Number);
    if (!y || !m || m < 1 || m > 12) {
      return NextResponse.json({ error: "month invalido" }, { status: 400 });
    }
    const inicio = new Date(y, m - 1, 1);
    const fim = new Date(y, m, 1);
    invoices = await prisma.invoice.findMany({
      where: {
        status: "AUTORIZADA",
        OR: [
          { dataEmissao: { gte: inicio, lt: fim } },
          { competencia: `${y}-${String(m).padStart(2, "0")}` },
        ],
      },
      select: { id: true, numero: true, chaveAcesso: true, tomadorNome: true, status: true },
    });
  }

  if (invoices.length === 0) {
    return NextResponse.json(
      { error: "Nenhuma nota autorizada encontrada nesse filtro." },
      { status: 404 },
    );
  }

  // Cria o ZIP em streaming
  const archive = archiver("zip", { zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  archive.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise<void>((resolve, reject) => {
    archive.on("end", () => resolve());
    archive.on("error", (e) => reject(e));
  });

  const errors: Array<{ invoiceId: string; error: string }> = [];

  for (const inv of invoices) {
    if (!inv.chaveAcesso) {
      errors.push({ invoiceId: inv.id, error: "sem chaveAcesso/spedyId" });
      continue;
    }
    const nomeBase = sanitize(`${inv.numero || inv.id}_${inv.tomadorNome || ""}`).replace(/_+$/, "");

    try {
      if (format === "pdf" || format === "both") {
        const pdfBuf = await baixarPdfSpedy(ambiente, inv.chaveAcesso);
        archive.append(pdfBuf, { name: `${nomeBase}.pdf` });
      }
    } catch (e: unknown) {
      const err = e as { message?: string };
      errors.push({ invoiceId: inv.id, error: `pdf: ${err.message || "erro"}` });
    }

    try {
      if (format === "xml" || format === "both") {
        const xmlBuf = await baixarXmlSpedy(ambiente, inv.chaveAcesso);
        archive.append(xmlBuf, { name: `${nomeBase}.xml` });
      }
    } catch (e: unknown) {
      const err = e as { message?: string };
      errors.push({ invoiceId: inv.id, error: `xml: ${err.message || "erro"}` });
    }
  }

  // Se houver erros mas TUDO falhou, retorna JSON; senao inclui um relatorio no ZIP
  if (errors.length === invoices.length * (format === "both" ? 2 : 1)) {
    return NextResponse.json(
      { error: "Todas as notas falharam ao baixar", details: errors },
      { status: 500 },
    );
  }
  if (errors.length > 0) {
    archive.append(JSON.stringify(errors, null, 2), { name: "_erros.json" });
  }

  await archive.finalize();
  await done;
  const zipBuf = Buffer.concat(chunks);

  const fname = idsParam
    ? `notas-fiscais-selecionadas.zip`
    : `notas-fiscais-${month}.zip`;

  return new Response(new Uint8Array(zipBuf), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${fname}"`,
      "Cache-Control": "private, no-cache",
    },
  });
}
