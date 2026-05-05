export const ROLES = {
  ADMIN: "ADMIN",
  CORRETOR: "CORRETOR",
  FINANCEIRO: "FINANCEIRO",
} as const;

export type Role = keyof typeof ROLES;

// Define permissions per role
const ROLE_PERMISSIONS: Record<string, string[]> = {
  ADMIN: ["*"], // full access
  CORRETOR: [
    "dashboard:view",
    "properties:view",
    "properties:create",
    "properties:edit",
    "owners:view",
    "owners:create",
    "owners:edit",
    "tenants:view",
    "tenants:create",
    "tenants:edit",
    "contracts:view",
    "contracts:create",
    "contracts:edit",
    "payments:view",
    "reports:view",
    "notifications:view",
    "profile:view",
    "profile:edit",
  ],
  FINANCEIRO: [
    "dashboard:view",
    "properties:view",
    "owners:view",
    "tenants:view",
    "contracts:view",
    "payments:view",
    "payments:create",
    "payments:edit",
    "reports:view",
    "reports:create",
    "notifications:view",
    "notifications:send",
    "profile:view",
    "profile:edit",
    "repasses:view",      // listar e gerar demonstrativo (sem destrutivos)
    "notas-fiscais:view", // visualizar (sem emitir)
  ],
};

/**
 * Normaliza uma string de role(s) em array.
 * Suporta: "ADMIN", "CORRETOR,FINANCEIRO", "ADMIN, CORRETOR"
 * Tolerante a espacos, caixa, e tokens desconhecidos (mantem os conhecidos).
 */
export function getUserRoles(role: string | null | undefined): string[] {
  if (!role) return [];
  return role
    .toString()
    .split(",")
    .map((r) => r.trim().toUpperCase())
    .filter((r) => r && r in ROLE_PERMISSIONS);
}

/**
 * Verifica se a string de role(s) inclui ADMIN.
 * Tolerante a formatos: "ADMIN", "admin", "Admin, Corretor", "ADMIN,FINANCEIRO".
 */
export function isAdmin(role: string | null | undefined): boolean {
  if (!role) return false;
  return role.toString().toUpperCase().split(",").some((r) => r.trim() === ROLES.ADMIN);
}

export function hasPermission(role: string | null | undefined, permission: string): boolean {
  if (isAdmin(role)) return true; // admin sempre tem tudo
  const roles = getUserRoles(role);
  if (roles.length === 0) return false;
  for (const r of roles) {
    const perms = ROLE_PERMISSIONS[r];
    if (!perms) continue;
    if (perms.includes("*")) return true;
    if (perms.includes(permission)) return true;
  }
  return false;
}

export function hasRole(role: string | null | undefined, target: string): boolean {
  return getUserRoles(role).includes(target.toUpperCase());
}

// Role display names
export const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Administrador",
  CORRETOR: "Corretor",
  FINANCEIRO: "Financeiro",
};

/** Formata role (pode ter varias) como string amigavel: "Corretor + Financeiro" */
export function formatRoleLabel(role: string | null | undefined): string {
  const roles = getUserRoles(role);
  if (roles.length === 0) return "-";
  return roles.map((r) => ROLE_LABELS[r] || r).join(" + ");
}

// Rotas restritas por role (usuario precisa ter PELO MENOS UM dos roles listados)
export const RESTRICTED_ROUTES: Record<string, string[]> = {
  "/configuracoes": ["ADMIN"],
  "/configuracoes/auditoria": ["ADMIN"],
  "/usuarios": ["ADMIN"],
  // Repasses e notas fiscais: ADMIN ve tudo, CORRETOR/FINANCEIRO ve
  // versao simplificada (sem agregados da empresa nem botoes destrutivos)
  "/repasses": ["ADMIN", "CORRETOR", "FINANCEIRO"],
  "/notas-fiscais": ["ADMIN", "CORRETOR", "FINANCEIRO"],
};

// ============================================================================
// PERMISSOES GRANULARES POR PAGINA
// Lista de todas as paginas/recursos do sistema que podem ser controlados
// individualmente por usuario. Admin sempre tem acesso a tudo.
// ============================================================================

export interface PagePermission {
  key: string;        // identificador unico (usado em customPermissions)
  label: string;      // label para UI
  path: string;       // caminho da rota
  group: string;      // agrupamento para UI
  adminOnly?: boolean; // se so admin pode, nao aparece nas opcoes
}

