/**
 * GET /api/invoices/preview-audit?month=YYYY-MM
 *
 * Dry-run de emissão de NFs. Agrupa por (contractId, ano-mês) — modelo
 * Cenário B: 1 NF por contrato/mês (não por entry). Pra cada par,
 * calcula o valor da NF, busca dados de owner/property, valida tudo,
 * retorna relatório executivo SEM emitir nada.
 *
 * Use antes de clicar "Emitir" pra revisar o que vai sair.
 *
 * Validações:
 *   🔴 BLOQUEANTE — impede emissão
 *   🟡 AVISO      — emite mas com risco/observação
 *   ℹ️ INFO       — só informativo
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePagePermission, isAuthError } from "@/lib/api-auth";
import { getAliquotaParaCompetencia } from "@/lib/fiscal-aliquota";

type Severity = "BLOQUEANTE" | "AVISO" | "INFO";

interface Validation {
  severity: Severity;
  code: string;
  message: string;
}

interface AuditItem {
  // chave única
  contractId: string | null;
  ano: number;
  mes: number;

  // dados do owner (tomador)
  ownerId: string;
  ownerName: string;
  ownerCpfCnpj: string;
  ownerCpfCnpjValido: boolean;
  ownerDocLimpo: string; // só dígitos
  ownerEmail: string | null;
  ownerEnderecoOk: boolean;
  naoDeclaraImob: boolean;

  // dados do contrato
  contractCode: string | null;
  contractStatus: string | null;

  // contratos ATIVOS deste owner disponiveis pra vincular (quando entry esta
  // sem contrato e o usuario quer corrigir antes de emitir)
  availableContracts: Array<{
    id: string;
    code: string;
    status: string;
    propertyAddress: string | null;
  }>;

  // IDs dos OwnerEntries que originam essa NF (pra UI conseguir PATCH
  // contractId pra todos ao vincular)
  entryIds: string[];

  // dados do imóvel (ibsCbs.property)
  propertyId: string | null;
  propertyAddress: string | null;
  propertyEnderecoCompleto: boolean;

  // co-propriedade: % deste owner no imóvel
  sharePercent: number;       // ex: 100, 60, 40
  isCoproprietario: boolean;  // true se sharePercent < 100

  // valor da NF
  valorNF: number;
  valorOrigem:
    | "REPASSE_NOTES"
    | "REPASSE_CALC"
    | "INTERMEDIACAO_ENTRY"
    | "DEBITO_TAXA_ADM"           // novo: encontrado em DEBITO/owner/mes
    | "INTERMEDIACAO_SOLTA"        // novo: INTERMEDIACAO sem contract match
    | "DESCRIPTION_MATCH"          // novo: entry cuja description menciona taxa/admin/intermediacao
    | "MANUAL_OVERRIDE"            // novo: digitado pelo usuario no modal
    | "MISSING";

  // candidatos de valor que encontramos (pra debug/UI mostrar alternativas)
  candidatosValor: Array<{
    origem: string;
    value: number;
    entryId?: string;
    note?: string;
  }>;

  // alíquota
  aliquotaIss: number;
  aliquotaIssOrigem: "MENSAL" | "ANTERIOR" | "GLOBAL" | "DEFAULT";
  aliquotaCompetenciaUsada: string | null; // YYYY-MM se vier de ANTERIOR

  // entries que originam essa NF
  sourceEntries: Array<{
    id: string;
    category: string;
    value: number;
    dueDate: string;
  }>;

  // invoice já existente (se houver)
  invoiceExistente: {
    id: string;
    numero: string | null;
    status: string;
    chaveAcesso: string | null;
  } | null;

  // validações
  validations: Validation[];
  canEmit: boolean;
  hasWarnings: boolean;
  jaEmitida: boolean; // tem Invoice AUTORIZADA — categoria propria
}

function isValidCpfCnpj(doc: string): boolean {
  const onlyDigits = doc.replace(/\D/g, "");
  if (onlyDigits.length !== 11 && onlyDigits.length !== 14) return false;
  // todos os dígitos iguais (000000... / 111111...) = inválido
  if (/^(\d)\1+$/.test(onlyDigits)) return false;
  return true;
}

/**
 * POST /api/invoices/preview-audit
 * Body: { month: "YYYY-MM", overrides: { "<groupKey>": number | null } }
 *
 * groupKey = "<contractId|NULL>_<YYYY-MM>_<ownerId>" — mesmo formato usado
 * internamente no GET. Salva como AppSetting.
 *
 * Passar `null` em algum key REMOVE o override.
 */
