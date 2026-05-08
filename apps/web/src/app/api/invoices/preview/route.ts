import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePagePermission, isAuthError } from "@/lib/api-auth";
import { decryptString } from "@/lib/crypto";
import { extractPfx } from "@/lib/nfse-pfx";
import { buildDpsXml, type PrestadorData, type TomadorData, type ServicoData } from "@/lib/nfse-dps-builder";
import { signDps } from "@/lib/nfse-xades-signer";
import { getIbgeCode } from "@/lib/nfse-gov-br-client";

/**
 * GET /api/invoices/preview?ownerEntryId=XXX[&signed=1]
 *
 * Retorna o XML da DPS que SERIA enviado (sem chamar gov.br). Util pra
 * comparar a estrutura com um XML real autorizado e debugar problemas
 * de schema/Pattern antes de gastar tentativas no SEFIN.
 *
 *  - signed=0 (default): retorna apenas o DPS sem assinatura
 *  - signed=1: retorna assinado (precisa do certificado uploaded)
 */
export async function GET(request: NextRequest) {
  const auth = await requirePagePermission("notas_fiscais");
  if (isAuthError(auth)) return auth;

  const { searchParams } = new URL(request.url);
  const ownerEntryId = searchParams.get("ownerEntryId");
  const wantSigned = searchParams.get("signed") === "1";

  if (!ownerEntryId) {
    return NextResponse.json({ error: "ownerEntryId obrigatorio" }, { status: 400 });
  }

  const settings = await prisma.fiscalSettings.findFirst();
  if (!settings || !settings.cnpj || !settings.inscricaoMunicipal || !settings.codigoServicoMunicipal) {
    return NextResponse.json(
      { error: "FiscalSettings incompleta — CNPJ/IM/codigo de servico obrigatorios" },
      { status: 400 },
    );
  }

  const entry = await prisma.ownerEntry.findUnique({
    where: { id: ownerEntryId },
    include: { owner: true },
  });
  if (!entry) {
    return NextResponse.json({ error: "OwnerEntry nao encontrada" }, { status: 404 });
  }

  const contract = entry.contractId
    ? await prisma.contract.findUnique({
        where: { id: entry.contractId },
        select: { code: true, adminFeePercent: true },
      })
    : null;

  // Calcula taxa adm a partir das notes
  let adminFeeValue = 0;
  let adminFeePercent = contract?.adminFeePercent || 10;
  let aluguelBruto = 0;
  if (entry.notes) {
    try {
      const n = JSON.parse(entry.notes);
      if (typeof n.adminFeeValue === "number") adminFeeValue = n.adminFeeValue;
      if (typeof n.adminFeePercent === "number") adminFeePercent = n.adminFeePercent;
      if (typeof n.aluguelBruto === "number") aluguelBruto = n.aluguelBruto;
    } catch { /* ignore */ }
  }
  if (!adminFeeValue && aluguelBruto) {
    adminFeeValue = Math.round(aluguelBruto * (adminFeePercent / 100) * 100) / 100;
  }

  const ibge = getIbgeCode(settings.city || "", settings.state || "RS") || "4316808";
  const ambiente = settings.ambiente === "PRODUCAO" ? "PRODUCAO" : "HOMOLOGACAO";

  // Numero sequencial: proximo da serie
  const lastInvoice = await prisma.invoice.findFirst({
    orderBy: { createdAt: "desc" },
    select: { numero: true },
  });
  const nextNumeroDps = lastInvoice?.numero ? parseInt(lastInvoice.numero) + 1 : 1;

  const competencia = entry.dueDate
    ? `${entry.dueDate.getFullYear()}-${String(entry.dueDate.getMonth() + 1).padStart(2, "0")}-01`
    : new Date().toISOString().split("T")[0];

  const prestador: PrestadorData = {
    cnpj: settings.cnpj.replace(/\D/g, ""),
    inscricaoMunicipal: settings.inscricaoMunicipal,
    razaoSocial: settings.razaoSocial || "SOMMA IMOVEIS LTDA",
    endereco: {
      logradouro: settings.street || "Rua Tenente Coronel Brito",
      numero: settings.number || "138",
      complemento: settings.complement || undefined,
      bairro: settings.neighborhood || "Centro",
      codigoMunicipio: ibge,
      uf: settings.state || "RS",
      cep: (settings.zipCode || "96810202").replace(/\D/g, ""),
    },
    regimeTributario: settings.regimeTributario === "SIMPLES_NACIONAL" ? 1
      : settings.regimeTributario === "MEI" ? 3 : 2,
    simplesAliquota: settings.simplesAliquota || undefined,
  };

  const tomador: TomadorData = {
    tipo: entry.owner.personType === "PJ" ? "PJ" : "PF",
    documento: entry.owner.cpfCnpj.replace(/\D/g, ""),
    razaoSocial: entry.owner.name,
    email: entry.owner.email || undefined,
    endereco: entry.owner.street ? {
      logradouro: entry.owner.street,
      numero: entry.owner.number || "S/N",
      complemento: entry.owner.complement || undefined,
      bairro: entry.owner.neighborhood || "",
      codigoMunicipio: ibge,
      uf: entry.owner.state || "RS",
      cep: (entry.owner.zipCode || "").replace(/\D/g, ""),
    } : undefined,
  };

  const servico: ServicoData = {
    codigoServico: settings.codigoServicoMunicipal,
    codigoMunicipioPrestacao: ibge,
    discriminacao: `Taxa de administracao imobiliaria${contract ? ` ref. contrato ${contract.code}` : ""}`,
    valorServicos: adminFeeValue || 1, // 1 reais minimo pra preview funcionar mesmo sem taxa
    aliquotaIss: settings.aliquotaIss || 2,
    issRetido: settings.retemIss,
  };

  const { xml: dpsXml, idDps } = buildDpsXml({
    ambiente,
    numeroSerie: "70000",
    numeroDps: nextNumeroDps,
    dhEmissao: new Date(),
    competencia,
    codigoMunicipioEmissao: ibge,
    prestador,
    tomador,
    servico,
  });

  const result: Record<string, unknown> = {
    ownerEntryId,
    ambiente,
    idDps,
    nextNumeroDps,
    adminFeeValue,
    aluguelBruto,
    dpsXml,
    notas: [
      "DPS sem assinatura — use ?signed=1 pra gerar a versao assinada (precisa do cert).",
      "Compare com um XML real autorizado pelo EmissorWeb pra validar estrutura.",
    ],
  };

  if (wantSigned) {
    if (!settings.certificadoPfx || !settings.certificadoPassword) {
      return NextResponse.json(
        { ...result, errorAssinatura: "Certificado A1 nao carregado — nao foi possivel assinar" },
        { status: 400 },
      );
    }
    try {
      const certPassword = decryptString(settings.certificadoPassword);
      const cert = extractPfx(Buffer.from(settings.certificadoPfx), certPassword);
      const signed = signDps({
        xml: dpsXml,
        idDps,
        privateKeyPem: cert.keyPem,
        certificatePem: cert.certPem,
      });
      result.signedXml = signed;
      result.certSubject = cert.subject;
      result.certCnpj = cert.cnpj;
      result.certValidUntil = cert.validUntil;
    } catch (err: any) {
      result.errorAssinatura = err?.message || "Erro ao assinar XML";
    }
  }

  // Permite forcar download como XML via ?format=xml
  if (searchParams.get("format") === "xml") {
    const xmlOut = (result.signedXml as string) || dpsXml;
    return new NextResponse(xmlOut, {
      status: 200,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Content-Disposition": `inline; filename="${idDps}.xml"`,
      },
    });
  }

  return NextResponse.json(result);
}
