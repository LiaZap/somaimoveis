import { getToken } from "next-auth/jwt";
import { jwtVerify } from "jose";
import { NextRequest, NextResponse } from "next/server";

const ADMIN_ROUTES = ["/usuarios", "/configuracoes"];
const PORTAL_JWT_ISSUER = "somma-portal";

// Paginas com dados financeiros agregados/sensiveis da empresa.
// Mesmo se um User existir com role/permissao errada, sao bloqueadas
// aqui antes de servir a pagina (defense-in-depth). Proprietarios
// do portal NUNCA passam (eles nem chegam aqui — nao tem cookie).
const SENSITIVE_DASHBOARD_ROUTES: Record<string, string[]> = {
  "/repasses": ["ADMIN", "CORRETOR", "FINANCEIRO"],
  "/financeiro": ["ADMIN", "CORRETOR", "FINANCEIRO"],
  "/notas-fiscais": ["ADMIN", "CORRETOR", "FINANCEIRO"],
  "/lancamentos": ["ADMIN", "CORRETOR", "FINANCEIRO"],
  "/fiscal": ["ADMIN", "CORRETOR", "FINANCEIRO"],
};

function rolesFromToken(role: unknown): string[] {
  if (!role || typeof role !== "string") return [];
  return role.split(",").map((r) => r.trim().toUpperCase()).filter(Boolean);
}

/**
 * Verifies a portal Bearer token in the Edge runtime.
 * Uses jose (Edge-compatible) directly instead of importing portal-auth.ts
 * which may pull in Node-only dependencies via barrel imports.
 */
async function verifyPortalBearerToken(request: NextRequest): Promise<boolean> {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return false;
    }

    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret) {
      return false;
    }

    const token = authHeader.substring(7);
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(secret),
      { issuer: PORTAL_JWT_ISSUER }
    );

    return payload.type === "portal" && !!payload.ownerId;
  } catch {
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow static assets and public routes
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/icons") ||
    pathname.startsWith("/sw.js") ||
    pathname.startsWith("/manifest.json") ||
    pathname.startsWith("/offline.html") ||
    pathname.endsWith(".webp") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".svg") ||
    pathname.endsWith(".ico")
  ) {
    return NextResponse.next();
  }

  // Portal auth endpoint is public (login/token generation)
  if (pathname.startsWith("/api/portal/auth")) {
    return NextResponse.next();
  }

  // Sicredi test (GET only) and webhook are public
  if (pathname.startsWith("/api/sicredi/test") || pathname.startsWith("/api/webhook/sicredi")) {
    return NextResponse.next();
  }

  // File serving is public (files are already uploaded by authenticated users)
  if (pathname.startsWith("/api/files/")) {
    return NextResponse.next();
  }

  // Protected portal API routes: verify portal JWT Bearer token
  // Note: individual route handlers also verify auth as defense-in-depth
  if (pathname.startsWith("/api/portal")) {
    const isValidPortalToken = await verifyPortalBearerToken(request);
    if (!isValidPortalToken) {
      return NextResponse.json(
        { error: "Nao autorizado" },
        { status: 401 }
      );
    }
    return NextResponse.next();
  }

  // Portal pages are public (client-side auth handles redirection)
  if (pathname.startsWith("/portal")) {
    return NextResponse.next();
  }

  // --- Main app auth (NextAuth) ---
  const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });

  // Allow public routes for main app
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/esqueci-senha") ||
    pathname.startsWith("/api/auth")
  ) {
    return NextResponse.next();
  }

  // Redirect to login if no token
  if (!token) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  // Check admin routes
  const isAdminRoute = ADMIN_ROUTES.some(route => pathname.startsWith(route));
  if (isAdminRoute && token.role !== "ADMIN") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  // Defense-in-depth: rotas com dados financeiros agregados/sensiveis
  // exigem role explicito. ADMIN sempre passa.
  const userRoles = rolesFromToken(token.role);
  const isAdmin = userRoles.includes("ADMIN");
  if (!isAdmin) {
    for (const [route, allowedRoles] of Object.entries(SENSITIVE_DASHBOARD_ROUTES)) {
      if (pathname === route || pathname.startsWith(`${route}/`)) {
        const ok = userRoles.some((r) => allowedRoles.includes(r));
        if (!ok) {
          return NextResponse.redirect(new URL("/", request.url));
        }
        break;
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
