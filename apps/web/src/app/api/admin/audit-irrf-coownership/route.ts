import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";
import { calculateIRRF } from "@/lib/fiscal";

/**
 * POST /api/admin/audit-irrf-coownership?apply=1
 *
 * Detecta IRRF aplicado errado em OwnerEntries de coproprietarios.
 *
 * O audit-irrf padrao olha apenas o Payment (aluguel total do contrato),
 * entao nao detecta quando uma coproprietaria PF recebe uma fracao abaixo
 * do piso de isencao (ex: contrato de R$ 6.500 com 3 donos PF de 33,33%
 * cada — a parte de cada uma e R$ 2.166, abaixo do piso 2025/2026).
 *
 * Pela RFB (SC Cosit 55/2020), em condominio cada coproprietario e fonte
 * de retencao independente, com base de calculo limitada a sua fracao.
 *
 * Algoritmo:
 *   - Itera OwnerEntries REPASSE/GARANTIA com notes.sharePercent < 100
 *     e notes.irrfValue > 0
 *   - Calcula gross_dela = (aluguelBruto - adminFeeValue) * share / 100
 *   - Se calculateIRRF(gross_dela, dueDate).irrfValue == 0,
 *     zera notes.irrfValue e notes.irrfRate na OwnerEntry
 *   - NAO mexe em value nem no Payment (Payment continua com IRRF gravado
 *     pelo billing antigo, mas o demonstrativo le do notes da OwnerEntry,
 *     entao zerar notes ja resolve)
 *
 * Idempotente. Aceita ?apply=1 para escrever no banco.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  const { searchParams } = new URL(request.url);
  const apply = searchParams.get("apply") === "1";

  try {
    const entries = await prisma.ownerEntry.findMany({
      where: {
        category: { in: ["REPASSE", "GARANTIA"] },
      },
      select: {
        id: true,
        notes: true,
        ownerId: true,
        contractId: true,
        dueDate: true,
        owner: { select: { name: true, personType: true } },
      },
    });

    const fixes: {
      entryId: string;
      ownerName: string;
      contractId: string | null;
      dueDate: string | null;
      sharePercent: number;
      grossPart: number;
      irrfBefore: number;
    }[] = [];

    for (const e of entries) {
      if (!e.notes) continue;
      let notes: Record<string, unknown>;
      try {
        notes = JSON.parse(e.notes);
      } catch {
        continue;
      }
      const sharePct = typeof notes.sharePercent === "number" ? notes.sharePercent : 100;
      if (sharePct >= 100) continue;
      const irrfValue = typeof notes.irrfValue === "number" ? notes.irrfValue : 0;
      if (irrfValue <= 0) continue;

      // owner da OwnerEntry deve ser PF para a regra ter efeito
      const ownerType = (e.owner?.personType || "PF").toUpperCase();
      if (ownerType !== "PF") continue;

      const aluguelBruto = typeof notes.aluguelBruto === "number" ? notes.aluguelBruto : 0;
      const adminFeeValue = typeof notes.adminFeeValue === "number" ? notes.adminFeeValue : 0;
      const grossTotal = aluguelBruto - adminFeeValue;
      if (grossTotal <= 0) continue;

      const grossPart = Math.round(grossTotal * sharePct / 100 * 100) / 100;
      const refDate = e.dueDate || new Date();
      const irrfDela = calculateIRRF(grossPart, refDate).irrfValue;

      if (irrfDela > 0) continue; // tem IRRF mesmo na fracao — nao mexe

      fixes.push({
        entryId: e.id,
        ownerName: e.owner?.name || "(sem nome)",
        contractId: e.contractId,
        dueDate: e.dueDate ? e.dueDate.toISOString() : null,
        sharePercent: sharePct,
        grossPart,
        irrfBefore: irrfValue,
      });

      if (apply) {
        notes.irrfValue = 0;
        notes.irrfRate = 0;
        await prisma.ownerEntry.update({
          where: { id: e.id },
          data: { notes: JSON.stringify(notes) },
        });
      }
    }

    return NextResponse.json({
      mode: apply ? "APPLIED" : "DRY_RUN",
      total: fixes.length,
      irrfTotalZerado: Math.round(fixes.reduce((s, f) => s + f.irrfBefore, 0) * 100) / 100,
      fixes: fixes.slice(0, 50),
      truncated: fixes.length > 50,
    });
  } catch (error) {
    console.error("[audit-irrf-coownership] Erro:", error);
    return NextResponse.json(
      { error: "Erro na auditoria de coproprietarios", details: error instanceof Error ? error.message : "desconhecido" },
      { status: 500 }
    );
  }
}
