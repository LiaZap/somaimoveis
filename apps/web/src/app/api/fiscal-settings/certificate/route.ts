import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";
import { isAdmin } from "@/lib/rbac";
import { encryptString, isEncryptionConfigured } from "@/lib/crypto";
import { extractPfx } from "@/lib/nfse-pfx";

/**
 * POST /api/fiscal-settings/certificate
 *
 * Upload do certificado digital A1 (.pfx). Espera multipart/form-data:
 *   - certificate: arquivo .pfx
 *   - password: senha do certificado
 *
 * Valida a senha tentando ler o certificado, extrai a data de validade
 * e o nome do arquivo. Salva o .pfx (raw bytes) e a senha (criptografada
 * com AES-256-GCM via lib/crypto).
 *
 * Apenas ADMIN pode fazer upload.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  if (!isAdmin(auth.user.role)) {
    return NextResponse.json(
      { error: "Apenas administradores podem fazer upload do certificado" },
      { status: 403 },
    );
  }

  if (!isEncryptionConfigured()) {
    return NextResponse.json(
      { error: "ENCRYPTION_KEY nao configurada no servidor. Contate suporte." },
      { status: 500 },
    );
  }

  try {
    const formData = await request.formData();
    const file = formData.get("certificate") as File | null;
    const password = formData.get("password") as string | null;

    if (!file) {
      return NextResponse.json({ error: "Arquivo do certificado obrigatorio" }, { status: 400 });
    }
    if (!password) {
      return NextResponse.json({ error: "Senha do certificado obrigatoria" }, { status: 400 });
    }
    if (!file.name.match(/\.(pfx|p12)$/i)) {
      return NextResponse.json(
        { error: "Arquivo deve ser .pfx ou .p12" },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length < 1000) {
      return NextResponse.json(
        { error: "Arquivo muito pequeno para ser um .pfx valido." },
        { status: 400 },
      );
    }

    // Valida senha + extrai metadados (validade, subject, CNPJ)
    let cert;
    try {
      cert = extractPfx(buffer, password);
    } catch (err: any) {
      return NextResponse.json(
        { error: err?.message || "Senha do certificado incorreta ou arquivo invalido." },
        { status: 400 },
      );
    }

    // Atualiza FiscalSettings
    let existing = await prisma.fiscalSettings.findFirst();
    if (!existing) {
      existing = await prisma.fiscalSettings.create({ data: {} });
    }

    const updated = await prisma.fiscalSettings.update({
      where: { id: existing.id },
      data: {
        certificadoPfx: buffer,
        certificadoPassword: encryptString(password),
        certificadoNome: file.name,
        certificadoExpiraEm: cert.validUntil,
      },
    });

    return NextResponse.json({
      message: "Certificado carregado e validado com sucesso.",
      certificadoNome: updated.certificadoNome,
      certificadoExpiraEm: updated.certificadoExpiraEm,
      subject: cert.subject,
      cnpj: cert.cnpj,
      issuer: cert.issuer,
      validUntil: cert.validUntil,
      sizeBytes: buffer.length,
    });
  } catch (error: any) {
    console.error("[FiscalCert Upload] Erro:", error);
    return NextResponse.json(
      { error: error?.message || "Erro ao processar certificado" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/fiscal-settings/certificate
 * Remove o certificado armazenado.
 */
export async function DELETE() {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  if (!isAdmin(auth.user.role)) {
    return NextResponse.json(
      { error: "Apenas administradores podem remover o certificado" },
      { status: 403 },
    );
  }

  const existing = await prisma.fiscalSettings.findFirst();
  if (!existing) {
    return NextResponse.json({ message: "Nenhum certificado configurado." });
  }

  await prisma.fiscalSettings.update({
    where: { id: existing.id },
    data: {
      certificadoPfx: null,
      certificadoPassword: null,
      certificadoNome: null,
      certificadoExpiraEm: null,
    },
  });

  return NextResponse.json({ message: "Certificado removido." });
}

