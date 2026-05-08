import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, requirePagePermission, isAuthError } from "@/lib/api-auth";
import { buildSearchWhere } from "@/lib/search";

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const search = searchParams.get("search");
  const contractId = searchParams.get("contractId");
  const tab = searchParams.get("tab"); // todos|pendentes|pagos|atrasados|emitidos|nao_emitidos
  const dateField = (searchParams.get("dateField") || "dueDate") as
    | "dueDate"
    | "paidAt"
    | "createdAt";
  const dateFrom = searchParams.get("dateFrom");
  const dateTo = searchParams.get("dateTo");

  const where: Record<string, unknown> = {};
  if (status && status !== "all") where.status = status;
  if (contractId) where.contractId = contractId;

  // Busca tokenizada focada em quem PAGA o boleto: locatario, codigo,
  // contrato e imovel. Nao busca por nome do proprietario porque na tela
  // /financeiro a coluna principal eh o locatario — incluir owner gera
  // resultados confusos (ex: buscar "Joao" trazia pagamentos de outros
  // locatarios cujo imovel pertence a um proprietario chamado Joao).
  // Para buscar por proprietario, use a tela /proprietarios ou /contratos.
  const searchWhere = buildSearchWhere(
    search,
    [
      "code",
      "description",
      "nossoNumero",
      "tenant.name",
      "tenant.cpfCnpj",
      "contract.code",
      "contract.property.title",
    ],
    {
      numericFields: ["tenant.cpfCnpj", "nossoNumero"],
    },
  );
  if (searchWhere) {
    where.AND = [...((where.AND as any[]) || []), ...searchWhere];
  }

  // Filtro por aba (status especiais)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (tab === "pendentes") {
    where.status = "PENDENTE";
    where.dueDate = { gte: today };
  } else if (tab === "pagos") {
    where.status = "PAGO";
  } else if (tab === "atrasados") {
    // PENDENTE com vencimento passado OU status ATRASADO
    where.OR = [
      ...((where.OR as any[]) || []),
      { status: "ATRASADO" },
      { AND: [{ status: "PENDENTE" }, { dueDate: { lt: today } }] },
    ];
    delete where.status;
  } else if (tab === "emitidos") {
    where.boletoStatus = "EMITIDO";
  } else if (tab === "nao_emitidos") {
    where.AND = [
      { OR: [{ nossoNumero: null }, { nossoNumero: "" }] },
      { OR: [{ status: "PENDENTE" }, { status: "ATRASADO" }] },
    ];
  }

  // Filtro por data
  if (dateFrom || dateTo) {
    const range: { gte?: Date; lte?: Date } = {};
    if (dateFrom) range.gte = new Date(`${dateFrom}T00:00:00`);
    if (dateTo) range.lte = new Date(`${dateTo}T23:59:59`);
    where[dateField] = range;
  }

  const includeRelations = {
    contract: { include: { property: { select: { title: true } } } },
    tenant: { select: { id: true, name: true } },
    owner: { select: { id: true, name: true } },
  };

  const pageParam = searchParams.get("page");
  if (!pageParam) {
    // Legacy: return all as array
    const payments = await prisma.payment.findMany({
      where,
      include: includeRelations,
      orderBy: { dueDate: "desc" },
    });

    // Buscar notificações enviadas para cada payment
    const paymentIds = payments.map(p => p.id);
    const sentNotifications = paymentIds.length > 0
      ? await prisma.notification.findMany({
          where: { paymentId: { in: paymentIds }, status: "ENVIADO" },
          select: { paymentId: true, channel: true, sentAt: true },
          orderBy: { sentAt: "desc" },
        })
      : [];

    const notifByPayment = new Map<string, { channel: string; sentAt: Date | null }[]>();
    for (const n of sentNotifications) {
      if (!n.paymentId) continue;
      if (!notifByPayment.has(n.paymentId)) notifByPayment.set(n.paymentId, []);
      notifByPayment.get(n.paymentId)!.push({ channel: n.channel, sentAt: n.sentAt });
    }

    const enriched = payments.map(p => ({
      ...p,
      notifications: notifByPayment.get(p.id) || [],
    }));

    return NextResponse.json(enriched);
  }

  // Paginated response
  const page = Math.max(1, parseInt(pageParam));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "50")));
  const skip = (page - 1) * limit;

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: includeRelations,
      orderBy: { dueDate: "desc" },
      skip,
      take: limit,
    }),
    prisma.payment.count({ where }),
  ]);

  // Enriquecer com notificacoes enviadas
  const paymentIds = payments.map((p) => p.id);
  const sentNotifications = paymentIds.length > 0
    ? await prisma.notification.findMany({
        where: { paymentId: { in: paymentIds }, status: "ENVIADO" },
        select: { paymentId: true, channel: true, sentAt: true },
        orderBy: { sentAt: "desc" },
      })
    : [];
  const notifByPayment = new Map<string, { channel: string; sentAt: Date | null }[]>();
  for (const n of sentNotifications) {
    if (!n.paymentId) continue;
    if (!notifByPayment.has(n.paymentId)) notifByPayment.set(n.paymentId, []);
    notifByPayment.get(n.paymentId)!.push({ channel: n.channel, sentAt: n.sentAt });
  }
  const enriched = payments.map((p) => ({
    ...p,
    notifications: notifByPayment.get(p.id) || [],
  }));

  return NextResponse.json({
    data: enriched,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requirePagePermission("financeiro");
  if (isAuthError(auth)) return auth;
  const body = await request.json();
  const { contractId, tenantId, ownerId, value, dueDate } = body;
  if (!contractId || !tenantId || !ownerId || !value || !dueDate) {
    return NextResponse.json(
      { error: "Campos obrigatórios: contractId, tenantId, ownerId, value, dueDate" },
      { status: 400 }
    );
  }
  // Auto-generate code if not provided or placeholder
  let code = body.code;
  if (!code || code === "AUTO") {
    const allCodes = await prisma.payment.findMany({
      select: { code: true },
    });
    let maxNumber = 0;
    for (const p of allCodes) {
      const match = p.code.match(/PAG-(\d+)/);
      if (match) {
        const num = parseInt(match[1]);
        if (num > maxNumber) maxNumber = num;
      }
    }
    code = `PAG-${String(maxNumber + 1).padStart(3, "0")}`;
  }

  try {
    const payment = await prisma.payment.create({
      data: {
        code, contractId, tenantId, ownerId,
        value: parseFloat(value),
        dueDate: new Date(dueDate.includes("T") ? dueDate : dueDate + "T12:00:00"),
        status: body.status || "PENDENTE",
        description: body.description || null,
        paymentMethod: body.paymentMethod || null,
        paidValue: body.paidValue ? parseFloat(body.paidValue) : null,
        paidAt: body.paidAt ? new Date(String(body.paidAt).includes("T") ? body.paidAt : body.paidAt + "T12:00:00") : null,
        fineValue: body.fineValue ? parseFloat(body.fineValue) : null,
        interestValue: body.interestValue ? parseFloat(body.interestValue) : null,
        discountValue: body.discountValue ? parseFloat(body.discountValue) : null,
        splitOwnerValue: body.splitOwnerValue ? parseFloat(body.splitOwnerValue) : null,
        splitAdminValue: body.splitAdminValue ? parseFloat(body.splitAdminValue) : null,
        lateFee: body.lateFee ? parseFloat(body.lateFee) : null,
        totalDue: body.totalDue ? parseFloat(body.totalDue) : null,
        irrfValue: body.irrfValue ? parseFloat(body.irrfValue) : null,
        irrfRate: body.irrfRate ? parseFloat(body.irrfRate) : null,
        grossToOwner: body.grossToOwner ? parseFloat(body.grossToOwner) : null,
        netToOwner: body.netToOwner ? parseFloat(body.netToOwner) : null,
        intermediationFee: body.intermediationFee ? parseFloat(body.intermediationFee) : null,
        notes: body.notes || null,
        createdById: auth.user.id,
      },
      include: {
        tenant: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
      },
    });
    // Auto-sync de OwnerEntries reflexas — Lei do Leo: ao criar boleto
    // manual, replicar o que o billing/generate automatico faz:
    //   - cria 1 OwnerEntry REPASSE com splitOwnerValue
    //   - cria 1 OwnerEntry CREDITO/DEBITO pra cada TenantEntry vinculada
    //     (idempotente via tenantEntryId em notes)
    let autoSyncResult: { repasseCriado?: boolean; entriesPropagadas?: number } | undefined;
    if (body.autoSyncEntries === true && payment.contractId && payment.dueDate) {
      try {
        const contract = await prisma.contract.findUnique({
          where: { id: payment.contractId },
          select: {
            code: true,
            ownerId: true,
            rentalValue: true,
            adminFeePercent: true,
            propertyId: true,
            startDate: true,
            endDate: true,
          },
        });
        if (contract) {
          const dueDate = payment.dueDate;
          const mLabel = `${String(dueDate.getMonth() + 1).padStart(2, "0")}/${dueDate.getFullYear()}`;
          let repasseCriado = false;
          let entriesPropagadas = 0;

          // Pro-rata: calcula aluguel proporcional se boleto cai no
          // primeiro/ultimo mes do contrato
          const refY = dueDate.getFullYear();
          const refM = dueDate.getMonth();
          const csY = contract.startDate.getFullYear();
          const csM = contract.startDate.getMonth();
          const csDay = contract.startDate.getDate();
          const ceY = contract.endDate.getFullYear();
          const ceM = contract.endDate.getMonth();
          const ceDay = contract.endDate.getDate();
          const isFirstMonth = csY === refY && csM === refM;
          const isLastMonth = ceY === refY && ceM === refM;
          let prorataDays = 30;
          let isProrata = false;
          if (isFirstMonth && csDay > 1) {
            isProrata = true;
            prorataDays = 30 - csDay + 1;
          } else if (isLastMonth && ceDay < 30) {
            isProrata = true;
            prorataDays = ceDay;
          }
          const dailyRate = contract.rentalValue / 30;
          const prorataRentalValue = isProrata
            ? Math.round(dailyRate * prorataDays * 100) / 100
            : contract.rentalValue;

          // 1) Cria OwnerEntry REPASSE se ainda nao existe pra (contractId, dueDate)
          const existingRepasse = await prisma.ownerEntry.findFirst({
            where: {
              contractId: payment.contractId,
              dueDate: payment.dueDate,
              category: "REPASSE",
            },
          });
          if (!existingRepasse) {
            const adminPct = contract.adminFeePercent || 10;
            const adminFeeValue = Math.round(prorataRentalValue * (adminPct / 100) * 100) / 100;
            const splitOwnerValue = payment.splitOwnerValue ?? Math.round((prorataRentalValue - adminFeeValue) * 100) / 100;
            await prisma.ownerEntry.create({
              data: {
                type: "CREDITO",
                category: "REPASSE",
                description: `Repasse aluguel ${mLabel} - ${contract.code || payment.contractId}`,
                value: splitOwnerValue,
                dueDate: payment.dueDate,
                status: "PENDENTE",
                ownerId: contract.ownerId,
                contractId: payment.contractId,
                propertyId: contract.propertyId || null,
                notes: JSON.stringify({
                  aluguelBruto: prorataRentalValue,
                  aluguelOriginal: isProrata ? contract.rentalValue : undefined,
                  isProrata,
                  prorataDias: isProrata ? prorataDays : undefined,
                  adminFeePercent: adminPct,
                  adminFeeValue,
                  netToOwner: splitOwnerValue,
                  autoCreated: true,
                  syncedFromPayment: payment.code,
                }),
              },
            });
            repasseCriado = true;
          }

          // 2) Propaga TenantEntries informadas em body.tenantEntryIds
          //    (admin selecionou no form). Idempotente via tenantEntryId em notes.
          const tenantEntryIds: string[] = Array.isArray(body.tenantEntryIds)
            ? body.tenantEntryIds.filter((s: unknown) => typeof s === "string")
            : [];
          if (tenantEntryIds.length > 0) {
            const tenantEntries = await prisma.tenantEntry.findMany({
              where: { id: { in: tenantEntryIds } },
            });
            const alreadyPropagated = await prisma.ownerEntry.findMany({
              where: { OR: tenantEntryIds.map((id) => ({ notes: { contains: id } })) },
              select: { notes: true },
            });
            const propagatedSet = new Set<string>();
            for (const oe of alreadyPropagated) {
              if (!oe.notes) continue;
              try {
                const n = JSON.parse(oe.notes);
                if (n.tenantEntryId) propagatedSet.add(n.tenantEntryId);
              } catch {}
            }
            const categoryMap: Record<string, string> = {
              IPTU: "IPTU", AGUA: "AGUA", LUZ: "LUZ", GAS: "GAS",
              CONDOMINIO: "CONDOMINIO",
            };
            for (const te of tenantEntries) {
              if (propagatedSet.has(te.id)) continue;
              const ownerType = te.type === "DEBITO" ? "CREDITO" : "DEBITO";
              const ownerCategory = categoryMap[te.category] || te.category || "OUTROS";
              const installmentLabel = te.installmentNumber && te.installmentTotal
                ? ` ${te.installmentNumber}/${te.installmentTotal}`
                : "";
              await prisma.ownerEntry.create({
                data: {
                  type: ownerType,
                  category: ownerCategory,
                  description: `${te.description || te.category}${installmentLabel} ${mLabel} - ${contract.code || payment.contractId}`,
                  value: te.value,
                  dueDate: payment.dueDate,
                  status: "PENDENTE",
                  ownerId: contract.ownerId,
                  contractId: payment.contractId,
                  propertyId: contract.propertyId || null,
                  notes: JSON.stringify({
                    tenantEntryId: te.id,
                    originalDescription: te.description,
                    autoCreated: true,
                    syncedFromPayment: payment.code,
                  }),
                },
              });
              entriesPropagadas++;
            }
          }
          autoSyncResult = { repasseCriado, entriesPropagadas };
        }
      } catch (err) {
        console.error("[Payments POST] auto-sync de OwnerEntries falhou:", err);
        // nao bloqueia a criacao do payment
      }
    }

    return NextResponse.json({ ...payment, autoSync: autoSyncResult }, { status: 201 });
  } catch (error: any) {
    console.error("[Payments POST] Erro:", error);
    // Handle unique constraint violation on code
    if (error?.code === "P2002") {
      return NextResponse.json(
        { error: `Código ${code} já existe. Tente novamente.` },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: error?.message || "Erro ao criar pagamento" },
      { status: 500 }
    );
  }
}
