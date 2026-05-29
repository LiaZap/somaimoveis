import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, requirePagePermission, isAuthError } from "@/lib/api-auth";
import { normalizeForSearch } from "@/lib/search";

// Aceita "yyyy-mm-dd" OU ISO completo ("yyyy-mm-ddTHH:MM:SS.sssZ") vindos do
// form. Ancora ao meio-dia local pra evitar shift de fuso (-1 dia) e NUNCA
// retorna Invalid Date (que faria o Prisma lancar e devolver 500).
function parseBirthDate(value: unknown): Date | null {
  if (!value) return null;
  const datePart = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  const d = new Date(datePart + "T12:00:00");
  return isNaN(d.getTime()) ? null : d;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;
  try {
    const { id } = await params;
    const tenant = await prisma.tenant.findUnique({
      where: { id },
      include: {
        contracts: {
          include: {
            property: true,
            owner: true,
          },
        },
        payments: {
          include: {
            contract: { select: { code: true } },
          },
          orderBy: { dueDate: "desc" },
        },
      },
    });
    if (!tenant) {
      return NextResponse.json({ error: "Locatário não encontrado" }, { status: 404 });
    }
    return NextResponse.json(tenant);
  } catch (error) {
    return NextResponse.json({ error: "Erro ao buscar locatário" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requirePagePermission("locatarios");
  if (isAuthError(auth)) return auth;
  try {
    const { id } = await params;
    const body = await request.json();
    const data: Record<string, unknown> = {
      name: body.name || undefined,
      nameNormalized: body.name ? normalizeForSearch(body.name) : undefined,
      cpfCnpj: body.cpfCnpj || undefined,
      personType: body.personType || undefined,
      stateRegistration: body.stateRegistration || null,
      email: body.email || null,
      phone: body.phone || null,
      phone2: body.phone2 || null,
      email2: body.email2 || null,
      rgNumber: body.rgNumber || body.rg || null,
      rgIssuer: body.rgIssuer || null,
      occupation: body.occupation || body.profession || null,
      monthlyIncome: body.monthlyIncome ? parseFloat(body.monthlyIncome) : null,
      birthDate: parseBirthDate(body.birthDate),
      street: body.street || null,
      number: body.number || null,
      complement: body.complement || null,
      neighborhood: body.neighborhood || null,
      city: body.city || null,
      state: body.state || null,
      zipCode: body.zipCode || null,
      notes: body.notes || null,
      paymentDay: body.paymentDay ? parseInt(body.paymentDay) : undefined,
    };
    // Remove undefined keys (only update provided fields)
    Object.keys(data).forEach(k => { if (data[k] === undefined) delete data[k]; });
    const tenant = await prisma.tenant.update({
      where: { id },
      data,
    });
    return NextResponse.json(tenant);
  } catch (error: any) {
    if (error?.code === "P2025") {
      return NextResponse.json({ error: "Locatário não encontrado" }, { status: 404 });
    }
    console.error("Tenant update error:", error);
    return NextResponse.json({ error: "Erro ao atualizar locatário" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requirePagePermission("locatarios");
  if (isAuthError(auth)) return auth;
  try {
    const { id } = await params;
    await prisma.tenant.delete({ where: { id } });
    return NextResponse.json({ message: "Locatário excluído com sucesso" });
  } catch (error: any) {
    if (error?.code === "P2025") {
      return NextResponse.json({ error: "Locatário não encontrado" }, { status: 404 });
    }
    if (error?.code === "P2003") {
      return NextResponse.json({ error: "Locatário possui contratos vinculados" }, { status: 409 });
    }
    return NextResponse.json({ error: "Erro ao excluir locatário" }, { status: 500 });
  }
}