export const PAGES: PagePermission[] = [
  // Gestao
  { key: "dashboard",      label: "Dashboard",      path: "/",              group: "Geral" },
  { key: "imoveis",        label: "Imoveis",        path: "/imoveis",       group: "Gestao" },
  { key: "proprietarios",  label: "Proprietarios",  path: "/proprietarios", group: "Gestao" },
  { key: "locatarios",     label: "Locatarios",     path: "/locatarios",    group: "Gestao" },
  { key: "contratos",      label: "Contratos",      path: "/contratos",     group: "Gestao" },
  // Financeiro
  { key: "financeiro",     label: "Financeiro (Boletos/Cobranca)", path: "/financeiro", group: "Financeiro" },
  { key: "lancamentos",    label: "Lancamentos",    path: "/lancamentos",   group: "Financeiro" },
  { key: "repasses",       label: "Repasses",       path: "/repasses",      group: "Financeiro" },
  { key: "notas-fiscais",  label: "Notas Fiscais",  path: "/notas-fiscais", group: "Financeiro" },
  { key: "fiscal",         label: "Fiscal",         path: "/fiscal",        group: "Financeiro" },
  // Relatorios e comunicacao
  { key: "relatorios",     label: "Relatorios",     path: "/relatorios",    group: "Relatorios" },
  { key: "notificacoes",   label: "Notificacoes",   path: "/notificacoes",  group: "Comunicacao" },
  // Admin
  { key: "auditoria",      label: "Auditoria",      path: "/configuracoes/auditoria", group: "Admin", adminOnly: true },
];

/**
 * Permissoes padrao por role — sao aplicadas quando o usuario NAO tem
 * customPermissions definido. Admin sempre tem tudo.
 */
export const DEFAULT_PAGES_BY_ROLE: Record<string, string[]> = {
  ADMIN: PAGES.map((p) => p.key),
  CORRETOR: [
    "dashboard", "imoveis", "proprietarios", "locatarios", "contratos",
    "financeiro", "lancamentos", "repasses", "notas-fiscais",
    "relatorios", "notificacoes", "fiscal",
  ],
  FINANCEIRO: [
    // FINANCEIRO ve repasses/notas-fiscais em modo simplificado
    // (sem agregados da empresa, sem botoes destrutivos)
    "dashboard", "imoveis", "proprietarios", "locatarios", "contratos",
    "financeiro", "lancamentos", "repasses", "notas-fiscais",
    "relatorios", "notificacoes", "fiscal",
  ],
};

/**
 * Parse das customPermissions do usuario (armazenadas como string JSON
 * no User.permissions). Retorna lista de keys de paginas.
 */
export function getUserCustomPermissions(permissionsField: string | null | undefined): string[] | null {
  if (!permissionsField) return null;
  try {
    const arr = JSON.parse(permissionsField);
    if (Array.isArray(arr) && arr.every((v) => typeof v === "string")) {
      return arr;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Calcula as paginas que um usuario pode acessar considerando:
 * 1. Se eh ADMIN: todas as paginas
 * 2. Se tem customPermissions: usa essa lista
 * 3. Senao: usa defaults do role (union de todos os roles se multi-role)
 */
export function getUserAllowedPages(
  role: string | null | undefined,
  customPermissions: string | null | undefined
): string[] {
  if (isAdmin(role)) {
    return PAGES.map((p) => p.key);
  }
  const custom = getUserCustomPermissions(customPermissions);
  if (custom) return custom;
  // Fallback: union das permissoes default dos roles
  const roles = getUserRoles(role);
  const allowed = new Set<string>();
  for (const r of roles) {
    (DEFAULT_PAGES_BY_ROLE[r] || []).forEach((p) => allowed.add(p));
  }
  return Array.from(allowed);
}

export function canAccessRoute(
  role: string | null | undefined,
  pathname: string,
  customPermissions?: string | null
): boolean {
  // ADMIN sempre passa — acesso total, bypass completo de qualquer restricao
  if (isAdmin(role)) return true;

  const roles = getUserRoles(role);

  // Rotas com restricao fixa de role (admin-only)
  const hardRestriction = Object.entries(RESTRICTED_ROUTES).find(([route]) =>
    pathname.startsWith(route)
  );

  // Se tem customPermissions, checar se a pagina esta na lista
  const custom = getUserCustomPermissions(customPermissions);
  if (custom !== null) {
    const matched = PAGES.find((p) => {
      if (p.path === "/") return pathname === "/";
      return pathname.startsWith(p.path);
    });
    if (matched) {
      return custom.includes(matched.key);
    }
  }

  // Sem custom: fallback para restricoes fixas por role
  if (!hardRestriction) return true;
  return hardRestriction[1].some((r) => roles.includes(r));
}