export async function POST(request: NextRequest) {
  const auth = await requirePagePermission("notas_fiscais");
  if (isAuthError(auth)) return auth;

  const body = await request.json().catch(() => ({}));
  const { month, overrides } = body as { month?: string; overrides?: Record<string, number | null> };

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "month invalido" }, { status: 400 });
  }
  if (!overrides || typeof overrides !== "object") {
    return NextResponse.json({ error: "overrides obrigatorio (objeto)" }, { status: 400 });
  }

  const [y, m] = month.split("-").map(Number);
  const key = `nf_value_override_${y}_${String(m).padStart(2, "0")}`;

  const existing = await prisma.appSetting.findUnique({ where: { key } });
  const current: Record<string, number> = existing ? JSON.parse(existing.value) : {};

  // Aplica diff: number > 0 salva; null/0 remove
  let added = 0;
  let removed = 0;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null || v === 0) {
      if (k in current) { delete current[k]; removed++; }
    } else if (typeof v === "number" && v > 0) {
      current[k] = Math.round(v * 100) / 100;
      added++;
    }
  }

  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(current) },
    update: { value: JSON.stringify(current) },
  });

  return NextResponse.json({ ok: true, added, removed, totalOverrides: Object.keys(current).length });
}

export async function GET(request: NextRequest) {
  const auth = await requirePagePermission("notas_fiscais");
  if (isAuthError(auth)) return auth;

  const url = new URL(request.url);
  const month = url.searchParams.get("month");
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json(
      { error: "Informe ?month=YYYY-MM" },
      { status: 400 },
    );
  }

  const [y, m] = month.split("-").map(Number);
  const inicio = new Date(y, m - 1, 1);
  const fim = new Date(y, m, 1);

  // Configurações fiscais
  const settings = await prisma.fiscalSettings.findFirst();
  if (!settings) {
    return NextResponse.json(
      { error: "FiscalSettings não configurado" },
      { status: 400 },
    );
  }

  // Carrega TODAS as entries relevantes do mês (REPASSE + INTERMEDIACAO)
  const entries = await prisma.ownerEntry.findMany({
    where: {
      type: "CREDITO",
      category: { in: ["REPASSE", "INTERMEDIACAO"] },
      dueDate: { gte: inicio, lt: fim },
      status: { not: "CANCELADO" },
    },
    include: {
      owner: {
        select: {
          id: true, name: true, cpfCnpj: true, personType: true,
          street: true, number: true, neighborhood: true, city: true,
          state: true, zipCode: true, email: true,
          naoDeclaraImob: true,
        },
      },
      invoice: {
        select: {
          id: true, numero: true, status: true, chaveAcesso: true,
        },
      },
    },
  });

  // Agrupa por NF a emitir.
  // - Quando tem contractId: 1 NF por (contractId, ano-mes, ownerId)
  //   (REPASSE + INTERMEDIACAO irmas viram 1 NF)
  // - Quando NAO tem contractId: 1 NF por entry.id (cada lancamento manual
  //   vira sua propria NF — evita consolidar varios contratos diferentes
  //   do mesmo owner em 1 unico item, o que perderia a divisao por contrato)
  const groups = new Map<string, typeof entries>();
  for (const e of entries) {
    const key = e.contractId
      ? `${e.contractId}_${y}-${String(m).padStart(2, "0")}_${e.ownerId}`
      : `entry_${e.id}_${y}-${String(m).padStart(2, "0")}_${e.ownerId}`;
    const arr = groups.get(key) || [];
    arr.push(e);
    groups.set(key, arr);
  }

  // Busca contracts + properties dos grupos
  const contractIds = [...new Set(entries.map((e) => e.contractId).filter((id): id is string => !!id))];
  const contracts = contractIds.length > 0
    ? await prisma.contract.findMany({
        where: { id: { in: contractIds } },
        select: {
          id: true, code: true, status: true,
          rentalValue: true, adminFeePercent: true,
          property: {
            select: {
              id: true, street: true, number: true, complement: true,
              neighborhood: true, city: true, state: true, zipCode: true,
              type: true,
            },
          },
        },
      })
    : [];
  const contractMap = new Map(contracts.map((c) => [c.id, c]));

  // Pre-carrega TODOS os contratos ATIVOS dos owners (pra UI mostrar como
  // opcoes quando o entry esta sem contrato vinculado).
  const ownerIdsForContracts = [...new Set(entries.map((e) => e.ownerId))];
  const availableContractsAll = ownerIdsForContracts.length > 0
    ? await prisma.contract.findMany({
        where: {
          ownerId: { in: ownerIdsForContracts },
          status: { in: ["ATIVO", "PENDENTE_RENOVACAO"] },
        },
        select: {
          id: true, code: true, status: true, ownerId: true,
          property: { select: { id: true, street: true, number: true, city: true } },
        },
      })
    : [];
  const availableContractsByOwner = new Map<string, typeof availableContractsAll>();
  for (const c of availableContractsAll) {
    const arr = availableContractsByOwner.get(c.ownerId) || [];
    arr.push(c);
    availableContractsByOwner.set(c.ownerId, arr);
  }

  // Pre-carrega entries auxiliares pra fallback de valor:
  // 1. TODOS os entries do mes (qualquer type/category) pra buscar matches
  //    por description ("taxa adm", "intermediação", "administração")
  // 2. DEBITOs do mes (qualquer category) por owner — pra buscar taxa adm
  //    cobrada do owner
  // Indexa por ownerId.
  const ownerIds = [...new Set(entries.map((e) => e.ownerId))];
  // Entries por owner (do mes) — pra fallback INTERMEDIACAO_SOLTA mesmo owner
  const allOwnerEntriesDoMes = ownerIds.length > 0
    ? await prisma.ownerEntry.findMany({
        where: {
          ownerId: { in: ownerIds },
          dueDate: { gte: inicio, lt: fim },
          status: { not: "CANCELADO" },
        },
        select: {
          id: true, ownerId: true, type: true, category: true,
          description: true, value: true, contractId: true, notes: true,
        },
      })
    : [];
  const entriesByOwner = new Map<string, typeof allOwnerEntriesDoMes>();
  for (const e of allOwnerEntriesDoMes) {
    const arr = entriesByOwner.get(e.ownerId) || [];
    arr.push(e);
    entriesByOwner.set(e.ownerId, arr);
  }

  // Entries por CONTRATO (do mes) — pra fallback de coproprietarios:
  // INTERMEDIACAO DEBITO eh criada SO no owner principal do contrato com
  // valor TOTAL; coproprietarios precisam buscar pelo contractId e
  // multiplicar pelo share deles.
  const entriesByContract = new Map<string, typeof allOwnerEntriesDoMes>();
  if (contractIds.length > 0) {
    const contractEntries = await prisma.ownerEntry.findMany({
      where: {
        contractId: { in: contractIds },
        dueDate: { gte: inicio, lt: fim },
        status: { not: "CANCELADO" },
      },
      select: {
        id: true, ownerId: true, type: true, category: true,
        description: true, value: true, contractId: true, notes: true,
      },
    });
    for (const e of contractEntries) {
      if (!e.contractId) continue;
      const arr = entriesByContract.get(e.contractId) || [];
      arr.push(e);
      entriesByContract.set(e.contractId, arr);
    }
  }

  // PropertyOwners: cota de cada owner em cada property (pra coproprietarios)
  const propertyIds = [...new Set(contracts.map((c) => c.property?.id).filter((id): id is string => !!id))];
  const propertyOwners = propertyIds.length > 0
    ? await prisma.propertyOwner.findMany({
        where: { propertyId: { in: propertyIds } },
        select: { propertyId: true, ownerId: true, percentage: true },
      })
    : [];
  // Index: propertyId -> ownerId -> percentage
  const sharesByProperty = new Map<string, Map<string, number>>();
  for (const po of propertyOwners) {
    if (!sharesByProperty.has(po.propertyId)) {
      sharesByProperty.set(po.propertyId, new Map());
    }
    sharesByProperty.get(po.propertyId)!.set(po.ownerId, po.percentage);
  }

  // Pre-carrega override manual (AppSetting JSON por mes)
  const overrideKey = `nf_value_override_${y}_${String(m).padStart(2, "0")}`;
  const overrideSetting = await prisma.appSetting.findUnique({ where: { key: overrideKey } });
  const valueOverrides: Record<string, number> =
    overrideSetting ? JSON.parse(overrideSetting.value) : {};

  // Patterns pra match em description (case-insensitive)
  const TAXA_ADM_PATTERNS = /taxa.*adm|administra(c|ç)(a|ã)o|intermedia(c|ç)(a|ã)o|admin\s*fee|honor(a|á)rio/i;

  const items: AuditItem[] = [];

  for (const [, groupEntries] of groups) {
    // Pega entries dessa NF (1 contrato/mês = 1 NF)
    const repasse = groupEntries.find((e) => e.category === "REPASSE");
    const intermediacao = groupEntries.find((e) => e.category === "INTERMEDIACAO");
    const principal = repasse || intermediacao!;
    const owner = principal.owner;
    const contract = principal.contractId ? contractMap.get(principal.contractId) : null;
    const validations: Validation[] = [];

    // === SHARE (cota de co-propriedade) ===
    // Resolve qual % este owner tem no imovel. Default 100% (proprietario unico).
    // Ordem de busca:
    //   a) PropertyOwner.percentage (cadastro oficial)
    //   b) JSON notes.sharePercent do REPASSE (billing salva la)
    //   c) Description "(60%)" do REPASSE
    //   d) Default 100
    let sharePercent = 100;
    const propertyIdResolved = contract?.property?.id || null;
    if (propertyIdResolved) {
      const propShares = sharesByProperty.get(propertyIdResolved);
      if (propShares?.has(principal.ownerId)) {
        sharePercent = propShares.get(principal.ownerId)!;
      }
    }
    // Fallback: notes.sharePercent
    if (sharePercent === 100 && repasse?.notes) {
      try {
        const n = JSON.parse(repasse.notes);
        if (typeof n.sharePercent === "number" && n.sharePercent > 0 && n.sharePercent <= 100) {
          sharePercent = n.sharePercent;
        }
      } catch { /* ignore */ }
    }
    // Fallback: description "(N%)"
    if (sharePercent === 100 && principal.description) {
      const match = principal.description.match(/\((\d+(?:[.,]\d+)?)%\)/);
      if (match) {
        const p = parseFloat(match[1].replace(",", "."));
        if (p > 0 && p < 100) sharePercent = p;
      }
    }
    const shareRatio = sharePercent / 100;
    const isCoproprietario = sharePercent < 100;
    const proportional = (totalValue: number) =>
      Math.round(totalValue * shareRatio * 100) / 100;

    // Calcula valor da NF — cascata de fallbacks
    let valorNF = 0;
    let valorOrigem: AuditItem["valorOrigem"] = "MISSING";
    const candidatosValor: AuditItem["candidatosValor"] = [];
    const ownerEntries = entriesByOwner.get(principal.ownerId) || [];
    const contractEntries = principal.contractId
      ? (entriesByContract.get(principal.contractId) || [])
      : [];

    // Chave do override = mesmo formato do group key
    //   com contract: "contractId_yyyymm_ownerId"
    //   sem contract: "entry_<id>_yyyymm_ownerId"
    const overrideKey = principal.contractId
      ? `${principal.contractId}_${y}-${String(m).padStart(2, "0")}_${principal.ownerId}`
      : `entry_${principal.id}_${y}-${String(m).padStart(2, "0")}_${principal.ownerId}`;
    const manualOverride = valueOverrides[overrideKey];

    // 0. MANUAL OVERRIDE tem prioridade máxima
    if (typeof manualOverride === "number" && manualOverride > 0) {
      valorNF = manualOverride;
      valorOrigem = "MANUAL_OVERRIDE";
      candidatosValor.push({ origem: "MANUAL_OVERRIDE", value: manualOverride, note: "Digitado pelo usuario" });
    }

    // 1. Tenta do JSON notes do REPASSE
    if (repasse?.notes) {
      try {
        const n = JSON.parse(repasse.notes);
        if (typeof n.adminFeeValue === "number" && n.adminFeeValue > 0) {
          candidatosValor.push({
            origem: "REPASSE_NOTES",
            value: n.adminFeeValue,
            entryId: repasse.id,
            note: `JSON notes do REPASSE adminFeeValue`,
          });
          if (valorOrigem === "MISSING") {
            valorNF = n.adminFeeValue;
            valorOrigem = "REPASSE_NOTES";
          }
        }
      } catch { /* ignore */ }
    }

    // 2. Calcula com aluguelBruto * percent (precisa de contract pra percent)
    if (repasse?.notes && contract) {
      try {
        const n = JSON.parse(repasse.notes);
        if (typeof n.aluguelBruto === "number") {
          const pct = (contract.adminFeePercent || 10);
          const calc = Math.round(n.aluguelBruto * (pct / 100) * 100) / 100;
          candidatosValor.push({
            origem: "REPASSE_CALC",
            value: calc,
            note: `aluguelBruto R$${n.aluguelBruto.toFixed(2)} × ${pct}%`,
          });
          if (valorOrigem === "MISSING") {
            valorNF = calc;
            valorOrigem = "REPASSE_CALC";
          }
        }
      } catch { /* ignore */ }
    }

    // 3. INTERMEDIACAO irmã (mesmo contract+owner+mes)
    if (intermediacao) {
      const v = Number(intermediacao.value);
      candidatosValor.push({
        origem: "INTERMEDIACAO_ENTRY",
        value: v,
        entryId: intermediacao.id,
        note: "Entry irmão de mesmo contrato",
      });
      if (valorOrigem === "MISSING" && v > 0) {
        valorNF = v;
        valorOrigem = "INTERMEDIACAO_ENTRY";
      }
    }

    // 4. INTERMEDIACAO SOLTA: qualquer INTERMEDIACAO do owner no mês (sem
    // match de contract). Útil quando o REPASSE foi cadastrado manual sem
    // contrato e a taxa adm foi como INTERMEDIACAO separada.
    const intermediacaoSolta = ownerEntries.filter(
      (e) => e.category === "INTERMEDIACAO" && e.id !== intermediacao?.id
    );
    for (const it of intermediacaoSolta) {
      const v = Number(it.value);
      candidatosValor.push({
        origem: "INTERMEDIACAO_SOLTA",
        value: v,
        entryId: it.id,
        note: `Mesmo owner/mes (contractId=${it.contractId || "null"})`,
      });
      if (valorOrigem === "MISSING" && v > 0) {
        valorNF = v;
        valorOrigem = "INTERMEDIACAO_SOLTA";
      }
    }

    // 5. DEBITO de TAXA_ADM / intermediação cobrada DESTE owner (mesmo ownerId)
    const debitos = ownerEntries.filter(
      (e) => e.type === "DEBITO" && TAXA_ADM_PATTERNS.test(e.description || "")
    );
    for (const d of debitos) {
      const v = Number(d.value);
      candidatosValor.push({
        origem: "DEBITO_TAXA_ADM",
        value: v,
        entryId: d.id,
        note: `DEBITO mesmo owner: "${(d.description || "").slice(0, 50)}"`,
      });
      if (valorOrigem === "MISSING" && v > 0) {
        valorNF = v;
        valorOrigem = "DEBITO_TAXA_ADM";
      }
    }

    // 5b. INTERMEDIACAO/DEBITO no MESMO CONTRATO mas owner DIFERENTE
    // (caso coproprietario): billing cria INTERMEDIACAO DEBITO so no owner
    // principal com valor TOTAL — coproprietarios precisam pegar e
    // multiplicar pelo proprio share.
    if (isCoproprietario && contractEntries.length > 0) {
      const sameContractDebitos = contractEntries.filter(
        (e) =>
          e.ownerId !== principal.ownerId &&
          e.type === "DEBITO" &&
          (e.category === "INTERMEDIACAO" || TAXA_ADM_PATTERNS.test(e.description || ""))
      );
      for (const d of sameContractDebitos) {
        const valorTotal = Number(d.value);
        const valorProporcional = proportional(valorTotal);
        candidatosValor.push({
          origem: "DEBITO_TAXA_ADM",
          value: valorProporcional,
          entryId: d.id,
          note: `Coprop ${sharePercent}%: TOTAL R$${valorTotal.toFixed(2)} × ${sharePercent}% (DEBITO mesmo contrato, owner principal)`,
        });
        if (valorOrigem === "MISSING" && valorProporcional > 0) {
          valorNF = valorProporcional;
          valorOrigem = "DEBITO_TAXA_ADM";
        }
      }
    }

    // 6. Description match em qualquer entry CREDITO/DEBITO do owner que não
    // seja o próprio REPASSE/INTERMEDIACAO (já considerados)
    const usedIds = new Set([repasse?.id, intermediacao?.id, ...intermediacaoSolta.map(e => e.id), ...debitos.map(e => e.id)].filter(Boolean));
    const descMatches = ownerEntries.filter(
      (e) => !usedIds.has(e.id) && TAXA_ADM_PATTERNS.test(e.description || "")
    );
    for (const dm of descMatches) {
      const v = Number(dm.value);
      candidatosValor.push({
        origem: "DESCRIPTION_MATCH",
        value: v,
        entryId: dm.id,
        note: `${dm.type}/${dm.category}: "${(dm.description || "").slice(0, 50)}"`,
      });
      if (valorOrigem === "MISSING" && v > 0) {
        valorNF = v;
        valorOrigem = "DESCRIPTION_MATCH";
      }
    }

    // Resolve alíquota
    const aliqEfetiva = await getAliquotaParaCompetencia(
      y, m,
      settings.aliquotaIss,
      settings.simplesAliquota,
    );

    // === VALIDAÇÕES ===

    // 🔴 BLOQUEANTES
    if (!owner.cpfCnpj) {
      validations.push({
        severity: "BLOQUEANTE",
        code: "OWNER_SEM_DOC",
        message: "Owner sem CPF/CNPJ cadastrado",
      });
    } else if (!isValidCpfCnpj(owner.cpfCnpj)) {
      validations.push({
        severity: "BLOQUEANTE",
        code: "OWNER_DOC_INVALIDO",
        message: `CPF/CNPJ inválido: ${owner.cpfCnpj}`,
      });
    }

    if (!owner.name || owner.name.trim().length < 3) {
      validations.push({
        severity: "BLOQUEANTE",
        code: "OWNER_SEM_NOME",
        message: "Owner sem nome",
      });
    }

    if (valorNF <= 0) {
      validations.push({
        severity: "BLOQUEANTE",
        code: "VALOR_INVALIDO",
        message: `Valor da NF zerado ou negativo: R$ ${valorNF.toFixed(2)}`,
      });
    }

    const jaEmitida = principal.invoice?.status === "AUTORIZADA";
    if (jaEmitida) {
      validations.push({
        severity: "INFO",
        code: "JA_EMITIDA",
        message: `Já tem NF AUTORIZADA (#${principal.invoice?.numero || "?"}) — categoria 'Emitidas'`,
      });
    }

    // 🟡 AVISOS
    if (!contract) {
      validations.push({
        severity: "AVISO",
        code: "SEM_CONTRATO",
        message: "Entry não tem contrato vinculado",
      });
    } else if (contract.status === "RESCINDIDO") {
      validations.push({
        severity: "AVISO",
        code: "CONTRATO_RESCINDIDO",
        message: `Contrato ${contract.code} está RESCINDIDO — deveria gerar NF?`,
      });
    }

    const propertyEnderecoCompleto = !!(
      contract?.property?.street &&
      contract.property.number &&
      contract.property.zipCode &&
      contract.property.city
    );
    if (!contract?.property) {
      validations.push({
        severity: "AVISO",
        code: "SEM_IMOVEL",
        message: "Contrato sem Property vinculado — ibsCbs.property será omitido (pode dar E0932 na prefeitura)",
      });
    } else if (!propertyEnderecoCompleto) {
      validations.push({
        severity: "AVISO",
        code: "IMOVEL_INCOMPLETO",
        message: "Imóvel sem endereço completo (faltam street/number/city/CEP)",
      });
    }

    if (aliqEfetiva.origem === "DEFAULT") {
      validations.push({
        severity: "AVISO",
        code: "ALIQUOTA_DEFAULT",
        message: "Nenhuma alíquota cadastrada — vai usar 2% padrão",
      });
    } else if (aliqEfetiva.origem === "ANTERIOR") {
      validations.push({
        severity: "INFO",
        code: "ALIQUOTA_FALLBACK",
        message: `Alíquota vem de ${aliqEfetiva.competenciaUsada?.ano}-${String(aliqEfetiva.competenciaUsada?.mes).padStart(2, "0")} (fallback do mês anterior)`,
      });
    }

    // INFO: coproprietario — valor da NF é proporcional à cota
    if (isCoproprietario) {
      validations.push({
        severity: "INFO",
        code: "COPROPRIETARIO",
        message: `Coproprietário (cota ${sharePercent}%) — valor da NF é proporcional. Verifique se há entries pros outros co-proprietários do mesmo imóvel.`,
      });
    }

    // Cross-check entre REPASSE.notes.adminFeeValue e INTERMEDIACAO.value
    if (repasse?.notes && intermediacao) {
      try {
        const n = JSON.parse(repasse.notes);
        if (typeof n.adminFeeValue === "number") {
          const diff = Math.abs(n.adminFeeValue - Number(intermediacao.value));
          if (diff > 0.01) {
            validations.push({
              severity: "AVISO",
              code: "DIVERGENCIA_VALOR",
              message: `Valor diverge: REPASSE.notes=R$${n.adminFeeValue.toFixed(2)} vs INTERMEDIACAO=R$${Number(intermediacao.value).toFixed(2)} (usando ${valorOrigem})`,
            });
          }
        }
      } catch { /* ignore */ }
    }

    if (owner.naoDeclaraImob) {
      validations.push({
        severity: "AVISO",
        code: "NAO_DECLARA",
        message: "Owner com 'não declara imóvel' — emissão será suprimida",
      });
    }

    const enderecoOwnerOk = !!(owner.street && owner.city);
    if (!enderecoOwnerOk) {
      validations.push({
        severity: "AVISO",
        code: "OWNER_SEM_ENDERECO",
        message: "Owner sem endereço — Spedy aceita, mas DIMOB pode reclamar",
      });
    }

    // ℹ️ INFO
    if (principal.invoice?.status === "CANCELADA") {
      validations.push({
        severity: "INFO",
        code: "RE_EMISSAO",
        message: `Re-emissão (NF anterior #${principal.invoice.numero || "?"} foi cancelada)`,
      });
    }
    if (principal.invoice?.status === "REJEITADA") {
      validations.push({
        severity: "INFO",
        code: "RE_TENTATIVA_APOS_REJEICAO",
        message: "Nova tentativa após rejeição anterior",
      });
    }

    const propertyAddress = contract?.property
      ? `${contract.property.street || ""}, ${contract.property.number || "S/N"}${contract.property.complement ? " " + contract.property.complement : ""} - ${contract.property.neighborhood || ""}, ${contract.property.city || ""}/${contract.property.state || ""}`
      : null;

    const blocking = validations.filter((v) => v.severity === "BLOQUEANTE");
    const warnings = validations.filter((v) => v.severity === "AVISO");

    items.push({
      contractId: principal.contractId,
      ano: y,
      mes: m,

      ownerId: owner.id,
      ownerName: owner.name,
      ownerCpfCnpj: owner.cpfCnpj || "",
      ownerCpfCnpjValido: isValidCpfCnpj(owner.cpfCnpj || ""),
      ownerDocLimpo: (owner.cpfCnpj || "").replace(/\D/g, ""),
      ownerEmail: owner.email,
      ownerEnderecoOk: enderecoOwnerOk,
      naoDeclaraImob: !!owner.naoDeclaraImob,

      contractCode: contract?.code || null,
      contractStatus: contract?.status || null,

      availableContracts: (availableContractsByOwner.get(principal.ownerId) || []).map((c) => ({
        id: c.id,
        code: c.code,
        status: c.status,
        propertyAddress: c.property
          ? `${c.property.street || ""}, ${c.property.number || "S/N"} - ${c.property.city || ""}`
          : null,
      })),
      entryIds: groupEntries.map((e) => e.id),

      propertyId: contract?.property?.id || null,
      propertyAddress,
      propertyEnderecoCompleto,

      sharePercent,
      isCoproprietario,

      valorNF,
      valorOrigem,
      candidatosValor,

      aliquotaIss: aliqEfetiva.aliquotaIss,
      aliquotaIssOrigem: aliqEfetiva.origem,
      aliquotaCompetenciaUsada: aliqEfetiva.competenciaUsada
        ? `${aliqEfetiva.competenciaUsada.ano}-${String(aliqEfetiva.competenciaUsada.mes).padStart(2, "0")}`
        : null,

      sourceEntries: groupEntries.map((e) => ({
        id: e.id,
        category: e.category,
        value: Number(e.value),
        dueDate: e.dueDate?.toISOString().slice(0, 10) || "",
      })),

      invoiceExistente: principal.invoice
        ? {
            id: principal.invoice.id,
            numero: principal.invoice.numero,
            status: principal.invoice.status,
            chaveAcesso: principal.invoice.chaveAcesso,
          }
        : null,

      validations,
      // canEmit: pode ser emitida agora. NF ja emitida (jaEmitida)
      // tambem nao eh emitivel — mas vai numa categoria propria
      // (nao bloqueada).
      canEmit: blocking.length === 0 && !owner.naoDeclaraImob && !jaEmitida,
      hasWarnings: warnings.length > 0,
      jaEmitida,
    });
  }

  // Ordena por owner, depois contrato
  items.sort((a, b) => {
    const o = a.ownerName.localeCompare(b.ownerName, "pt-BR");
    if (o !== 0) return o;
    return (a.contractCode || "").localeCompare(b.contractCode || "");
  });

  // Summary
  const summary = {
    month,
    totalItens: items.length,
    totalCanEmit: items.filter((i) => i.canEmit).length,
    totalJaEmitidas: items.filter((i) => i.jaEmitida).length,
    totalBloqueados: items.filter((i) => !i.canEmit && !i.jaEmitida && !i.naoDeclaraImob).length,
    totalComAvisos: items.filter((i) => i.hasWarnings && i.canEmit).length,
    totalSuprimidos: items.filter((i) => i.naoDeclaraImob).length,
    totalReEmissao: items.filter((i) =>
      i.invoiceExistente?.status === "CANCELADA" ||
      i.invoiceExistente?.status === "REJEITADA"
    ).length,
    valorTotalAEmitir: Number(
      items
        .filter((i) => i.canEmit)
        .reduce((sum, i) => sum + i.valorNF, 0)
        .toFixed(2)
    ),
    valorTotalJaEmitidas: Number(
      items
        .filter((i) => i.jaEmitida)
        .reduce((sum, i) => sum + i.valorNF, 0)
        .toFixed(2)
    ),
    valorTotalBloqueado: Number(
      items
        .filter((i) => !i.canEmit && !i.jaEmitida && !i.naoDeclaraImob)
        .reduce((sum, i) => sum + i.valorNF, 0)
        .toFixed(2)
    ),
    // Breakdown por owner
    porOwner: Array.from(
      items.reduce((acc, i) => {
        const cur = acc.get(i.ownerId) || {
          ownerId: i.ownerId,
          ownerName: i.ownerName,
          qtdNotas: 0,
          valorTotal: 0,
          qtdBloqueados: 0,
        };
        cur.qtdNotas += 1;
        cur.valorTotal = Number((cur.valorTotal + i.valorNF).toFixed(2));
        if (!i.canEmit) cur.qtdBloqueados += 1;
        acc.set(i.ownerId, cur);
        return acc;
      }, new Map<string, { ownerId: string; ownerName: string; qtdNotas: number; valorTotal: number; qtdBloqueados: number }>())
        .values()
    ).sort((a, b) => b.valorTotal - a.valorTotal),
  };

  return NextResponse.json({ summary, items });
}
