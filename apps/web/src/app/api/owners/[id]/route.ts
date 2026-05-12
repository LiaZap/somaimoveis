import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, requirePagePermission, isAuthError } from "@/lib/api-auth";
import { normalizeForSearch } from "@/lib/search";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;
  try {
    const { id } = await params;
    const owner = await prisma.owner.findUnique({
      where: { id },
      include: {
        properties: true,
        contracts: {
          include: {
            property: true,
            tenant: true,
          },
        },
        payoutBeneficiaries: { orderBy: { order: "asc" } },
      },
    });
    if (!owner) {
      return NextResponse.json({ error: "Proprietário não encontrado" }, { status: 404 });
    }
    return NextResponse.json(owner);
  } catch (error) {
    return NextResponse.json({ error: "Erro ao buscar proprietário" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requirePagePermission("proprietarios");
  if (isAuthError(auth)) return auth;
  try {
    const { id } = await params;
    const body = await request.json();
    const data: Record<string, unknown> = {
      name: body.name || undefined,
      nameNormalized: body.name ? normalizeForSearch(body.name) : undefined,
      cpfCnpj: body.cpfCnpj || undefined,
      personType: body.personType || undefined,
      email: body.email || null,
      phone: body.phone || null,
      phone2: body.phone2 || null,
      email2: body.email2 || null,
      stateRegistration: body.stateRegistration || null,
      birthDate: (() => {
        if (!body.birthDate) return null;
        const raw = String(body.birthDate).trim();
        if (!raw) return null;
        const d = new Date(raw.includes("T") ? raw : raw + "T12:00:00");
        return isNaN(d.getTime()) ? null : d;
      })(),
      rgIssuer: body.rgIssuer || null,
      street: body.street || null,
      number: body.number || null,
      complement: body.complement || null,
      neighborhood: body.neighborhood || null,
      city: body.city || null,
      state: body.state || null,
      zipCode: body.zipCode || null,
      bankName: body.bankName || null,
      bankAgency: body.bankAgency || null,
      bankAccount: body.bankAccount || null,
      bankPix: body.bankPix || null,
      bankPixType: body.bankPixType || null,
      thirdPartyName: body.thirdPartyName || null,
      thirdPartyDocument: body.thirdPartyDocument || null,
      thirdPartyBank: body.thirdPartyBank || null,
      thirdPartyAgency: body.thirdPartyAgency || null,
      thirdPartyAccount: body.thirdPartyAccount || null,
      thirdPartyPixKeyType: body.thirdPartyPixKeyType || null,
      thirdPartyPix: body.thirdPartyPix || null,
      paymentDay: body.paymentDay ? (typeof body.paymentDay === "number" ? body.paymentDay : parseInt(body.paymentDay)) : undefined,
      naoDeclaraImob: typeof body.naoDeclaraImob === "boolean" ? body.naoDeclaraImob : undefined,
      notes: body.notes || null,
    };
    // Remove undefined keys
    Object.keys(data).forEach(k => { if (data[k] === undefined) delete data[k]; });

    // Beneficiarios secundarios de repasse — substituicao completa quando enviado
    let beneficiariesPayload:
      | { name: string; pixKey: string; pixKeyType: string; percentage: number; order: number }[]
      | undefined;
    if (Array.isArray(body.payoutBeneficiaries)) {
      const list = body.payoutBeneficiaries as any[];
      if (list.length > 3) {
        return NextResponse.json(
          { error: "Maximo de 3 beneficiarios de repasse" },
          { status: 400 }
        );
      }
      let sum = 0;
      beneficiariesPayload = [];
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        const pct = Number(b.percentage);
        if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
          return NextResponse.json(
            { error: `Beneficiario ${i + 1}: percentual deve estar entre 0 (exclusivo) e 100` },
            { status: 400 }
          );
        }
        if (!b.name || !b.pixKey || !b.pixKeyType) {
          return NextResponse.json(
            { error: `Beneficiario ${i + 1}: nome, chave PIX e tipo de chave sao obrigatorios` },
            { status: 400 }
          );
        }
        sum += pct;
        beneficiariesPayload.push({
          name: String(b.name).trim(),
          pixKey: String(b.pixKey).trim(),
          pixKeyType: String(b.pixKeyType).trim().toUpperCase(),
          percentage: Math.round(pct * 100) / 100,
          order: i,
        });
      }
      if (sum > 100.0001) {
        return NextResponse.json(
          { error: `Soma dos percentuais (${sum.toFixed(2)}%) excede 100%. O proprietario recebe o restante automaticamente.` },
          { status: 400 }
        );
      }
    }

    const owner = await prisma.$transaction(async (tx) => {
      const updated = await tx.owner.update({ where: { id }, data });
      if (beneficiariesPayload !== undefined) {
        await tx.ownerPayoutBeneficiary.deleteMany({ where: { ownerId: id } });
        if (beneficiariesPayload.length > 0) {
          await tx.ownerPayoutBeneficiary.createMany({
            data: beneficiariesPayload.map((b) => ({ ...b, ownerId: id })),
          });
        }
      }
      return tx.owner.findUnique({
        where: { id },
        include: { payoutBeneficiaries: { orderBy: { order: "asc" } } },
      });
    });
    return NextResponse.json(owner);
  } catch (error: any) {
    console.error("Owner update error:", error);
    if (error?.code === "P2025") {
      return NextResponse.json({ error: "Proprietário não encontrado" }, { status: 404 });
    }
    if (error?.code === "P2002") {
      return NextResponse.json({ error: "CPF/CNPJ já cadastrado para outro proprietário" }, { status: 409 });
    }
    return NextResponse.json({ error: error?.message || "Erro ao atualizar proprietário" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requirePagePermission("proprietarios");
  if (isAuthError(auth)) return auth;
  try {
    const { id } = await params;
    await prisma.owner.delete({ where: { id } });
    return NextResponse.json({ message: "Proprietário excluído com sucesso" });
  } catch (error: any) {
    if (error?.code === "P2025") {
      return NextResponse.json({ error: "Proprietário não encontrado" }, { status: 404 });
    }
    if (error?.code === "P2003") {
      return NextResponse.json({ error: "Proprietário possui imóveis ou contratos vinculados" }, { status: 409 });
    }
    return NextResponse.json({ error: "Erro ao excluir proprietário" }, { status: 500 });
  }
}
