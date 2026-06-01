/**
 * GET /api/invoices/preview-audit/debug?month=YYYY-MM&ownerName=...
 *
 * Endpoint de diagnostico pra entender por que um override foi salvo
 * mas o emit nao esta aplicando.
 *
 * Retorna:
 *   - conteudo dos 4 AppSettings do mes (value, suppress, no-discount, property)
 *   - entries do mes do owner especificado com seus groupKeys (igual emit)
 *   - cross-check: pra cada entry, mostra se HA override correspondente
 *     ou nao (e com qual chave esta salvo se houver mismatch).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePagePermission, isAuthError } from "@/lib/api-auth";

export async function GET(request: NextRequest) {
  const auth = await requirePagePermission("notas_fiscais");
  if (isAuthError(auth)) return auth;

  const url = new URL(request.url);
  const month = url.searchParams.get("month");
  const ownerName = url.searchParams.get("ownerName");
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "month invalido" }, { status: 400 });
  }

  const [y, m] = month.split("-").map(Number);
  const mm = String(m).padStart(2, "0");
  const inicio = new Date(y, m - 1, 1);
  const fim = new Date(y, m, 1);

  // 1. AppSettings
  const [valueOv, suppressOv, noDiscountOv, propertyOv] = await Promise.all([
    prisma.appSetting.findUnique({ where: { key: `nf_value_override_${y}_${mm}` } }),
    prisma.appSetting.findUnique({ where: { key: `nf_suppress_${y}_${mm}` } }),
    prisma.appSetting.findUnique({ where: { key: `nf_no_discount_${y}_${mm}` } }),
    prisma.appSetting.findUnique({ where: { key: `nf_property_override_${y}_${mm}` } }),
  ]);

  const settings = {
    nf_value_override: valueOv ? JSON.parse(valueOv.value) : {},
    nf_suppress: suppressOv ? JSON.parse(suppressOv.value) : {},
    nf_no_discount: noDiscountOv ? JSON.parse(noDiscountOv.value) : {},
    nf_property_override: propertyOv ? JSON.parse(propertyOv.value) : {},
  };

  // 2. Entries do mes (filtrado por owner se informado)
  const ownerFilter = ownerName
    ? { owner: { name: { contains: ownerName } } }
    : {};
  const entries = await prisma.ownerEntry.findMany({
    where: {
      type: "CREDITO",
      category: { in: ["REPASSE", "INTERMEDIACAO"] },
      dueDate: { gte: inicio, lt: fim },
      status: { not: "CANCELADO" },
      ...ownerFilter,
    },
    include: {
      owner: { select: { id: true, name: true, cpfCnpj: true } },
      invoice: { select: { id: true, status: true, numero: true, dataEmissao: true } },
    },
    orderBy: [{ owner: { name: "asc" } }, { category: "asc" }],
  });

  // 3. Pra cada entry, calcula groupKey igual emit + cross-check
  const entriesDebug = entries.map((e) => {
    const groupKeyEmit = e.contractId
      ? `${e.contractId}_${y}-${mm}_${e.ownerId}`
      : `entry_${e.id}_${y}-${mm}_${e.ownerId}`;

    const valueOverride = (settings.nf_value_override as Record<string, number>)[groupKeyEmit];
    const isSuppress = (settings.nf_suppress as Record<string, boolean>)[groupKeyEmit] === true;
    const isNoDiscount = (settings.nf_no_discount as Record<string, boolean>)[groupKeyEmit] === true;
    const propertyOverride = (settings.nf_property_override as Record<string, string>)[groupKeyEmit];

    // Procura por OUTRAS chaves que poderiam ser deste entry (chave errada antiga)
    const possibleOldKeys = [
      `NULL_${y}-${mm}_${e.ownerId}`,
      `entry_unknown_${y}-${mm}_${e.ownerId}`,
    ];
    const overridesEmChaveErrada: Record<string, unknown> = {};
    for (const old of possibleOldKeys) {
      if ((settings.nf_value_override as Record<string, unknown>)[old] !== undefined) {
        overridesEmChaveErrada[`value:${old}`] = (settings.nf_value_override as Record<string, unknown>)[old];
      }
      if ((settings.nf_suppress as Record<string, unknown>)[old] !== undefined) {
        overridesEmChaveErrada[`suppress:${old}`] = (settings.nf_suppress as Record<string, unknown>)[old];
      }
      if ((settings.nf_no_discount as Record<string, unknown>)[old] !== undefined) {
        overridesEmChaveErrada[`noDiscount:${old}`] = (settings.nf_no_discount as Record<string, unknown>)[old];
      }
    }

    let notesAdminFeeValue: number | undefined;
    if (e.notes) {
      try {
        const n = JSON.parse(e.notes);
        notesAdminFeeValue = n.adminFeeValue;
      } catch { /* ignore */ }
    }

    return {
      entryId: e.id,
      ownerName: e.owner?.name,
      ownerId: e.ownerId,
      category: e.category,
      contractId: e.contractId,
      value: Number(e.value),
      notesAdminFeeValue,
      invoice: e.invoice,
      // Chaves esperadas:
      groupKeyEmitUsa: groupKeyEmit,
      // Overrides aplicaveis se groupKey for o esperado:
      overrideAtivo: {
        valueOverride: valueOverride ?? null,
        isSuppress,
        isNoDiscount,
        propertyOverride: propertyOverride ?? null,
      },
      // Overrides salvos com chaves antigas (errado) — se nao vazio, rode cleanup-bad-keys
      overridesEmChaveErrada,
    };
  });

  return NextResponse.json({
    month,
    settings,
    entries: entriesDebug,
    dica: entriesDebug.some((e) => Object.keys(e.overridesEmChaveErrada).length > 0)
      ? "Foram encontrados overrides salvos com chave antiga (NULL_* ou entry_unknown_*). " +
        "Rode POST /api/invoices/preview-audit/cleanup-bad-keys?month=YYYY-MM pra migrar."
      : null,
  });
}
