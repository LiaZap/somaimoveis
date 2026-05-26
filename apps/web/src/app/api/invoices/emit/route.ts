import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, requirePagePermission, isAuthError } from "@/lib/api-auth";
import { decryptString, safeDecryptString } from "@/lib/crypto";
import { emitirNFSe, getIbgeCode, type Ambiente } from "@/lib/nfse-gov-br-client";
import {
  emitirNFSeSpedy,
  aguardarProcessamentoSpedy,
  type SpedyAmbiente,
} from "@/lib/nfse-spedy-client";

/**
 * POST /api/invoices/emit
 * Body: { ownerEntryIds: string[] }
 *
 * Emite uma NFS-e para cada OwnerEntry de REPASSE/GARANTIA listado.
 * Usa as configuracoes da FiscalSettings (cert + dados da empresa) e
 * o cliente NFS-e Nacional (gov.br).
 *
 * Por enquanto opera em modo MOCK (NFSE_MOCK=true por default em dev).
 * Em producao, defina NFSE_MOCK=false e tenha o certificado uploaded.
 */
export async function POST(request: NextRequest) {
  const auth = await requirePagePermission("notas_fiscais");
  if (isAuthError(auth)) return auth;

  const body = await request.json().catch(() => ({}));
  const ownerEntryIds: string[] = Array.isArray(body.ownerEntryIds)
    ? body.ownerEntryIds.filter((s: unknown) => typeof s === "string")
    : [];

  if (ownerEntryIds.length === 0) {
    return NextResponse.json(
      { error: "ownerEntryIds obrigatorio (array de IDs)" },
      { status: 400 },
    );
  }

  // Carrega FiscalSettings (precisa de cert + dados da empresa)
  const settings = await prisma.fiscalSettings.findFirst();
  if (!settings) {
    return NextResponse.json(
      { error: "Configuracoes fiscais nao definidas. Acesse /configuracoes/fiscal." },
      { status: 400 },
    );
  }

  if (!settings.cnpj || !settings.inscricaoMunicipal || !settings.codigoServicoMunicipal) {
    return NextResponse.json(
      {
        error: "Configuracoes fiscais incompletas. Faltam: " +
          [
            !settings.cnpj && "CNPJ",
            !settings.inscricaoMunicipal && "Inscricao Municipal",
            !settings.codigoServicoMunicipal && "Codigo de Servico Municipal",
          ].filter(Boolean).join(", "),
      },
      { status: 400 },
    );
  }

  const provedor = (settings.provedor || "NFSE_NACIONAL").toUpperCase();
  const isSpedy = provedor === "SPEDY";

  // Spedy usa apiToken; outros provedores usam certificado A1
  if (isSpedy) {
    if (!settings.apiToken) {
      return NextResponse.json(
        { error: "Chave de API Spedy nao configurada. Acesse /configuracoes/fiscal." },
        { status: 400 },
      );
    }
  } else {
    if (!settings.certificadoPfx || !settings.certificadoPassword) {
      return NextResponse.json(
        { error: "Certificado A1 nao carregado. Acesse /configuracoes/fiscal." },
        { status: 400 },
      );
    }
  }

  let certPassword: string = "";
  let spedyApiKey: string = "";
  try {
    if (isSpedy) {
      // safeDecrypt: tolera tokens salvos em texto plano (bug antigo)
      spedyApiKey = safeDecryptString(settings.apiToken!);
    } else {
      certPassword = decryptString(settings.certificadoPassword!);
    }
  } catch (err) {
    console.error("[Invoice Emit] Erro ao descriptografar segredo:", err);
    return NextResponse.json(
      {
        error: isSpedy
          ? "Erro ao acessar chave Spedy. Re-cadastre a chave em /configuracoes/fiscal."
          : "Erro ao acessar senha do certificado. Re-uploade o certificado.",
      },
      { status: 500 },
    );
  }

  // Ambiente: aceita override via body (util pra testes pontuais).
  // Default usa o configurado em settings.ambiente.
  const ambienteBody = typeof body.ambiente === "string" ? body.ambiente.toUpperCase() : null;
  const ambiente: Ambiente =
    ambienteBody === "PRODUCAO" ? "PRODUCAO" :
    ambienteBody === "HOMOLOGACAO" ? "HOMOLOGACAO" :
    settings.ambiente === "PRODUCAO" ? "PRODUCAO" : "HOMOLOGACAO";

  // Override do regime tributario somente pra teste/diagnostico (E0160).
  // Aceita "SIMPLES_NACIONAL" | "LUCRO_PRESUMIDO" | "LUCRO_REAL" | "MEI".
  // Se nao informado, usa o regime de fiscalSettings.
  const regimeOverride = typeof body.regimeTributarioOverride === "string"
    ? body.regimeTributarioOverride.toUpperCase()
    : null;

  // Override da aliquota efetiva do Simples Nacional. Util quando a
  // contadora informa uma aliquota diferente do que esta em fiscalSettings.
  // Aceita number ou string convertivel.
  const simplesAliquotaOverride = body.simplesAliquota != null && body.simplesAliquota !== ""
    ? Number(body.simplesAliquota)
    : null;

  // Carrega os owner entries
  const entriesRaw = await prisma.ownerEntry.findMany({
    where: { id: { in: ownerEntryIds } },
    include: {
      owner: true,
      invoice: true,
    },
  });

  // Carrega contracts separadamente (FK sem @relation no schema)
  const contractIds = entriesRaw
    .map((e) => e.contractId)
    .filter((id): id is string => !!id);
  const contracts = contractIds.length > 0
    ? await prisma.contract.findMany({
        where: { id: { in: contractIds } },
        select: { id: true, code: true, rentalValue: true, adminFeePercent: true },
      })
    : [];
  const contractMap = new Map(contracts.map((c) => [c.id, c]));

  const entries = entriesRaw.map((e) => ({
    ...e,
    contract: e.contractId ? contractMap.get(e.contractId) || null : null,
  }));

  const results: Array<{
    ownerEntryId: string;
    ownerName: string;
    success: boolean;
    invoiceId?: string;
    numero?: string;
    error?: string;
    dpsXml?: string; // ajuda diagnostico quando a Receita rejeita
  }> = [];

  const ibge = getIbgeCode(settings.city || "", settings.state || "RS");

  for (const entry of entries) {
    // Pula se ja tem NF emitida
    if (entry.invoice && entry.invoice.status === "AUTORIZADA") {
      results.push({
        ownerEntryId: entry.id,
        ownerName: entry.owner.name,
        success: false,
        error: "Ja possui NF emitida",
      });
      continue;
    }

    // Pula se proprietario marcou "nao declara imovel"
    // Reuniao 12/05/2026: caso de imoveis adquiridos ja alugados onde
    // o dono optou por nao declarar (assume risco fiscal).
    if ((entry.owner as any).naoDeclaraImob === true) {
      results.push({
        ownerEntryId: entry.id,
        ownerName: entry.owner.name,
        success: false,
        error: "Proprietario configurado como 'nao declara imovel' — NFS-e suprimida",
      });
      continue;
    }

    // Calcula a taxa adm a partir do notes do entry (foi salva pelo billing)
    let adminFeeValue = 0;
    let adminFeePercent = entry.contract?.adminFeePercent || 10;
    let aluguelBruto = 0;
    if (entry.notes) {
      try {
        const n = JSON.parse(entry.notes);
        if (typeof n.adminFeeValue === "number") adminFeeValue = n.adminFeeValue;
        if (typeof n.adminFeePercent === "number") adminFeePercent = n.adminFeePercent;
        if (typeof n.aluguelBruto === "number") aluguelBruto = n.aluguelBruto;
      } catch {
        // ignore
      }
    }
    if (!adminFeeValue && entry.contract && aluguelBruto) {
      adminFeeValue = Math.round(aluguelBruto * (adminFeePercent / 100) * 100) / 100;
    }
    if (!adminFeeValue) {
      results.push({
        ownerEntryId: entry.id,
        ownerName: entry.owner.name,
        success: false,
        error: "Nao foi possivel determinar o valor da taxa de administracao",
      });
      continue;
    }

    const tomadorTipo = entry.owner.personType === "PJ" ? "PJ" : "PF";
    const tomadorDoc = entry.owner.cpfCnpj.replace(/\D/g, "");
    const competencia = entry.dueDate
      ? `${entry.dueDate.getFullYear()}-${String(entry.dueDate.getMonth() + 1).padStart(2, "0")}`
      : null;

    // Numero sequencial da DPS — usa o proximo disponivel no banco
    const lastInvoice = await prisma.invoice.findFirst({
      orderBy: { createdAt: "desc" },
      select: { numero: true },
    });
    const nextNumeroDps = lastInvoice?.numero
      ? parseInt(lastInvoice.numero) + 1
      : 1;

    try {
      let result: {
        sucesso: boolean;
        numero?: string;
        serie?: string;
        codigoVerificacao?: string;
        chaveAcesso?: string;
        dpsXml?: string;
        xmlRetorno?: string;
        pdfUrl?: string;
        rejeicaoCodigo?: string;
        rejeicaoMotivo?: string;
        spedyId?: string;
      };

      if (isSpedy) {
        // ===== Provedor SPEDY =====
        const discriminacao = `Taxa de administracao imobiliaria${entry.contract ? ` ref. contrato ${entry.contract.code}` : ""}${competencia ? ` - competencia ${competencia}` : ""}`;
        const aliquota = (settings.aliquotaIss || 2) / 100; // decimal
        const issAmount = Math.round(adminFeeValue * aliquota * 100) / 100;
        const tomadorEnderecoCidade = ibge
          ? { code: ibge, name: entry.owner.city || "", state: entry.owner.state || "RS" }
          : { code: "4316808", name: "Santa Cruz do Sul", state: "RS" };

        try {
          const created = await emitirNFSeSpedy({
            ambiente: ambiente as SpedyAmbiente,
            apiKey: spedyApiKey,
            body: {
              effectiveDate: new Date().toISOString().slice(0, 19),
              sendEmailToCustomer: !!entry.owner.email,
              description: discriminacao,
              federalServiceCode: settings.codigoServicoMunicipal || "1.05",
              cityServiceCode: settings.codigoServicoMunicipal || undefined,
              taxationType: "taxationInMunicipality",
              integrationId: entry.id.slice(-36),
              receiver: {
                name: entry.owner.name,
                federalTaxNumber: tomadorDoc,
                email: entry.owner.email || undefined,
                address: entry.owner.street
                  ? {
                      street: entry.owner.street,
                      number: entry.owner.number || "S/N",
                      complement: entry.owner.complement || undefined,
                      district: entry.owner.neighborhood || "Centro",
                      city: tomadorEnderecoCidade,
                      postalCode: (entry.owner.zipCode || "").replace(/\D/g, "") || undefined,
                    }
                  : undefined,
              },
              total: {
                invoiceAmount: adminFeeValue,
                issRate: aliquota,
                issAmount,
                issWithheld: !!settings.retemIss,
              },
            },
          });

          // Aguarda processar (polling ate authorized/rejected)
          const final = await aguardarProcessamentoSpedy(
            ambiente as SpedyAmbiente,
            spedyApiKey,
            created.id,
            { maxTries: 8, intervalMs: 5000 },
          );

          const s = (final.status || "").toLowerCase();
          if (s === "authorized") {
            result = {
              sucesso: true,
              numero: String(final.number || ""),
              serie: final.rps?.series || "",
              codigoVerificacao: final.authorization?.protocol || "",
              chaveAcesso: final.id, // Spedy nao tem chave de 44 digitos; usa o id
              spedyId: final.id,
              dpsXml: undefined,
              xmlRetorno: JSON.stringify(final),
              pdfUrl: undefined,
            };
          } else {
            result = {
              sucesso: false,
              rejeicaoCodigo: final.processingDetail?.code || final.status,
              rejeicaoMotivo: final.processingDetail?.message || `Status final: ${final.status}`,
              spedyId: final.id,
              xmlRetorno: JSON.stringify(final),
            };
          }
        } catch (e: unknown) {
          const err = e as { status?: number; message?: string; body?: unknown };
          result = {
            sucesso: false,
            rejeicaoCodigo: String(err.status || "ERR"),
            rejeicaoMotivo: err.message || "Erro desconhecido",
            xmlRetorno: typeof err.body === "string" ? err.body : JSON.stringify(err.body || err),
          };
        }
      } else {
        // ===== Provedor NFSE_NACIONAL (gov.br) =====
        result = await emitirNFSe({
        ambiente,
        certificado: {
          pfx: Buffer.from(settings.certificadoPfx!),
          password: certPassword,
        },
        prestador: {
          cnpj: settings.cnpj.replace(/\D/g, ""),
          inscricaoMunicipal: settings.inscricaoMunicipal,
          razaoSocial: settings.razaoSocial || "SOMMA IMOVEIS LTDA",
          endereco: {
            logradouro: settings.street || "Rua Tenente Coronel Brito",
            numero: settings.number || "138",
            complemento: settings.complement || undefined,
            bairro: settings.neighborhood || "Centro",
            cidade: settings.city || "Santa Cruz do Sul",
            uf: settings.state || "RS",
            cep: (settings.zipCode || "96810-202").replace(/\D/g, ""),
          },
          regimeTributario: (regimeOverride || (settings.regimeTributario as any) || "SIMPLES_NACIONAL"),
          simplesAliquota:
            simplesAliquotaOverride && Number.isFinite(simplesAliquotaOverride) && simplesAliquotaOverride > 0
              ? simplesAliquotaOverride
              : settings.simplesAliquota || undefined,
        },
        tomador: {
          tipo: tomadorTipo,
          documento: tomadorDoc,
          nome: entry.owner.name,
          email: entry.owner.email || undefined,
          endereco: entry.owner.street ? {
            logradouro: entry.owner.street,
            numero: entry.owner.number || "S/N",
            complemento: entry.owner.complement || undefined,
            bairro: entry.owner.neighborhood || "",
            cidade: entry.owner.city || "",
            uf: entry.owner.state || "RS",
            cep: (entry.owner.zipCode || "").replace(/\D/g, ""),
          } : undefined,
        },
        servico: {
          codigoServico: settings.codigoServicoMunicipal,
          discriminacao: `Taxa de administracao imobiliaria${entry.contract ? ` ref. contrato ${entry.contract.code}` : ""}${competencia ? ` - competencia ${competencia}` : ""}`,
          valorServicos: adminFeeValue,
          aliquotaIss: settings.aliquotaIss || 2,
          issRetido: settings.retemIss,
          municipioPrestacao: ibge || "4316808",
        },
        numeroDps: nextNumeroDps,
        competencia: competencia || undefined,
        });
      }

      if (!result.sucesso) {
        results.push({
          ownerEntryId: entry.id,
          ownerName: entry.owner.name,
          success: false,
          error: `${result.rejeicaoCodigo || "?"}: ${result.rejeicaoMotivo || "rejeitada"}`,
          dpsXml: result.dpsXml, // ajuda diagnostico de erros do gov
        });
        continue;
      }

      // Cria registro Invoice no banco (ou atualiza se ja existe)
      const invoice = await prisma.invoice.upsert({
        where: { ownerEntryId: entry.id },
        create: {
          numero: result.numero,
          serie: result.serie,
          codigoVerificacao: result.codigoVerificacao,
          chaveAcesso: result.chaveAcesso,
          status: "AUTORIZADA",
          dataEmissao: new Date(),
          prestadorCnpj: settings.cnpj.replace(/\D/g, ""),
          prestadorIm: settings.inscricaoMunicipal,
          prestadorNome: settings.razaoSocial || "SOMMA IMOVEIS LTDA",
          tomadorTipo,
          tomadorDoc,
          tomadorNome: entry.owner.name,
          tomadorEmail: entry.owner.email,
          codigoServico: settings.codigoServicoMunicipal,
          discriminacao: `Taxa de administracao imobiliaria${entry.contract ? ` ref. contrato ${entry.contract.code}` : ""}${competencia ? ` - competencia ${competencia}` : ""}`,
          valorServicos: adminFeeValue,
          aliquotaIss: settings.aliquotaIss,
          valorIss: settings.retemIss ? Math.round(adminFeeValue * (settings.aliquotaIss || 2) / 100 * 100) / 100 : 0,
          issRetido: settings.retemIss,
          regimeTributario: settings.regimeTributario,
          dpsXml: result.dpsXml,
          respostaXml: result.xmlRetorno,
          pdfUrl: result.pdfUrl,
          ownerId: entry.owner.id,
          contractId: entry.contractId,
          ownerEntryId: entry.id,
          competencia,
          ambiente,
          createdById: auth.user.id,
        },
        update: {
          numero: result.numero,
          serie: result.serie,
          codigoVerificacao: result.codigoVerificacao,
          chaveAcesso: result.chaveAcesso,
          status: "AUTORIZADA",
          dataEmissao: new Date(),
          dpsXml: result.dpsXml,
          respostaXml: result.xmlRetorno,
          pdfUrl: result.pdfUrl,
          rejeicaoCodigo: null,
          rejeicaoMotivo: null,
        },
      });

      results.push({
        ownerEntryId: entry.id,
        ownerName: entry.owner.name,
        success: true,
        invoiceId: invoice.id,
        numero: result.numero,
      });
    } catch (err: any) {
      console.error(`[Invoice Emit] Erro na entry ${entry.id}:`, err);
      results.push({
        ownerEntryId: entry.id,
        ownerName: entry.owner.name,
        success: false,
        error: err?.message || "Erro desconhecido",
      });
    }
  }

  const success = results.filter((r) => r.success).length;
  const failed = results.length - success;

  return NextResponse.json({
    message: `Emissao concluida: ${success} sucesso, ${failed} falha(s).`,
    success,
    failed,
    results,
    ambiente,
    mockMode: process.env.NFSE_MOCK !== "false",
  });
}
