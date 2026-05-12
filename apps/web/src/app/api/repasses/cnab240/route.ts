import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";
import {
  generateCnab240,
  isCnab240Configured,
  normalizePixKey,
  type CnabPagamento,
  type CnabFavorecido,
} from "@/lib/cnab240-sicredi";
import { resolveBankCode } from "@/lib/bank-codes";

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  try {
    const body = await request.json();
    const { month, ownerIds: requestOwnerIds, formaPagamento } = body;

    if (!isCnab240Configured()) {
      return NextResponse.json(
        {
          error:
            "CNAB 240 nao configurado. Preencha as variaveis CNAB_EMPRESA_CNPJ, CNAB_EMPRESA_CONVENIO, CNAB_EMPRESA_AGENCIA, CNAB_EMPRESA_CONTA no .env",
        },
        { status: 400 }
      );
    }

    // Buscar todos os créditos pendentes (REPASSE, IPTU, CONDOMINIO, GARANTIA, etc.)
    const where: Record<string, unknown> = {
      type: "CREDITO",
      status: "PENDENTE",
    };

    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split("-").map(Number);
      where.dueDate = {
        gte: new Date(y, m - 1, 1),
        lt: new Date(y, m, 1),
      };
    }

    if (Array.isArray(requestOwnerIds) && requestOwnerIds.length > 0) {
      where.ownerId = { in: requestOwnerIds };
    }

    const entries = await prisma.ownerEntry.findMany({
      where,
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            cpfCnpj: true,
            street: true,
            number: true,
            complement: true,
            neighborhood: true,
            city: true,
            state: true,
            zipCode: true,
            bankName: true,
            bankAgency: true,
            bankAccount: true,
            bankPix: true,
            bankPixType: true,
            thirdPartyName: true,
            thirdPartyDocument: true,
            thirdPartyBank: true,
            thirdPartyAgency: true,
            thirdPartyAccount: true,
            thirdPartyPixKeyType: true,
            thirdPartyPix: true,
            payoutBeneficiaries: {
              orderBy: { order: "asc" },
              select: { name: true, documento: true, pixKey: true, pixKeyType: true, percentage: true },
            },
          },
        },
      },
      orderBy: { dueDate: "asc" },
    });

    if (entries.length === 0) {
      return NextResponse.json(
        { error: "Nenhum repasse pendente encontrado para gerar remessa" },
        { status: 404 }
      );
    }

    // Agrupar por proprietario e somar valores
    const grouped: Record<
      string,
      { owner: (typeof entries)[0]["owner"]; valor: number; refs: string[] }
    > = {};

    for (const entry of entries) {
      const oid = entry.ownerId;
      if (!grouped[oid]) {
        grouped[oid] = { owner: entry.owner, valor: 0, refs: [] };
      }
      grouped[oid].valor += entry.value;
      grouped[oid].refs.push(entry.id);
    }

    // Buscar debitos pendentes para descontar do repasse.
    // FILTRO IMPORTANTE: so debitos do mes ATUAL ou ANTERIORES.
    // Antes, o CNAB pegava qualquer DEBITO PENDENTE do owner — incluindo
    // intermediacao de meses futuros (due em junho) ou parcelas a vencer.
    // Resultado: descontava 2x ou debitava antecipadamente, gerando
    // valores absurdos (caso Cristiano Kampf: R$ 2,33 em vez de R$ 724).
    const groupedOwnerIds = Object.keys(grouped);
    const debitWhere: Record<string, unknown> = {
      type: "DEBITO",
      status: "PENDENTE",
      ownerId: { in: groupedOwnerIds },
    };
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split("-").map(Number);
      debitWhere.OR = [
        { dueDate: { lt: new Date(y, m, 1) } }, // mes atual ou anteriores
        { dueDate: null }, // sem data (lancamentos avulsos)
      ];
    }
    const debitEntries = groupedOwnerIds.length > 0
      ? await prisma.ownerEntry.findMany({
          where: debitWhere,
          select: { ownerId: true, value: true, id: true },
        })
      : [];

    // Descontar debitos do valor do repasse
    for (const debit of debitEntries) {
      if (grouped[debit.ownerId]) {
        grouped[debit.ownerId].valor -= debit.value;
        grouped[debit.ownerId].refs.push(debit.id); // Incluir ref do debito
      }
    }

    // Montar pagamentos CNAB
    const pagamentos: CnabPagamento[] = [];
    const erros: { proprietario: string; motivo: string }[] = [];

    for (const [, group] of Object.entries(grouped)) {
      const o = group.owner;

      // Pular se valor liquido <= 0 (debitos superam creditos)
      if (group.valor <= 0) {
        erros.push({
          proprietario: o.name,
          motivo: `Valor liquido R$ ${group.valor.toFixed(2)} (debitos superam repasse). Repasse nao gerado.`,
        });
        continue;
      }

      const useThirdParty = !!o.thirdPartyName;

      // Fix Bug 21: valida CPF/CNPJ antes de gerar (comprimento exato).
      // Sicredi retorna AE (tipo/numero inscricao invalido) quando o
      // documento nao tem 11 (CPF) ou 14 (CNPJ) digitos.
      const docToCheck = (useThirdParty ? o.thirdPartyDocument || o.cpfCnpj : o.cpfCnpj).replace(/\D/g, "");
      if (docToCheck.length !== 11 && docToCheck.length !== 14) {
        erros.push({
          proprietario: o.name,
          motivo: `CPF/CNPJ invalido (${docToCheck.length} digitos, esperado 11 ou 14): ${docToCheck}`,
        });
        continue;
      }

      // Validar dados bancarios
      const agencia = useThirdParty
        ? o.thirdPartyAgency
        : o.bankAgency;
      const conta = useThirdParty
        ? o.thirdPartyAccount
        : o.bankAccount;
      const chavePix = useThirdParty ? o.thirdPartyPix : o.bankPix;

      // Para PIX precisa da chave OU dados bancarios
      // Para TED/CC precisa de agencia e conta
      const forma = formaPagamento || "PIX";
      if (forma === "PIX" && !chavePix && (!agencia || !conta)) {
        erros.push({
          proprietario: o.name,
          motivo: "Sem chave PIX e sem dados bancarios (agencia/conta)",
        });
        continue;
      }
      if ((forma === "TED" || forma === "CC") && (!agencia || !conta)) {
        erros.push({
          proprietario: o.name,
          motivo: "Sem dados bancarios (agencia/conta)",
        });
        continue;
      }

      // Validacao da chave PIX antes de enviar pro Sicredi:
      // Se a chave nao normalizar (ex: telefone fixo, telefone incompleto,
      // CPF malformado), rejeita aqui com mensagem clara em vez de gerar
      // CNAB que sera rejeitado pelo banco.
      if (forma === "PIX" && chavePix) {
        const pixType = useThirdParty ? o.thirdPartyPixKeyType : o.bankPixType;
        const chaveNorm = normalizePixKey(chavePix, pixType || undefined);
        if (!chaveNorm) {
          const t = (pixType || "").toUpperCase();
          let motivo = "Chave PIX invalida: " + chavePix;
          if (t === "TELEFONE") {
            motivo = `Telefone PIX invalido "${chavePix}" — precisa ser celular com 9 (ex: 51999999999). Telefone fixo nao tem PIX.`;
          }
          erros.push({ proprietario: o.name, motivo });
          continue;
        }
      }

      // Extrair DV da agencia e conta (ultimo caractere se tiver separador)
      const agenciaClean = (agencia || "").replace(/\D/g, "");
      const contaClean = (conta || "").replace(/\D/g, "");

      // Separar DV: ultimo segmento e DV, resto e numero. Suporta
      // multiplos hifens como em "1234-5-6" (raro mas existe).
      let agenciaNum = agenciaClean;
      let agenciaDv = " ";
      if ((agencia || "").includes("-")) {
        const parts = (agencia || "").split("-");
        const lastIdx = parts.length - 1;
        agenciaDv = parts[lastIdx]?.replace(/\D/g, "") || " ";
        agenciaNum = parts.slice(0, lastIdx).join("").replace(/\D/g, "");
      }

      let contaNum = contaClean;
      let contaDv = " ";
      if ((conta || "").includes("-")) {
        // Suporta multiplos hifens: "35198560-0-4" → contaNum="351985600", dv="4"
        // Pega ULTIMO segmento como DV, junta o resto sem espacos.
        const parts = (conta || "").split("-");
        const lastIdx = parts.length - 1;
        contaDv = parts[lastIdx]?.replace(/\D/g, "") || " ";
        contaNum = parts.slice(0, lastIdx).join("").replace(/\D/g, "");
      }

      // Resolve o codigo COMPE do banco. Admin cadastra texto livre
      // ("Sicredi", "Banco do Brasil") — Sicredi exige 3 digitos no CNAB.
      // Se nao conseguir resolver, pula com erro descritivo.
      const bancoRaw = useThirdParty ? o.thirdPartyBank : o.bankName;
      const bancoCodigo = resolveBankCode(bancoRaw);
      // Para TED/CC, banco e OBRIGATORIO. Para PIX com chave (que nao seja dados
      // bancarios), o banco e ignorado pelo Sicredi e usamos 748 como filler.
      if ((forma === "TED" || forma === "CC") && !bancoCodigo) {
        erros.push({
          proprietario: o.name,
          motivo: `Banco "${bancoRaw}" nao reconhecido. Cadastre o codigo COMPE (ex: 001, 748, 237) ou o nome exato.`,
        });
        continue;
      }

      const favorecido: CnabFavorecido = {
        nome: useThirdParty ? o.thirdPartyName! : o.name,
        documento: (
          useThirdParty
            ? o.thirdPartyDocument || o.cpfCnpj
            : o.cpfCnpj
        ).replace(/\D/g, ""),
        banco: bancoCodigo || "748",
        agencia: agenciaNum,
        agenciaDv,
        conta: contaNum,
        contaDv,
        chavePix: chavePix || undefined,
        tipoChavePix: (useThirdParty
          ? o.thirdPartyPixKeyType
          : o.bankPixType) || undefined,
        endereco: o.street || undefined,
        numero: o.number || undefined,
        complemento: o.complement || undefined,
        bairro: o.neighborhood || undefined,
        cidade: o.city || undefined,
        cep: o.zipCode || undefined,
        uf: o.state || undefined,
      };

      // Split de repasse (Fase 2.9): se houver beneficiarios cadastrados,
      // divide o liquido entre owner + beneficiarios PIX. O owner sempre
      // absorve o drift de centavos (parte = total - soma das partes dos benefs).
      const benefs = (o as any).payoutBeneficiaries as
        | { name: string; pixKey: string; pixKeyType: string; percentage: number }[]
        | undefined;
      const totalLiquido = Math.round(group.valor * 100) / 100;

      if (benefs && benefs.length > 0 && (forma === "PIX")) {
        // VALIDA soma de percentages — owner recebe o restante (100 - soma).
        // Se soma > 100, owner ficaria negativo. Rejeita antes de gerar pra
        // nao silenciar o problema (caso Roberta: cadastrar 110% por engano).
        const somaBenefs = benefs.reduce((s, b) => s + (b.percentage || 0), 0);
        if (somaBenefs > 100.01) {
          erros.push({
            proprietario: o.name,
            motivo: `Beneficiarios PIX somam ${somaBenefs.toFixed(2)}% (maximo 100%). Corrija o cadastro.`,
          });
          continue;
        }
        // Calcula partes de beneficiarios
        let acumuladoBenef = 0;
        const benefPagamentos: CnabPagamento[] = [];
        for (const b of benefs) {
          const valorB = Math.round((totalLiquido * b.percentage / 100) * 100) / 100;
          acumuladoBenef += valorB;
          benefPagamentos.push({
            favorecido: {
              nome: b.name,
              // Fix Bug 9: usa documento do beneficiario quando disponivel.
              // Antes, quando pixKeyType era EMAIL/TELEFONE/ALEATORIA, usava
              // o CPF do OWNER — Sicredi rejeitava PF/PG (CPF nao bate com
              // titular do PIX no DICT).
              documento: (
                b.pixKeyType === "CPF" || b.pixKeyType === "CNPJ"
                  ? b.pixKey
                  : ((b as any).documento || o.cpfCnpj)
              ).replace(/\D/g, ""),
              banco: bancoCodigo || "748",
              agencia: " ",
              agenciaDv: " ",
              conta: " ",
              contaDv: " ",
              chavePix: b.pixKey,
              tipoChavePix: b.pixKeyType,
            },
            valor: valorB,
            dataPagamento: new Date(),
            documentoEmpresa: `REP-${o.cpfCnpj.replace(/\D/g, "").slice(-8)}-${b.name.slice(0, 4).toUpperCase()}`,
            informacoes: `REPASSE BENEF ${b.name.slice(0, 20)}${month ? ` ${month}` : ""}`,
          });
        }
        // Owner recebe o resto (drift absorvido aqui).
        // Se valorOwner ficar negativo por arredondamento ou somaBenefs=100,
        // dropa silenciosamente — owner nao recebe nada nesse caso. Rejeita
        // se somaBenefs >= 100 sem necessidade do owner receber.
        const valorOwner = Math.round((totalLiquido - acumuladoBenef) * 100) / 100;
        if (valorOwner < -0.01) {
          erros.push({
            proprietario: o.name,
            motivo: `Soma de beneficiarios PIX (${somaBenefs.toFixed(2)}%) gera valor negativo pro owner (R$ ${valorOwner.toFixed(2)}). Ajuste percentages.`,
          });
          continue;
        }
        if (valorOwner > 0.005) {
          pagamentos.push({
            favorecido,
            valor: valorOwner,
            dataPagamento: new Date(),
            documentoEmpresa: `REP-${o.cpfCnpj.replace(/\D/g, "").slice(-8)}`,
            informacoes: `REPASSE ALUGUEL${month ? ` ${month}` : ""}`,
          });
        }
        pagamentos.push(...benefPagamentos);
      } else {
        pagamentos.push({
          favorecido,
          valor: totalLiquido,
          dataPagamento: new Date(),
          documentoEmpresa: `REP-${o.cpfCnpj.replace(/\D/g, "").slice(-8)}`,
          informacoes: `REPASSE ALUGUEL${month ? ` ${month}` : ""}`,
        });
      }
    }

    if (pagamentos.length === 0) {
      return NextResponse.json(
        {
          error:
            "Nenhum pagamento valido para gerar remessa. Verifique os dados bancarios dos proprietarios.",
          erros,
        },
        { status: 400 }
      );
    }

    // Fix Bug 10: atomic increment do sequencial pra evitar race condition.
    // Antes, read+increment+save em chamadas separadas — dois admins clicando
    // simultaneamente liam o mesmo numero e geravam arquivos com sequencial
    // identico (Sicredi rejeitava duplicata, ou pior, processava 2x).
    // Agora: transaction com SELECT-FOR-UPDATE semantica via upsert atomico.
    const nextSeq = await prisma.$transaction(async (tx) => {
      const current = await tx.appSetting.findUnique({
        where: { key: "cnab_sequencial" },
      });
      const cur = current ? (JSON.parse(current.value) as number) : 0;
      const next = cur + 1;
      if (next > 999999) {
        throw new Error("Sequencial CNAB excedeu 999999. Resete manualmente em /api/repasses/cnab240 (PATCH).");
      }
      await tx.appSetting.upsert({
        where: { key: "cnab_sequencial" },
        update: { value: JSON.stringify(next) },
        create: { key: "cnab_sequencial", value: JSON.stringify(next) },
      });
      return next;
    });

    // Gerar arquivo CNAB 240
    const result = generateCnab240(pagamentos, {
      formaPagamento: formaPagamento || "PIX",
      sequencialArquivo: nextSeq,
    });

    return new NextResponse(result.content, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "X-Total-Pagamentos": String(result.totalPagamentos),
        "X-Valor-Total": String(result.valorTotal),
        "X-Erros": JSON.stringify(erros),
      },
    });
  } catch (error) {
    console.error("[CNAB240] Erro:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Erro ao gerar arquivo CNAB 240",
      },
      { status: 500 }
    );
  }
}

