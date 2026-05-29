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
import { getAliquotaParaCompetencia } from "@/lib/fiscal-aliquota";

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

  // Carrega contracts + property separadamente (FK sem @relation no schema)
  const contractIds = entriesRaw
    .map((e) => e.contractId)
    .filter((id): id is string => !!id);
  const contracts = contractIds.length > 0
    ? await prisma.contract.findMany({
        where: { id: { in: contractIds } },
        select: {
          id: true,
          code: true,
          rentalValue: true,
          adminFeePercent: true,
          propertyId: true,
          property: {
            select: {
              id: true,
              street: true,
              number: true,
              complement: true,
              neighborhood: true,
              city: true,
              state: true,
              zipCode: true,
              iptuNumber: true,
              registrationNumber: true,
              type: true,
            },
          },
        },
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

  // Reserva uma faixa de numeros de DPS de forma atomica.
  // Antes: cada iteracao fazia findFirst({ orderBy: createdAt }) e somava 1,
  // o que pegava o mesmo numero quando 2 emissoes rodavam concorrentes
  // (race condition) ou quando uma emissao em lote registrava a invoice
  // depois do proximo loop ja ter lido o "lastInvoice".
  // Agora: 1 update atomico no comeco reserva [start..start+N-1] e cada
  // entry usa start+i. Se uma emissao falhar, o numero "fica queimado"
  // (gap), o que e aceitavel — a SEFIN permite gaps na sequencia DPS.
  const reservedCounter = await prisma.fiscalSettings.update({
    where: { id: settings.id },
    data: { nextNfDpsNumero: { increment: ownerEntryIds.length } },
    select: { nextNfDpsNumero: true },
  });
  const startNumero = reservedCounter.nextNfDpsNumero - ownerEntryIds.length + 1;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const nextNumeroDps = startNumero + i;
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

    // Calcula a taxa adm em cascata de fallbacks:
    //   0. Override manual (digitado na tela de Pre-validacao)
    //   1. JSON notes do entry (adminFeeValue salvo pelo billing)
    //   2. aluguelBruto * adminFeePercent
    //   3. OwnerEntry irmao INTERMEDIACAO no mesmo contract+owner+mes
    //   4. INTERMEDIACAO SOLTA no mesmo owner+mes (sem contract match)
    //   5. DEBITO description ~ "taxa adm" / "intermediacao" / "administracao"
    let adminFeeValue = 0;
    let adminFeeOrigem = "MISSING";
    let adminFeePercent = entry.contract?.adminFeePercent || 10;
    let aluguelBruto = 0;

    // 0. Override manual (AppSetting populado via UI de pre-validacao)
    if (entry.dueDate) {
      const oy = entry.dueDate.getFullYear();
      const om = entry.dueDate.getMonth() + 1;
      const overrideKey = `nf_value_override_${oy}_${String(om).padStart(2, "0")}`;
      const groupKey = `${entry.contractId || "NULL"}_${oy}-${String(om).padStart(2, "0")}_${entry.ownerId}`;
      const overrideSetting = await prisma.appSetting.findUnique({ where: { key: overrideKey } });
      if (overrideSetting) {
        try {
          const overrides: Record<string, number> = JSON.parse(overrideSetting.value);
          if (typeof overrides[groupKey] === "number" && overrides[groupKey] > 0) {
            adminFeeValue = overrides[groupKey];
            adminFeeOrigem = "MANUAL_OVERRIDE";
          }
        } catch { /* ignore */ }
      }
    }

    if (!adminFeeValue && entry.notes) {
      try {
        const n = JSON.parse(entry.notes);
        if (typeof n.adminFeeValue === "number") {
          adminFeeValue = n.adminFeeValue;
          adminFeeOrigem = "REPASSE_NOTES";
        }
        if (typeof n.adminFeePercent === "number") adminFeePercent = n.adminFeePercent;
        if (typeof n.aluguelBruto === "number") aluguelBruto = n.aluguelBruto;
      } catch {
        // ignore
      }
    }
    if (!adminFeeValue && entry.contract && aluguelBruto) {
      adminFeeValue = Math.round(aluguelBruto * (adminFeePercent / 100) * 100) / 100;
      adminFeeOrigem = "REPASSE_CALC";
    }
    // Fallback: lancamentos manuais — busca entries irmas
    if (!adminFeeValue && entry.dueDate) {
      const inicio = new Date(entry.dueDate.getFullYear(), entry.dueDate.getMonth(), 1);
      const fim = new Date(entry.dueDate.getFullYear(), entry.dueDate.getMonth() + 1, 1);

      // 3. INTERMEDIACAO mesmo contract+owner+mes
      const intermediacao = entry.contractId
        ? await prisma.ownerEntry.findFirst({
            where: {
              ownerId: entry.ownerId,
              contractId: entry.contractId,
              category: "INTERMEDIACAO",
              dueDate: { gte: inicio, lt: fim },
              status: { not: "CANCELADO" },
            },
            select: { value: true },
          })
        : null;
      if (intermediacao?.value) {
        adminFeeValue = Number(intermediacao.value);
        adminFeeOrigem = "INTERMEDIACAO_ENTRY";
      }

      // 4. INTERMEDIACAO SOLTA (qualquer contract, mesmo owner+mes)
      if (!adminFeeValue) {
        const solta = await prisma.ownerEntry.findFirst({
          where: {
            ownerId: entry.ownerId,
            category: "INTERMEDIACAO",
            dueDate: { gte: inicio, lt: fim },
            status: { not: "CANCELADO" },
            NOT: { id: entry.id },
          },
          select: { value: true },
        });
        if (solta?.value) {
          adminFeeValue = Number(solta.value);
          adminFeeOrigem = "INTERMEDIACAO_SOLTA";
        }
      }

      // 5. DEBITO de TAXA_ADM (description match) mesmo owner
      if (!adminFeeValue) {
        const debito = await prisma.ownerEntry.findFirst({
          where: {
            ownerId: entry.ownerId,
            type: "DEBITO",
            dueDate: { gte: inicio, lt: fim },
            status: { not: "CANCELADO" },
            OR: [
              { description: { contains: "taxa adm" } },
              { description: { contains: "Taxa Adm" } },
              { description: { contains: "intermedia" } },
              { description: { contains: "Intermedia" } },
              { description: { contains: "administra" } },
              { description: { contains: "Administra" } },
            ],
          },
          select: { value: true },
        });
        if (debito?.value) {
          adminFeeValue = Number(debito.value);
          adminFeeOrigem = "DEBITO_TAXA_ADM";
        }
      }

      // 6. COPROPRIETARIO: busca INTERMEDIACAO DEBITO no MESMO CONTRATO
      // (qualquer owner — geralmente o owner principal) e aplica share ratio.
      // Necessario porque billing cria 1 INTERMEDIACAO DEBITO so no owner
      // principal com valor TOTAL.
      if (!adminFeeValue && entry.contractId) {
        // Resolve share do owner via PropertyOwner ou notes.sharePercent
        let sharePercent = 100;
        if (entry.contract?.propertyId) {
          const propOwner = await prisma.propertyOwner.findFirst({
            where: { propertyId: entry.contract.propertyId, ownerId: entry.ownerId },
            select: { percentage: true },
          });
          if (propOwner) sharePercent = propOwner.percentage;
        }
        if (sharePercent === 100 && entry.notes) {
          try {
            const n = JSON.parse(entry.notes);
            if (typeof n.sharePercent === "number" && n.sharePercent > 0 && n.sharePercent < 100) {
              sharePercent = n.sharePercent;
            }
          } catch { /* ignore */ }
        }
        if (sharePercent < 100) {
          const sameContractDebito = await prisma.ownerEntry.findFirst({
            where: {
              contractId: entry.contractId,
              type: "DEBITO",
              dueDate: { gte: inicio, lt: fim },
              status: { not: "CANCELADO" },
              ownerId: { not: entry.ownerId },
              OR: [
                { category: "INTERMEDIACAO" },
                { description: { contains: "taxa adm" } },
                { description: { contains: "Taxa Adm" } },
                { description: { contains: "intermedia" } },
                { description: { contains: "Intermedia" } },
                { description: { contains: "administra" } },
                { description: { contains: "Administra" } },
              ],
            },
            select: { value: true },
          });
          if (sameContractDebito?.value) {
            const total = Number(sameContractDebito.value);
            adminFeeValue = Math.round(total * (sharePercent / 100) * 100) / 100;
            adminFeeOrigem = "DEBITO_TAXA_ADM_COPROP";
          }
        }
      }
    }
    if (!adminFeeValue) {
      results.push({
        ownerEntryId: entry.id,
        ownerName: entry.owner.name,
        success: false,
        error: "Nao foi possivel determinar o valor da taxa de administracao. " +
          "Cadastre um lancamento de INTERMEDIACAO no mesmo mes/owner com o valor da taxa, " +
          "ou adicione `{\"adminFeeValue\": XXX}` no campo de observacoes deste lancamento.",
      });
      continue;
    }

    const tomadorTipo = entry.owner.personType === "PJ" ? "PJ" : "PF";
    const tomadorDoc = entry.owner.cpfCnpj.replace(/\D/g, "");
    const competencia = entry.dueDate
      ? `${entry.dueDate.getFullYear()}-${String(entry.dueDate.getMonth() + 1).padStart(2, "0")}`
      : null;

    // Resolve aliquota efetiva da competencia: tabela mensal > global > 2%
    const compAno = entry.dueDate?.getFullYear() ?? new Date().getFullYear();
    const compMes = (entry.dueDate?.getMonth() ?? new Date().getMonth()) + 1;
    const aliqEfetiva = await getAliquotaParaCompetencia(
      compAno,
      compMes,
      settings.aliquotaIss,
      settings.simplesAliquota,
    );

    // nextNumeroDps ja foi reservado atomicamente acima do loop (vide
    // FiscalSettings.nextNfDpsNumero). Garante sequencia sem race.

    // Discriminacao reaproveitada nos dois caminhos (Spedy + Gov) e nos
    // upserts de Invoice (PROCESSANDO/REJEITADA/AUTORIZADA).
    const discriminacao = `Taxa de administracao imobiliaria${entry.contract ? ` ref. contrato ${entry.contract.code}` : ""}${competencia ? ` - competencia ${competencia}` : ""}`;
    // Dados base do Invoice (campos NOT NULL) — usados em todos os upserts
    // do ciclo dessa entry (PROCESSANDO, REJEITADA, AUTORIZADA).
    const invoiceBase = {
      prestadorCnpj: settings.cnpj.replace(/\D/g, ""),
      prestadorIm: settings.inscricaoMunicipal,
      prestadorNome: settings.razaoSocial || "SOMMA IMOVEIS LTDA",
      tomadorTipo,
      tomadorDoc,
      tomadorNome: entry.owner.name,
      tomadorEmail: entry.owner.email,
      codigoServico: settings.codigoServicoMunicipal,
      discriminacao,
      valorServicos: adminFeeValue,
      aliquotaIss: aliqEfetiva.aliquotaIss,
      valorIss: settings.retemIss
        ? Math.round(adminFeeValue * aliqEfetiva.aliquotaIss / 100 * 100) / 100
        : 0,
      issRetido: settings.retemIss,
      regimeTributario: settings.regimeTributario,
      ownerId: entry.owner.id,
      contractId: entry.contractId,
      ownerEntryId: entry.id,
      competencia,
      ambiente,
      createdById: auth.user.id,
    } as const;

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
        const aliquota = aliqEfetiva.aliquotaIss / 100; // decimal (usa MENSAL > GLOBAL > 2%)
        const issAmount = Math.round(adminFeeValue * aliquota * 100) / 100;
        // No Padrao Nacional, prestador Simples Nacional (ME/EPP) NAO pode
        // informar aliquota nem valor de ISS quando nao ha retencao —
        // o ISS eh recolhido via DAS, nao destacado. Erro E0625.
        // Quando regime eh SIMPLES_NACIONAL e nao ha retencao, omitimos
        // issRate e issAmount; em regime normal seguem normalmente.
        const isSimplesNacional = (settings.regimeTributario || "").toUpperCase() === "SIMPLES_NACIONAL"
          || settings.optanteSimples === true;
        const enviarISS = !isSimplesNacional || !!settings.retemIss;
        // BUG FIX: antes mandavamos sempre o IBGE da empresa (SC do Sul) com
        // nome/estado do owner — combinação inconsistente que disparava E0240
        // pra owners de outro estado. Agora busca IBGE do MUNICIPIO DO OWNER.
        // Quando nao acha (cidade nao mapeada) → null e omitimos address.
        const tomadorIbge = entry.owner.city && entry.owner.state
          ? getIbgeCode(entry.owner.city, entry.owner.state)
          : null;
        const tomadorEnderecoCidade = tomadorIbge
          ? {
              code: tomadorIbge,
              name: entry.owner.city || "",
              state: (entry.owner.state || "").toUpperCase(),
            }
          : null;

        // integrationId tem que ser unico por tentativa pra Spedy nao
        // rejeitar com "ja existe nota com esse integrationId" em reemissoes.
        // Schema: <30 chars do entry.id>-<5 chars timestamp base36>. Total <=36.
        const integrationId = `${entry.id.slice(0, 30)}-${Date.now().toString(36).slice(-5)}`;

        // effectiveDate alimenta TANTO dhEmi (emissao) QUANTO dCompet
        // (competencia) no XML do Padrao Nacional. A Spedy nao tem campo
        // separado pra cada um. Como queremos a competencia certa (mes do
        // entry.dueDate, ex: abril/2026), usamos o ultimo dia do mes da
        // dueDate. Se a entry nao tem dueDate, fallback pra agora.
        const competenciaDate = entry.dueDate
          ? new Date(entry.dueDate.getFullYear(), entry.dueDate.getMonth() + 1, 0, 12, 0, 0)
          : new Date();

        // === Resolve PROPERTY para ibsCbs (cascata) ===
        // A Spedy/Padrao Nacional EXIGE bloco property no ibsCbs quando o
        // servico eh imobiliario (LC 10.05) e Reforma Tributaria esta ON.
        // Sem isso, erro E0932. Cascata de fontes:
        //   1. Override manual (AppSetting nf_property_override_YYYY_MM)
        //   2. entry.contract.property (via contractId join)
        //   3. entry.propertyId direto (caso vinculado sem contract)
        //   4. Property unica do owner (se o owner tem so 1 imovel)
        type PropertyForNF = {
          street: string | null;
          number: string | null;
          complement?: string | null;
          neighborhood: string | null;
          city: string | null;
          state: string | null;
          zipCode: string | null;
        };
        let propertyForNF: PropertyForNF | null = entry.contract?.property
          ? entry.contract.property
          : null;
        let propertyOrigin = propertyForNF ? "CONTRACT" : null;

        // 1. Property override do AppSetting
        if (entry.dueDate) {
          const py = entry.dueDate.getFullYear();
          const pm = entry.dueDate.getMonth() + 1;
          const propOverrideKey = `nf_property_override_${py}_${String(pm).padStart(2, "0")}`;
          const groupKey = `${entry.contractId || "NULL"}_${py}-${String(pm).padStart(2, "0")}_${entry.ownerId}`;
          const propOverrideSetting = await prisma.appSetting.findUnique({ where: { key: propOverrideKey } });
          if (propOverrideSetting) {
            try {
              const overrides: Record<string, string> = JSON.parse(propOverrideSetting.value);
              const overridePropertyId = overrides[groupKey];
              if (overridePropertyId) {
                const overrideProperty = await prisma.property.findUnique({
                  where: { id: overridePropertyId },
                  select: {
                    street: true, number: true, complement: true,
                    neighborhood: true, city: true, state: true, zipCode: true,
                  },
                });
                if (overrideProperty) {
                  propertyForNF = overrideProperty;
                  propertyOrigin = "OVERRIDE";
                }
              }
            } catch { /* ignore */ }
          }
        }

        // 2. entry.propertyId direto
        if (!propertyForNF && entry.propertyId) {
          const direct = await prisma.property.findUnique({
            where: { id: entry.propertyId },
            select: {
              street: true, number: true, complement: true,
              neighborhood: true, city: true, state: true, zipCode: true,
            },
          });
          if (direct) { propertyForNF = direct; propertyOrigin = "ENTRY_DIRECT"; }
        }

        // 3. Owner com apenas 1 propriedade
        if (!propertyForNF) {
          const ownerProperties = await prisma.property.findMany({
            where: { ownerId: entry.ownerId, active: true },
            select: {
              id: true, street: true, number: true, complement: true,
              neighborhood: true, city: true, state: true, zipCode: true,
            },
            take: 2,
          });
          if (ownerProperties.length === 1) {
            propertyForNF = ownerProperties[0];
            propertyOrigin = "OWNER_UNIQUE";
          }
        }

        void propertyOrigin; // future: log/expor em result

        try {
          const created = await emitirNFSeSpedy({
            ambiente: ambiente as SpedyAmbiente,
            apiKey: spedyApiKey,
            body: {
              effectiveDate: competenciaDate.toISOString().slice(0, 19),
              sendEmailToCustomer: !!entry.owner.email,
              description: discriminacao,
              federalServiceCode: settings.codigoServicoMunicipal || "1.05",
              // NAO enviar cityServiceCode no body — deixa a Spedy usar o
              // codigo cTribMun cadastrado no PAINEL dela (que tem formato
              // municipal sem ponto, ex: '1005' pra SC do Sul). Enviar aqui
              // sobrescreve com o mesmo valor LC (com ponto, ex: '10.05')
              // que a prefeitura rejeita por pattern invalido no cTribMun.
              cityServiceCode: undefined,
              taxationType: "taxationInMunicipality",
              integrationId,
              receiver: ((): {
                name: string;
                federalTaxNumber: string;
                email?: string;
                address?: {
                  street: string; number: string; complement?: string;
                  district: string; city: { code: string; name: string; state: string };
                  postalCode?: string;
                };
              } => {
                // E0240: 'CEP do tomador nao existe / nao pertence ao
                // municipio'. Quando o CEP do owner eh invalido, OU o
                // codigo IBGE do municipio nao esta mapeado, OMITIMOS
                // address — Spedy ja esta configurada pra 'Emitir sem
                // endereco do cliente'. Melhor sem endereco do que
                // rejeicao por inconsistencia.
                const cepClean = (entry.owner.zipCode || "").replace(/\D/g, "");
                const cepValido = cepClean.length === 8 && !/^0+$/.test(cepClean);
                const enderecoCompleto = !!(
                  entry.owner.street &&
                  entry.owner.city &&
                  cepValido &&
                  tomadorEnderecoCidade // null quando cidade nao tem IBGE mapeado
                );
                return {
                  name: entry.owner.name,
                  federalTaxNumber: tomadorDoc,
                  email: entry.owner.email || undefined,
                  address: enderecoCompleto
                    ? {
                        street: entry.owner.street!,
                        number: entry.owner.number || "S/N",
                        complement: entry.owner.complement || undefined,
                        district: entry.owner.neighborhood || "Centro",
                        city: tomadorEnderecoCidade!,
                        postalCode: cepClean,
                      }
                    : undefined,
                };
              })(),
              total: {
                invoiceAmount: adminFeeValue,
                ...(enviarISS ? { issRate: aliquota, issAmount } : {}),
                issWithheld: !!settings.retemIss,
              },
              // ibsCbs: bloco da Reforma Tributaria (LC 214/2025). Exigido
              // pela Spedy quando "Habilitar campos da Reforma Tributaria"
              // esta ON e o servico eh imobiliario (LC 10.05). Sem isso,
              // erro E0932: "obrigatorio grupo de informacoes do imovel".
              // Property vem do Contract.property associado a esta entry.
              ibsCbs: propertyForNF ? {
                cst: 200,
                classification: 200046,
                operationIndicatorCode: "020301",
                isPersonalUse: false,
                operationType: "supplyWithSubsequentPayment",
                property: {
                  address: {
                    street: propertyForNF.street || "",
                    number: propertyForNF.number || "S/N",
                    complement: propertyForNF.complement || undefined,
                    district: propertyForNF.neighborhood || "Centro",
                    postalCode: (propertyForNF.zipCode || "").replace(/\D/g, ""),
                    city: {
                      name: propertyForNF.city || "Santa Cruz do Sul",
                      state: propertyForNF.state || "RS",
                    },
                    country: "BR",
                  },
                },
              } : undefined,
            },
          });

          // FIX: persiste Invoice como PROCESSANDO ANTES do polling.
          // Antes: invoice so era criada apos polling terminar — webhook
          // chegando no meio do polling tentava update sem find e perdia
          // o evento. Agora o registro ja existe com chaveAcesso=spedyId
          // assim que o POST cria o recurso na Spedy.
          await prisma.invoice.upsert({
            where: { ownerEntryId: entry.id },
            create: {
              ...invoiceBase,
              status: "PROCESSANDO",
              chaveAcesso: created.id,
              respostaXml: JSON.stringify(created),
            },
            update: {
              status: "PROCESSANDO",
              chaveAcesso: created.id,
              respostaXml: JSON.stringify(created),
              rejeicaoCodigo: null,
              rejeicaoMotivo: null,
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
              chaveAcesso: final.id, // mantem id pra cancel/check-status acharem o recurso
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
              : (aliqEfetiva.simplesAliquota ?? settings.simplesAliquota ?? undefined),
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
          discriminacao,
          valorServicos: adminFeeValue,
          aliquotaIss: aliqEfetiva.aliquotaIss,
          issRetido: settings.retemIss,
          municipioPrestacao: ibge || "4316808",
        },
        numeroDps: nextNumeroDps,
        competencia: competencia || undefined,
        });
      }

      if (!result.sucesso) {
        // FIX: persiste Invoice como REJEITADA em vez de descartar.
        // Antes: a falha so era reportada no array de results e a Invoice
        // sumia do banco — operador nao via histo na tela de notas.
        // Agora grava (ou atualiza, no caso Spedy onde ja existe como
        // PROCESSANDO) com status REJEITADA + codigo/motivo.
        try {
          await prisma.invoice.upsert({
            where: { ownerEntryId: entry.id },
            create: {
              ...invoiceBase,
              status: "REJEITADA",
              chaveAcesso: result.chaveAcesso,
              dpsXml: result.dpsXml,
              respostaXml: result.xmlRetorno,
              rejeicaoCodigo: result.rejeicaoCodigo,
              rejeicaoMotivo: result.rejeicaoMotivo,
            },
            update: {
              status: "REJEITADA",
              chaveAcesso: result.chaveAcesso,
              dpsXml: result.dpsXml,
              respostaXml: result.xmlRetorno,
              rejeicaoCodigo: result.rejeicaoCodigo,
              rejeicaoMotivo: result.rejeicaoMotivo,
            },
          });
        } catch (persistErr) {
          // Nao deixa erro de persistencia mascarar a falha original
          console.error(`[Invoice Emit] Falha ao persistir REJEITADA entry ${entry.id}:`, persistErr);
        }

        results.push({
          ownerEntryId: entry.id,
          ownerName: entry.owner.name,
          success: false,
          error: `${result.rejeicaoCodigo || "?"}: ${result.rejeicaoMotivo || "rejeitada"}`,
          dpsXml: result.dpsXml, // ajuda diagnostico de erros do gov
        });
        continue;
      }

      // Cria registro Invoice no banco (ou atualiza se ja existe).
      // No caminho Spedy, ja foi criado como PROCESSANDO antes do polling
      // — o upsert aqui atualiza pra AUTORIZADA com os dados finais.
      // No caminho NFSE_NACIONAL e a 1a vez (sem update intermediario).
      const invoice = await prisma.invoice.upsert({
        where: { ownerEntryId: entry.id },
        create: {
          ...invoiceBase,
          numero: result.numero,
          serie: result.serie,
          codigoVerificacao: result.codigoVerificacao,
          chaveAcesso: result.chaveAcesso,
          status: "AUTORIZADA",
          dataEmissao: new Date(),
          dpsXml: result.dpsXml,
          respostaXml: result.xmlRetorno,
          pdfUrl: result.pdfUrl,
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
      // Persiste falha inesperada como REJEITADA tb (com codigo EXC pra
      // distinguir da rejeicao "normal" vinda do provedor).
      try {
        await prisma.invoice.upsert({
          where: { ownerEntryId: entry.id },
          create: {
            ...invoiceBase,
            status: "REJEITADA",
            rejeicaoCodigo: "EXC",
            rejeicaoMotivo: err?.message || "Erro desconhecido",
          },
          update: {
            status: "REJEITADA",
            rejeicaoCodigo: "EXC",
            rejeicaoMotivo: err?.message || "Erro desconhecido",
          },
        });
      } catch (persistErr) {
        console.error(`[Invoice Emit] Falha ao persistir excecao entry ${entry.id}:`, persistErr);
      }

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
