/**
 * POST /api/invoices/preview-audit/cleanup-bad-keys?month=YYYY-MM
 *
 * Bug-fix: ate ce7be93 a UI salvava overrides com chave 'NULL_yyyymm_ownerId'
 * (para entries sem contrato) enquanto o backend espera 'entry_<id>_...'.
 * Resultado: overrides salvos nao tinham efeito na emissao.
 *
 * Este endpoint:
 *   1. Le os 4 AppSettings do mes (value, property, suppress, noDiscount)
 *   2. Lista chaves que comecam com 'NULL_' ou 'entry_unknown_' (chaves errados antigos)
 *   3. Tenta MAPEAR cada chave errada -> entry.id real, usando ownerId e dueDate
 *   4. Move o valor pra chave correta e DELETA a errada
 *   5. Retorna relatorio (migradas, nao-mapeadas)
 *
 * Body opcional: { dryRun: true } -> so simula, nao salva.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePagePermission, isAuthError } from "@/lib/api-auth";

const SETTING_KEYS = (y: number, mm: string) => [
  `nf_value_override_${y}_${mm}`,
  `nf_property_override_${y}_${mm}`,
  `nf_suppress_${y}_${mm}`,
  `nf_no_discount_${y}_${mm}`,
];

export async function POST(request: NextRequest) {
  const auth = await requirePagePermission("notas_fiscais");
  if (isAuthError(auth)) return auth;

  const url = new URL(request.url);
  const month = url.searchParams.get("month");
  const body = await request.json().catch(() => ({}));
  const dryRun = body.dryRun === true;

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "month invalido" }, { status: 400 });
  }
  const [y, m] = month.split("-").map(Number);
  const mm = String(m).padStart(2, "0");

  const inicio = new Date(y, m - 1, 1);
  const fim = new Date(y, m, 1);

  // Pre-busca todos entries do mes pra resolver ownerId+mes -> entry.id
  const entries = await prisma.ownerEntry.findMany({
    where: {
      type: "CREDITO",
      category: { in: ["REPASSE", "INTERMEDIACAO"] },
      dueDate: { gte: inicio, lt: fim },
      status: { not: "CANCELADO" },
      contractId: null, // so os SEM contrato (os com contrato sempre tiveram chave certa)
    },
    select: { id: true, ownerId: true },
  });
  // Indexa: ownerId -> primeiro entry.id (assume 1 entry sem contrato por owner;
  // se houver mais, fica com o primeiro — admin precisa ajustar manualmente)
  const entryByOwner = new Map<string, string>();
  for (const e of entries) {
    if (!entryByOwner.has(e.ownerId)) entryByOwner.set(e.ownerId, e.id);
  }

  const report: Array<{
    settingKey: string;
    badKey: string;
    fixedKey?: string;
    value?: unknown;
    reason?: string;
    action: "migrated" | "skipped";
  }> = [];

  for (const settingKey of SETTING_KEYS(y, mm)) {
    const setting = await prisma.appSetting.findUnique({ where: { key: settingKey } });
    if (!setting) continue;

    const data: Record<string, unknown> = JSON.parse(setting.value);
    let modified = false;

    for (const badKey of Object.keys(data)) {
      // Padrao errado antigo: "NULL_yyyymm_ownerId" ou "entry_unknown_yyyymm_ownerId"
      const m1 = badKey.match(/^NULL_\d{4}-\d{2}_(.+)$/);
      const m2 = badKey.match(/^entry_unknown_\d{4}-\d{2}_(.+)$/);
      const match = m1 || m2;
      if (!match) continue;

      const ownerId = match[1];
      const entryId = entryByOwner.get(ownerId);
      const value = data[badKey];

      if (!entryId) {
        report.push({
          settingKey, badKey, value, action: "skipped",
          reason: `Nenhum entry sem contrato achado pra ownerId=${ownerId} em ${month}`,
        });
        continue;
      }

      const fixedKey = `entry_${entryId}_${y}-${mm}_${ownerId}`;
      report.push({ settingKey, badKey, fixedKey, value, action: "migrated" });

      if (!dryRun) {
        data[fixedKey] = value;
        delete data[badKey];
        modified = true;
      }
    }

    if (modified) {
      await prisma.appSetting.update({
        where: { key: settingKey },
        data: { value: JSON.stringify(data) },
      });
    }
  }

  const summary = {
    month,
    dryRun,
    total: report.length,
    migrated: report.filter((r) => r.action === "migrated").length,
    skipped: report.filter((r) => r.action === "skipped").length,
  };

  return NextResponse.json({ summary, report });
}
