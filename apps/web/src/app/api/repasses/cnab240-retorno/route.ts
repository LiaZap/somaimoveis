import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";
import { parseCnab240Retorno } from "@/lib/cnab240-retorno";

/**
 * POST /api/repasses/cnab240-retorno
 * Importa arquivo de retorno CNAB 240 Sicredi (.RET)
 * Faz o match com OwnerEntries pendentes e opcionalmente marca como PAGO.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const autoConfirm = formData.get("autoConfirm") === "true";

    if (!file) {
      return NextResponse.json({ error: "Arquivo não enviado" }, { status: 400 });
    }

    const content = await file.text();
    const retorno = parseCnab240Retorno(content);

    // Match pagamentos do retorno com OwnerEntries no banco
    // O documentoEmpresa no CNAB remessa é "REP-{8 últimos dígitos do CPF}"
    // Buscar todas entries CREDITO pendentes ou pagas para match
    const allEntries = await prisma.ownerEntry.findMany({
      where: {
        type: "CREDITO",
        status: { in: ["PENDENTE", "PAGO"] },
      },
      include: {
        owner: { select: { id: true, name: true, cpfCnpj: true } },
      },
    });

    // Indexar entries por CPF (últimos 8 dígitos) para match rápido
    const entriesByCpfSuffix: Record<string, typeof allEntries> = {};
    for (const entry of allEntries) {
      const cpfClean = entry.owner.cpfCnpj.replace(/\D/g, "");
      const suffix = cpfClean.slice(-8);
      const key = `REP-${suffix}`;
      if (!entriesByCpfSuffix[key]) entriesByCpfSuffix[key] = [];
      entriesByCpfSuffix[key].push(entry);
    }

    const resultados: {
      favorecido: string;
      documento: string;
      valor: number;
      status: "sucesso" | "erro" | "sem_match";
      ocorrencias: string;
      entryIds?: string[];
      ownerName?: string;
      marcadoPago?: boolean;
      entriesMarcadas?: number;
      revertido?: boolean;
      entriesRevertidas?: number;
    }[] = [];

    const entryIdsToMarkPago: string[] = [];
    // IDs de entries que estavam marcadas PAGO mas o retorno indicou ERRO.
    // Voltam pra PENDENTE pra entrar na proxima geracao de CNAB.
    const entryIdsToRevert: string[] = [];
    // Entries com sucesso confirmado pelo banco — marcadas em notes
    // pra distinguir de PAGO "manual" (marcado via confirm do CNAB).
    const entryIdsToConfirm: Array<{ id: string; notes: string | null; ocorrencias: string }> = [];

    for (const pgto of retorno.pagamentos) {
      const docEmpresa = pgto.documentoEmpresa.trim();

      // Tentar match pelo documentoEmpresa
      // O CNAB remessa agrupa TODOS os créditos de um proprietário em um único pagamento,
      // então precisamos marcar TODAS as entries PENDENTES desse proprietário como PAGO.
      const matchedEntries = entriesByCpfSuffix[docEmpresa] || [];
      const pendentes = matchedEntries.filter(e => e.status === "PENDENTE");

      const ocorrenciasStr = pgto.ocorrencias.map(o => `${o.codigo}: ${o.descricao}`).join("; ");

      if (matchedEntries.length === 0) {
        resultados.push({
          favorecido: pgto.favorecidoNome,
          documento: docEmpresa,
          valor: pgto.valorPagamento,
          status: pgto.sucesso ? "sucesso" : "erro",
          ocorrencias: ocorrenciasStr,
        });
        continue;
      }

      const resultado: typeof resultados[0] = {
        favorecido: pgto.favorecidoNome,
        documento: docEmpresa,
        valor: pgto.valorPagamento,
        status: pgto.sucesso ? "sucesso" : "erro",
        ocorrencias: ocorrenciasStr,
        entryIds: matchedEntries.map(e => e.id),
        ownerName: matchedEntries[0].owner.name,
        marcadoPago: false,
        entriesMarcadas: 0,
      };

      // Se sucesso e autoConfirm, marcar TODAS as entries PENDENTES desse proprietário
      if (pgto.sucesso && autoConfirm && pendentes.length > 0) {
        for (const entry of pendentes) {
          entryIdsToMarkPago.push(entry.id);
        }
        resultado.marcadoPago = true;
        resultado.entriesMarcadas = pendentes.length;
      }

      // Confirmacao pelo Sicredi: marca em notes que o pagamento foi
      // efetivado pelo banco. Permite distinguir "PAGO confirmado pelo
      // banco" de "PAGO marcado manualmente pelo admin via confirm do CNAB"
      // mesmo nos casos em que ja estava PAGO.
      if (pgto.sucesso && matchedEntries.length > 0) {
        const ocorrencias = pgto.ocorrencias.map(o => o.codigo).join(",");
        for (const entry of matchedEntries) {
          // skip se ja confirmado (evita re-processamento desnecessario)
          try {
            const n = JSON.parse(entry.notes || "{}");
            if (n.bankConfirmed === true) continue;
          } catch { /* re-confirma */ }
          entryIdsToConfirm.push({ id: entry.id, notes: entry.notes, ocorrencias });
        }
      }

      // Se ERRO no retorno, reverter PAGO -> PENDENTE pra repassar.
      // Quando o admin clicou OK no confirm do CNAB ele marcou tudo PAGO,
      // mas o Sicredi rejeitou — entao precisa voltar pra fila.
      // Esse comportamento e SEMPRE aplicado (independente de autoConfirm)
      // porque deixar PAGO algo que nao foi processado e pior que reverter.
      if (!pgto.sucesso) {
        const pagosErrados = matchedEntries.filter(e => e.status === "PAGO");
        if (pagosErrados.length > 0) {
          for (const entry of pagosErrados) {
            entryIdsToRevert.push(entry.id);
          }
          resultado.revertido = true;
          resultado.entriesRevertidas = pagosErrados.length;
        }
      }

      resultados.push(resultado);
    }

    // Batch update: reverter entries marcadas PAGO que o Sicredi
    // rejeitou (status=ERRO no retorno) pra PENDENTE. Tambem reverte
    // os DEBITOs do mesmo (owner, mes) que foram auto-marcados PAGO
    // junto — eles voltam pra ficar disponiveis no proximo CNAB.
    let totalRevertidos = 0;
    let totalDebitosRevertidos = 0;
    if (entryIdsToRevert.length > 0) {
      const updated = await prisma.ownerEntry.updateMany({
        where: { id: { in: entryIdsToRevert } },
        data: { status: "PENDENTE", paidAt: null },
      });
      totalRevertidos = updated.count;

      // Reverter DEBITOs do mesmo (owner, mes) que foram auto-marcados PAGO
      const revertedEntries = await prisma.ownerEntry.findMany({
        where: { id: { in: entryIdsToRevert } },
        select: { ownerId: true, dueDate: true },
      });
      const seenRev = new Set<string>();
      for (const e of revertedEntries) {
        if (!e.dueDate) continue;
        const monthStart = new Date(e.dueDate.getFullYear(), e.dueDate.getMonth(), 1);
        const monthEnd = new Date(e.dueDate.getFullYear(), e.dueDate.getMonth() + 1, 1);
        const key = `${e.ownerId}_${monthStart.toISOString()}`;
        if (seenRev.has(key)) continue;
        seenRev.add(key);
        const debRev = await prisma.ownerEntry.updateMany({
          where: {
            ownerId: e.ownerId,
            type: "DEBITO",
            status: "PAGO",
            dueDate: { gte: monthStart, lt: monthEnd },
          },
          data: { status: "PENDENTE", paidAt: null },
        });
        totalDebitosRevertidos += debRev.count;
      }
    }

    // Batch update: marcar repasses como PAGO
    let totalMarcados = 0;
    let totalDebitosMarcados = 0;
    if (entryIdsToMarkPago.length > 0) {
      const updated = await prisma.ownerEntry.updateMany({
        where: { id: { in: entryIdsToMarkPago } },
        data: { status: "PAGO", paidAt: new Date() },
      });
      totalMarcados = updated.count;

      // Marca tambem os DEBITOS PENDENTES do mesmo (owner, mes) como PAGO.
      // Mesma logica do PATCH /api/repasses — quando o repasse e
      // confirmado pelo banco, os debitos descontados foram processados
      // junto. Lei do Leo: "se foi descontado, ja foi pago".
      const markedEntries = await prisma.ownerEntry.findMany({
        where: { id: { in: entryIdsToMarkPago } },
        select: { ownerId: true, dueDate: true },
      });
      const seen = new Set<string>();
      for (const e of markedEntries) {
        if (!e.dueDate) continue;
        const monthStart = new Date(e.dueDate.getFullYear(), e.dueDate.getMonth(), 1);
        const monthEnd = new Date(e.dueDate.getFullYear(), e.dueDate.getMonth() + 1, 1);
        const key = `${e.ownerId}_${monthStart.toISOString()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const debUpdate = await prisma.ownerEntry.updateMany({
          where: {
            ownerId: e.ownerId,
            type: "DEBITO",
            status: "PENDENTE",
            dueDate: { gte: monthStart, lt: monthEnd },
          },
          data: { status: "PAGO", paidAt: new Date() },
        });
        totalDebitosMarcados += debUpdate.count;
      }
    }

    // Marca bankConfirmed=true em notes das entries que tiveram sucesso
    // no retorno. Distingue "PAGO confirmado pelo banco" de "PAGO marcado
    // manualmente pelo admin via confirm do CNAB".
    let totalConfirmados = 0;
    if (entryIdsToConfirm.length > 0) {
      const confirmedAt = new Date().toISOString();
      for (const item of entryIdsToConfirm) {
        let notesObj: Record<string, unknown> = {};
        try { notesObj = JSON.parse(item.notes || "{}"); } catch { /* ignore */ }
        notesObj.bankConfirmed = true;
        notesObj.bankConfirmedAt = confirmedAt;
        notesObj.bankReturnCodes = item.ocorrencias;
        await prisma.ownerEntry.update({
          where: { id: item.id },
          data: { notes: JSON.stringify(notesObj) },
        });
        totalConfirmados++;
      }
    }

    return NextResponse.json({
      arquivo: {
        banco: retorno.banco,
        empresa: retorno.empresa,
        dataGeracao: retorno.dataGeracao,
        sequencial: retorno.sequencialArquivo,
        totalLotes: retorno.totalLotes,
        totalRegistros: retorno.totalRegistros,
      },
      resumo: {
        totalPagamentos: retorno.pagamentos.length,
        sucesso: retorno.resumo.sucesso,
        erro: retorno.resumo.erro,
        valorTotal: retorno.resumo.valorTotal,
        valorEfetivado: retorno.resumo.valorEfetivado,
        matchados: resultados.filter(r => r.entryIds && r.entryIds.length > 0).length,
        semMatch: resultados.filter(r => !r.entryIds || r.entryIds.length === 0).length,
        marcadosPago: totalMarcados,
        entriesMarcadas: resultados.reduce((s, r) => s + (r.entriesMarcadas || 0), 0),
        debitosMarcados: totalDebitosMarcados,
        revertidos: totalRevertidos,
        entriesRevertidas: resultados.reduce((s, r) => s + (r.entriesRevertidas || 0), 0),
        debitosRevertidos: totalDebitosRevertidos,
        confirmadosBanco: totalConfirmados,
      },
      resultados,
    });
  } catch (error) {
    console.error("[CNAB240 Retorno]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro ao processar arquivo de retorno" },
      { status: 500 }
    );
  }
}
