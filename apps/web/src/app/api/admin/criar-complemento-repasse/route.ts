import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * POST /api/admin/criar-complemento-repasse
 *
 * Body: {
 *   complementos: [
 *     { ownerName?: string, ownerId?: string, valor: number, refMonth?: "MM/YYYY", description?: string }
 *   ],
 *   dueDate?: "YYYY-MM-DD",  // default hoje + 5 dias
 *   dryRun?: boolean
 * }
 *
 * Cria OwnerEntries CREDITO categoria "REPASSE" com a flag `isComplemento`
 * nas notes, no valor faltante. Esses creditos viram PENDENTE e entram no
 * proximo CNAB pra restituir o valor que deixou de ser pago.
 *
 * Caso real (familia Kampf): o CNAB descontou indevidamente intermediacao
 * de mes futuro do repasse. Owners receberam R$ 2,33 / R$ 5,58 etc no lugar
 * do valor correto. Esse endpoint gera o complemento pra mandar a diferenca.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  try {
    const body = await request.json();
    const complementos: Array<{
      ownerName?: string;
      ownerId?: string;
      valor: number;
      refMonth?: string;
      description?: string;
    }> = body.complementos || [];
    const dryRun = body.dryRun === true;
    const dueDateStr = body.dueDate;

    if (!Array.isArray(complementos) || complementos.length === 0) {
      return NextResponse.json({ error: "complementos[] obrigatorio" }, { status: 400 });
    }

    const dueDate = dueDateStr
      ? new Date(dueDateStr + "T12:00:00")
      : new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

    const results: Array<{
      ownerName: string;
      ownerId: string;
      valor: number;
      created?: { id: string };
      skipReason?: string;
    }> = [];

    for (const c of complementos) {
      if (!c.valor || c.valor <= 0) {
        results.push({ ownerName: c.ownerName || c.ownerId || "?", ownerId: c.ownerId || "?", valor: c.valor || 0, skipReason: "valor invalido" });
        continue;
      }

      // Resolve owner
      let owner: { id: string; name: string } | null = null;
      if (c.ownerId) {
        owner = await prisma.owner.findUnique({ where: { id: c.ownerId }, select: { id: true, name: true } });
      } else if (c.ownerName) {
        // Busca case-insensitive manual (compativel com SQLite e Postgres)
        const target = c.ownerName.trim().toLowerCase();
        const candidates = await prisma.owner.findMany({ select: { id: true, name: true } });
        owner = candidates.find((o) => o.name.trim().toLowerCase() === target) || null;
      }

      if (!owner) {
        results.push({ ownerName: c.ownerName || c.ownerId || "?", ownerId: c.ownerId || "?", valor: c.valor, skipReason: "owner nao encontrado" });
        continue;
      }

      const refMonth = c.refMonth || `${String(new Date().getMonth() + 1).padStart(2, "0")}/${new Date().getFullYear()}`;
      const description = c.description || `Complemento Repasse ${refMonth}`;
      const valor = Math.round(c.valor * 100) / 100;

      if (dryRun) {
        results.push({ ownerName: owner.name, ownerId: owner.id, valor });
        continue;
      }

      const created = await prisma.ownerEntry.create({
        data: {
          type: "CREDITO",
          category: "REPASSE",
          description,
          value: valor,
          dueDate,
          ownerId: owner.id,
          status: "PENDENTE",
          notes: JSON.stringify({
            isComplemento: true,
            motivoComplemento: "Diferenca por desconto indevido no CNAB anterior",
            criadoEm: new Date().toISOString(),
          }),
        },
      });

      results.push({ ownerName: owner.name, ownerId: owner.id, valor, created: { id: created.id } });
    }

    return NextResponse.json({
      mode: dryRun ? "DRY_RUN" : "APPLIED",
      total: results.length,
      criados: results.filter((r) => r.created).length,
      ignorados: results.filter((r) => r.skipReason).length,
      somaCriados: Math.round(
        results.filter((r) => r.created || dryRun).reduce((s, r) => s + r.valor, 0) * 100
      ) / 100,
      results,
    });
  } catch (error) {
    console.error("[criar-complemento-repasse] Erro:", error);
    return NextResponse.json(
      { error: "Erro", details: error instanceof Error ? error.message : "desconhecido" },
      { status: 500 }
    );
  }
}
