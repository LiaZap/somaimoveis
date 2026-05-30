import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { renderTemplate } from "@/lib/whatsapp-templates";
import {
  sendWhatsAppMessage,
  sendEmailMessage,
  sendSmsMessage,
} from "@/lib/whatsapp-sender";
import { requireAuth, isAuthError } from "@/lib/api-auth";

// ==================================================
// GET /api/notifications - Listar notificacoes com filtros
// ==================================================
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type");
    const status = searchParams.get("status");
    const paymentId = searchParams.get("paymentId");
    const tenantId = searchParams.get("tenantId");
    const ownerId = searchParams.get("ownerId");
    const contractId = searchParams.get("contractId");
    const search = searchParams.get("search");
    const pageParam = searchParams.get("page");
    const month = searchParams.get("month"); // YYYY-MM (filtra por createdAt)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: Record<string, any> = {};

    if (type) where.type = type;
    if (status) where.status = status;
    if (paymentId) where.paymentId = paymentId;
    if (tenantId) where.tenantId = tenantId;
    if (ownerId) where.ownerId = ownerId;
    if (contractId) where.contractId = contractId;
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split("-").map(Number);
      where.createdAt = {
        gte: new Date(y, m - 1, 1),
        lt: new Date(y, m, 1),
      };
    }
    if (search) {
      where.OR = [
        { recipientName: { contains: search } },
        { recipientPhone: { contains: search } },
        { message: { contains: search } },
      ];
    }

    if (!pageParam) {
      // Legacy: return all as array (respects limit param for backwards compat)
      const legacyLimit = parseInt(searchParams.get("limit") || "50", 10);
      const notifications = await prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: legacyLimit,
      });
      return NextResponse.json(notifications);
    }

    // Paginated response
    const page = Math.max(1, parseInt(pageParam));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "50")));
    const skip = (page - 1) * limit;

    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.notification.count({ where }),
    ]);

    return NextResponse.json({
      data: notifications,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("Erro ao listar notificacoes:", error);
    return NextResponse.json(
      { error: "Erro ao listar notificacoes" },
      { status: 500 }
    );
  }
}

// ==================================================
// POST /api/notifications - Criar e enviar uma notificação
// ==================================================
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;
  try {
    const body = await request.json();
    const {
      type,
      recipientName,
      recipientPhone,
      recipientEmail,
      templateKey,
      templateData,
      paymentId,
      contractId,
      tenantId,
      ownerId,
      metadata,
    } = body;

    // Validacoes basicas
    if (!type || !recipientName || !templateKey) {
      return NextResponse.json(
        { error: "Campos obrigatórios: type, recipientName, templateKey" },
        { status: 400 }
      );
    }

    // Renderizar template
    let rendered;
    try {
      rendered = renderTemplate(templateKey, templateData || {});
    } catch (err) {
      return NextResponse.json(
        { error: `Erro ao renderizar template: ${(err as Error).message}` },
        { status: 400 }
      );
    }

    // Determinar canal
    const channel = type === "WHATSAPP" ? "whatsapp" : type === "EMAIL" ? "email" : "sms";

    // Criar registro da notificação como PENDENTE
    let notification = await prisma.notification.create({
      data: {
        type,
        channel,
        recipientName,
        recipientPhone: recipientPhone || null,
        recipientEmail: recipientEmail || null,
        templateKey,
        subject: rendered.subject,
        message: rendered.message,
        status: "PENDENTE",
        paymentId: paymentId || null,
        contractId: contractId || null,
        tenantId: tenantId || null,
        ownerId: ownerId || null,
        metadata: metadata ? JSON.stringify(metadata) : null,
      },
    });

    // Tentar enviar
    let sendResult;
    try {
      if (type === "WHATSAPP") {
        if (!recipientPhone) {
          throw new Error("Telefone do destinatario nao informado");
        }
        sendResult = await sendWhatsAppMessage({
          to: recipientPhone,
          message: rendered.message,
        });
      } else if (type === "EMAIL") {
        if (!recipientEmail) {
          throw new Error("Email do destinatario nao informado");
        }
        sendResult = await sendEmailMessage({
          to: recipientEmail,
          subject: rendered.subject,
          message: rendered.message,
        });
      } else if (type === "SMS") {
        if (!recipientPhone) {
          throw new Error("Telefone do destinatario nao informado");
        }
        sendResult = await sendSmsMessage({
          to: recipientPhone,
          message: rendered.message,
        });
      } else {
        throw new Error(`Tipo de notificação desconhecido: ${type}`);
      }

      // Atualizar status baseado no resultado
      notification = await prisma.notification.update({
        where: { id: notification.id },
        data: {
          status: sendResult.success ? "ENVIADO" : "FALHA",
          sentAt: sendResult.success ? new Date() : null,
          errorMessage: sendResult.error || null,
          metadata: JSON.stringify({
            ...(metadata || {}),
            messageId: sendResult.messageId,
          }),
        },
      });
    } catch (sendError) {
      // Falha no envio
      notification = await prisma.notification.update({
        where: { id: notification.id },
        data: {
          status: "FALHA",
          errorMessage: (sendError as Error).message,
        },
      });
    }

    return NextResponse.json(notification, { status: 201 });
  } catch (error) {
    console.error("Erro ao criar notificação:", error);
    return NextResponse.json(
      { error: "Erro ao criar notificação" },
      { status: 500 }
    );
  }
}