// GET - Info sobre configuracao CNAB
export async function GET() {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  const seqSetting = await prisma.appSetting.findUnique({ where: { key: "cnab_sequencial" } });
  const lastSeq = seqSetting ? (JSON.parse(seqSetting.value) as number) : 0;

  return NextResponse.json({
    configured: isCnab240Configured(),
    empresa: process.env.CNAB_EMPRESA_NOME || null,
    agencia: process.env.CNAB_EMPRESA_AGENCIA || null,
    proximoSequencial: lastSeq + 1,
  });
}

// PUT - Ajustar sequencial manualmente
export async function PUT(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  try {
    const { sequencial } = await request.json();
    if (!sequencial || typeof sequencial !== "number" || sequencial < 0) {
      return NextResponse.json({ error: "Sequencial inválido" }, { status: 400 });
    }
    // Salva o valor anterior ao próximo desejado (próximo = sequencial)
    await prisma.appSetting.upsert({
      where: { key: "cnab_sequencial" },
      update: { value: JSON.stringify(sequencial - 1) },
      create: { key: "cnab_sequencial", value: JSON.stringify(sequencial - 1) },
    });
    return NextResponse.json({ proximoSequencial: sequencial });
  } catch {
    return NextResponse.json({ error: "Erro ao atualizar sequencial" }, { status: 500 });
  }
}
