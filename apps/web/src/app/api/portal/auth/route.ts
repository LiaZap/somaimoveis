import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { signPortalToken } from "@/lib/portal-auth";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, cpfCnpj, token, password } = body;

    if (!token && !password) {
      return NextResponse.json(
        { error: "Token ou senha é obrigatório" },
        { status: 400 }
      );
    }

    if (!email && !cpfCnpj) {
      return NextResponse.json(
        { error: "Email ou CPF/CNPJ é obrigatório" },
        { status: 400 }
      );
    }

    // Buscar proprietario por email ou cpfCnpj com portal ativo.
    // Para CPF/CNPJ aceita qualquer formato (com ou sem pontuacao) — busca
    // tanto pela string original quanto pelos digitos puros.
    let owner: {
      id: string;
      name: string;
      email: string | null;
      portalActive: boolean;
      portalToken: string | null;
      portalPassword: string | null;
    } | null = null;

    if (email) {
      owner = await prisma.owner.findFirst({
        where: { email, portalActive: true },
        select: {
          id: true,
          name: true,
          email: true,
          portalActive: true,
          portalToken: true,
          portalPassword: true,
        },
      });
    }

    if (!owner && cpfCnpj) {
      // Tenta match exato primeiro (mais rapido — usa indice unique)
      owner = await prisma.owner.findFirst({
        where: { cpfCnpj, portalActive: true },
        select: {
          id: true,
          name: true,
          email: true,
          portalActive: true,
          portalToken: true,
          portalPassword: true,
        },
      });

      // Fallback: compara digitos puros (CPF/CNPJ pode ter formato diferente)
      if (!owner) {
        const inputDigits = cpfCnpj.replace(/\D/g, "");
        if (inputDigits.length >= 11) {
          // Busca todos com portalActive=true e compara digit-only
          // (volume baixo de owners — OK fazer em JS)
          const candidates = await prisma.owner.findMany({
            where: { portalActive: true },
            select: {
              id: true,
              name: true,
              email: true,
              portalActive: true,
              portalToken: true,
              portalPassword: true,
              cpfCnpj: true,
            },
          });
          const found = candidates.find(
            (o) => o.cpfCnpj.replace(/\D/g, "") === inputDigits,
          );
          if (found) {
            owner = {
              id: found.id,
              name: found.name,
              email: found.email,
              portalActive: found.portalActive,
              portalToken: found.portalToken,
              portalPassword: found.portalPassword,
            };
          }
        }
      }
    }

    if (!owner) {
      return NextResponse.json(
        { error: "Credenciais invalidas ou portal nao ativado" },
        { status: 401 }
      );
    }

    // Validar: senha tem prioridade sobre token (se o proprietario ja definiu senha)
    let authenticated = false;
    let usedToken = false;
    if (password && owner.portalPassword) {
      authenticated = await bcrypt.compare(password, owner.portalPassword);
    } else if (token && owner.portalToken === token) {
      authenticated = true;
      usedToken = true;
    } else if (password && !owner.portalPassword && owner.portalToken === password) {
      // Fallback: se o proprietario digitou o token no campo de senha
      authenticated = true;
      usedToken = true;
    }

    if (!authenticated) {
      return NextResponse.json(
        { error: "Credenciais invalidas" },
        { status: 401 }
      );
    }

    // Gerar JWT do portal
    const jwt = await signPortalToken({
      ownerId: owner.id,
      ownerName: owner.name,
    });

    return NextResponse.json({
      token: jwt,
      owner: {
        id: owner.id,
        name: owner.name,
        email: owner.email,
      },
      // Sinaliza se o usuario precisa definir senha (entrou com token e ainda nao tem senha)
      mustSetPassword: usedToken && !owner.portalPassword,
    });
  } catch (error) {
    console.error("Erro na autenticacao do portal:", error);
    return NextResponse.json(
      { error: "Erro interno ao processar autenticacao" },
      { status: 500 }
    );
  }
}
