"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Bell,
  MessageCircle,
  Mail,
  Phone,
  Send,
  CheckCircle2,
  XCircle,
  Clock,
  Search,
  Loader2,
  ChevronDown,
  ChevronRight,
  Users,
  CalendarIcon,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ==================================================
// Types
// ==================================================

interface Notification {
  id: string;
  type: string;
  channel: string;
  recipientName: string;
  recipientPhone: string | null;
  recipientEmail: string | null;
  templateKey: string;
  subject: string | null;
  message: string;
  status: string;
  sentAt: string | null;
  errorMessage: string | null;
  paymentId: string | null;
  contractId: string | null;
  tenantId: string | null;
  ownerId: string | null;
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SendBillingResult {
  sent: number;
  skipped: number;
  errors: number;
  details: {
    paymentId: string;
    paymentCode: string;
    tenantName: string;
    action: string;
    result: string;
  }[];
  message?: string;
}

interface TenantSummary {
  key: string; // tenantId | recipientName
  tenantId: string | null;
  recipientName: string;
  recipientPhone: string | null;
  recipientEmail: string | null;
  total: number;
  enviadas: number;
  falhas: number;
  pendentes: number;
  lastDate: string | null;
  notifications: Notification[];
}

// ==================================================
// Config
// ==================================================

const statusConfig: Record<
  string,
  { label: string; className: string; icon: typeof CheckCircle2 }
> = {
  PENDENTE: { label: "Pendente", className: "bg-amber-100 text-amber-700 border-amber-200", icon: Clock },
  ENVIADO: { label: "Enviado", className: "bg-emerald-100 text-emerald-700 border-emerald-200", icon: CheckCircle2 },
  FALHA: { label: "Falha", className: "bg-red-100 text-red-700 border-red-200", icon: XCircle },
  CANCELADO: { label: "Cancelado", className: "bg-gray-100 text-gray-500 border-gray-200", icon: XCircle },
};

const typeIcons: Record<string, typeof MessageCircle> = {
  WHATSAPP: MessageCircle,
  EMAIL: Mail,
  SMS: Phone,
};

const templateLabels: Record<string, string> = {
  payment_reminder: "Lembrete de Pagamento",
  payment_overdue: "Pagamento em Atraso",
  payment_received: "Pagamento Confirmado",
  contract_expiring: "Contrato Expirando",
  owner_payment_received: "Repasse ao Proprietário",
  owner_payment_overdue: "Atraso (Proprietário)",
};

// ==================================================
// Helpers
// ==================================================

function formatDateTime(dateString: string): string {
  return new Date(dateString).toLocaleDateString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  });
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC",
  });
}

function formatPhone(phone: string | null): string {
  if (!phone) return "-";
  const c = phone.replace(/\D/g, "");
  if (c.length === 11) return `(${c.slice(0, 2)}) ${c.slice(2, 7)}-${c.slice(7)}`;
  if (c.length === 10) return `(${c.slice(0, 2)}) ${c.slice(2, 6)}-${c.slice(6)}`;
  return phone;
}

function getCurrentMonth(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(month: string): string {
  const [y, m] = month.split("-");
  const months = [
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
  ];
  return `${months[parseInt(m) - 1]} ${y}`;
}

// ==================================================
// Page
// ==================================================

type Visao = "por-inquilino" | "cronologica";
type ChannelFilter = "todas" | "WHATSAPP" | "EMAIL" | "SMS";
type StatusFilter = "todos" | "ENVIADO" | "FALHA" | "PENDENTE";

export default function NotificacoesPage() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [month, setMonth] = useState(getCurrentMonth());
  const [visao, setVisao] = useState<Visao>("por-inquilino");
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("todas");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("todos");
  const [expandedTenants, setExpandedTenants] = useState<Set<string>>(new Set());
  const [selectedNotification, setSelectedNotification] = useState<Notification | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<SendBillingResult | null>(null);
  const [sendResultOpen, setSendResultOpen] = useState(false);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("month", month);
      params.set("limit", "500");
      if (channelFilter !== "todas") params.set("type", channelFilter);
      if (search) params.set("search", search);

      const res = await fetch(`/api/notifications?${params.toString()}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setNotifications(Array.isArray(data) ? data : (data.data || []));
      }
    } catch (e) {
      console.error("Erro ao buscar notificacoes:", e);
    } finally {
      setLoading(false);
    }
  }, [month, channelFilter, search]);

  useEffect(() => { fetchNotifications(); }, [fetchNotifications]);

  // ---- Stats (do mes selecionado) ----
  const stats = useMemo(() => {
    const filtered = statusFilter === "todos"
      ? notifications
      : notifications.filter((n) => n.status === statusFilter);

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    return {
      total: notifications.length,
      enviadas: notifications.filter((n) => n.status === "ENVIADO").length,
      falhas: notifications.filter((n) => n.status === "FALHA").length,
      pendentes: notifications.filter((n) => n.status === "PENDENTE").length,
      hoje: notifications.filter((n) => n.status === "ENVIADO" && n.sentAt && new Date(n.sentAt) >= todayStart).length,
      filtered,
    };
  }, [notifications, statusFilter]);

  // ---- Agrupamento por inquilino ----
  const tenantSummaries = useMemo<TenantSummary[]>(() => {
    const map = new Map<string, TenantSummary>();
    for (const n of stats.filtered) {
      const key = n.tenantId || `name:${n.recipientName.toLowerCase()}`;
      const existing = map.get(key) || {
        key,
        tenantId: n.tenantId,
        recipientName: n.recipientName,
        recipientPhone: n.recipientPhone,
        recipientEmail: n.recipientEmail,
        total: 0, enviadas: 0, falhas: 0, pendentes: 0,
        lastDate: null,
        notifications: [],
      };
      existing.total += 1;
      if (n.status === "ENVIADO") existing.enviadas += 1;
      else if (n.status === "FALHA") existing.falhas += 1;
      else if (n.status === "PENDENTE") existing.pendentes += 1;
      if (!existing.lastDate || n.createdAt > existing.lastDate) existing.lastDate = n.createdAt;
      existing.recipientPhone = existing.recipientPhone || n.recipientPhone;
      existing.recipientEmail = existing.recipientEmail || n.recipientEmail;
      existing.notifications.push(n);
      map.set(key, existing);
    }
    // Ordena: falhas primeiro, depois mais recente
    return Array.from(map.values()).sort((a, b) => {
      if (a.falhas !== b.falhas) return b.falhas - a.falhas;
      return (b.lastDate || "").localeCompare(a.lastDate || "");
    });
  }, [stats.filtered]);

  function toggleTenant(key: string) {
    setExpandedTenants((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function expandAll() {
    setExpandedTenants(new Set(tenantSummaries.map((t) => t.key)));
  }
  function collapseAll() { setExpandedTenants(new Set()); }

  async function handleSendBilling() {
    setSending(true);
    setSendResult(null);
    try {
      const res = await fetch("/api/notifications/send-billing", { method: "POST" });
      const data = await res.json();
      setSendResult(data);
      setSendResultOpen(true);
      fetchNotifications();
    } catch {
      setSendResult({ sent: 0, skipped: 0, errors: 1, details: [], message: "Erro de conexao" });
      setSendResultOpen(true);
    } finally {
      setSending(false);
    }
  }

  // Pre-validacao tenant
  function tenantBadgeClass(t: TenantSummary): string {
    if (t.falhas > 0) return "border-red-200 bg-red-50/40";
    if (t.pendentes > 0) return "border-amber-200 bg-amber-50/40";
    return "border-emerald-200 bg-white";
  }

  return (
    <div className="flex flex-col">
      <Header title="Notificações" subtitle="Histórico de mensagens enviadas por mês e por inquilino" />

      <div className="p-4 sm:p-6 space-y-4">
        {/* Toolbar: mês + ações */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 bg-card border rounded-lg px-3 py-2 shadow-sm">
            <CalendarIcon className="h-4 w-4 text-muted-foreground" />
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="h-7 text-sm bg-transparent border-0 outline-none w-[140px] font-medium"
            />
            <span className="text-xs text-muted-foreground border-l pl-2">
              {formatMonthLabel(month)}
            </span>
          </div>

          <Button variant="outline" size="sm" onClick={fetchNotifications} className="h-9 gap-1.5">
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            Atualizar
          </Button>

          <div className="ml-auto flex items-center gap-2">
            <Button onClick={handleSendBilling} disabled={sending} size="sm" className="h-9 gap-1.5">
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              {sending ? "Enviando..." : "Enviar Cobranças do Mês"}
            </Button>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <button
            type="button"
            onClick={() => setStatusFilter("todos")}
            className={cn(
              "rounded-lg border bg-card p-3 text-left transition-all shadow-sm hover:shadow",
              statusFilter === "todos" && "ring-2 ring-foreground ring-offset-1"
            )}
          >
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium mb-1">
              <Bell className="h-3.5 w-3.5" />
              Total no mês
            </div>
            <div className="text-2xl font-bold leading-none">{loading ? "..." : stats.total}</div>
            <div className="text-[11px] text-muted-foreground mt-1.5">notificações</div>
          </button>

          <button
            type="button"
            onClick={() => setStatusFilter("ENVIADO")}
            className={cn(
              "rounded-lg border bg-emerald-50/40 border-emerald-200 p-3 text-left transition-all shadow-sm hover:shadow",
              statusFilter === "ENVIADO" && "ring-2 ring-emerald-500 ring-offset-1"
            )}
          >
            <div className="flex items-center gap-1.5 text-xs text-emerald-700 font-medium mb-1">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Enviadas
            </div>
            <div className="text-2xl font-bold text-emerald-900 leading-none">{loading ? "..." : stats.enviadas}</div>
            <div className="text-[11px] text-emerald-700/70 mt-1.5">entregues com sucesso</div>
          </button>

          <button
            type="button"
            onClick={() => setStatusFilter("FALHA")}
            className={cn(
              "rounded-lg border bg-red-50/40 border-red-200 p-3 text-left transition-all shadow-sm hover:shadow",
              statusFilter === "FALHA" && "ring-2 ring-red-500 ring-offset-1"
            )}
          >
            <div className="flex items-center gap-1.5 text-xs text-red-700 font-medium mb-1">
              <XCircle className="h-3.5 w-3.5" />
              Falhas
            </div>
            <div className="text-2xl font-bold text-red-900 leading-none">{loading ? "..." : stats.falhas}</div>
            <div className="text-[11px] text-red-700/70 mt-1.5">erros no envio</div>
          </button>

          <button
            type="button"
            onClick={() => setStatusFilter("PENDENTE")}
            className={cn(
              "rounded-lg border bg-amber-50/40 border-amber-200 p-3 text-left transition-all shadow-sm hover:shadow",
              statusFilter === "PENDENTE" && "ring-2 ring-amber-500 ring-offset-1"
            )}
          >
            <div className="flex items-center gap-1.5 text-xs text-amber-700 font-medium mb-1">
              <Clock className="h-3.5 w-3.5" />
              Pendentes
            </div>
            <div className="text-2xl font-bold text-amber-900 leading-none">{loading ? "..." : stats.pendentes}</div>
            <div className="text-[11px] text-amber-700/70 mt-1.5">aguardando envio</div>
          </button>

          <div className="rounded-lg border bg-violet-50/40 border-violet-200 p-3">
            <div className="flex items-center gap-1.5 text-xs text-violet-700 font-medium mb-1">
              <Send className="h-3.5 w-3.5" />
              Hoje
            </div>
            <div className="text-2xl font-bold text-violet-900 leading-none">{loading ? "..." : stats.hoje}</div>
            <div className="text-[11px] text-violet-700/70 mt-1.5">últimas 24h</div>
          </div>
        </div>

        {/* Filtros de canal + busca + toggle visao */}
        <div className="bg-card border rounded-lg shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b bg-muted/20 flex items-center gap-2 flex-wrap">
            <div className="flex gap-1">
              {(["todas", "WHATSAPP", "EMAIL", "SMS"] as const).map((c) => {
                const Icon = c === "WHATSAPP" ? MessageCircle : c === "EMAIL" ? Mail : c === "SMS" ? Phone : Bell;
                const label = c === "todas" ? "Todos canais" : c === "WHATSAPP" ? "WhatsApp" : c.charAt(0) + c.slice(1).toLowerCase();
                return (
                  <Button
                    key={c}
                    size="sm"
                    variant={channelFilter === c ? "default" : "outline"}
                    className="h-8 text-xs gap-1.5"
                    onClick={() => setChannelFilter(c)}
                  >
                    <Icon className="h-3 w-3" />
                    {label}
                  </Button>
                );
              })}
            </div>

            <div className="relative ml-auto w-full sm:w-[280px]">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Buscar destinatário..."
                className="pl-9 h-8 text-xs"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="flex border rounded-md overflow-hidden">
              <Button
                size="sm"
                variant={visao === "por-inquilino" ? "default" : "ghost"}
                className="h-8 text-xs rounded-none gap-1.5"
                onClick={() => setVisao("por-inquilino")}
              >
                <Users className="h-3 w-3" />
                Por inquilino
              </Button>
              <Button
                size="sm"
                variant={visao === "cronologica" ? "default" : "ghost"}
                className="h-8 text-xs rounded-none gap-1.5"
                onClick={() => setVisao("cronologica")}
              >
                <Clock className="h-3 w-3" />
                Cronológica
              </Button>
            </div>
          </div>

          {/* Lista */}
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin mr-2 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Carregando...</p>
            </div>
          ) : stats.filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Bell className="h-12 w-12 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">
                {search ? "Nenhuma notificação encontrada para a busca." : `Nenhuma notificação em ${formatMonthLabel(month)}.`}
              </p>
              {!search && (
                <p className="text-xs text-muted-foreground/70 mt-1">
                  Clique em &quot;Enviar Cobranças do Mês&quot; para gerar as notificações.
                </p>
              )}
            </div>
          ) : visao === "por-inquilino" ? (
            // ==================================================
            // VISÃO: POR INQUILINO (agregada)
            // ==================================================
            <div className="p-4 space-y-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-muted-foreground">
                  <strong>{tenantSummaries.length}</strong> inquilinos
                  {statusFilter !== "todos" && <span> · filtrado: {statusConfig[statusFilter]?.label || statusFilter}</span>}
                </span>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={expandAll} className="h-7 text-[11px]">Expandir tudo</Button>
                  <Button variant="ghost" size="sm" onClick={collapseAll} className="h-7 text-[11px]">Recolher</Button>
                </div>
              </div>

              {tenantSummaries.map((t) => {
                const isOpen = expandedTenants.has(t.key);
                return (
                  <div key={t.key} className={cn("border rounded-lg overflow-hidden shadow-sm", tenantBadgeClass(t))}>
                    {/* Header do inquilino — clicavel pra expandir */}
                    <button
                      type="button"
                      onClick={() => toggleTenant(t.key)}
                      className="w-full px-4 py-3 flex items-center gap-3 hover:bg-muted/30 transition-colors text-left"
                    >
                      {isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm truncate">{t.recipientName}</span>
                          {t.recipientPhone && (
                            <span className="text-[11px] text-muted-foreground truncate">· {formatPhone(t.recipientPhone)}</span>
                          )}
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">
                          Última: {t.lastDate ? formatDateTime(t.lastDate) : "—"}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {t.enviadas > 0 && (
                          <Badge variant="outline" className="text-[10px] h-5 border-emerald-300 text-emerald-700 bg-emerald-50">
                            <CheckCircle2 className="h-2.5 w-2.5 mr-1" /> {t.enviadas} {t.enviadas === 1 ? "enviada" : "enviadas"}
                          </Badge>
                        )}
                        {t.falhas > 0 && (
                          <Badge variant="outline" className="text-[10px] h-5 border-red-300 text-red-700 bg-red-50">
                            <XCircle className="h-2.5 w-2.5 mr-1" /> {t.falhas} {t.falhas === 1 ? "falha" : "falhas"}
                          </Badge>
                        )}
                        {t.pendentes > 0 && (
                          <Badge variant="outline" className="text-[10px] h-5 border-amber-300 text-amber-700 bg-amber-50">
                            <Clock className="h-2.5 w-2.5 mr-1" /> {t.pendentes}
                          </Badge>
                        )}
                      </div>
                    </button>

                    {/* Lista expandida de notificações */}
                    {isOpen && (
                      <div className="border-t bg-background/60 divide-y">
                        {t.notifications
                          .slice()
                          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                          .map((n) => {
                            const s = statusConfig[n.status] || statusConfig.PENDENTE;
                            const SIcon = s.icon;
                            const TIcon = typeIcons[n.type] || MessageCircle;
                            return (
                              <button
                                key={n.id}
                                onClick={() => { setSelectedNotification(n); setDetailOpen(true); }}
                                className="w-full px-4 py-2.5 hover:bg-muted/30 transition-colors text-left"
                              >
                                <div className="flex items-center gap-3">
                                  <TIcon className={cn(
                                    "h-3.5 w-3.5 shrink-0",
                                    n.type === "WHATSAPP" ? "text-emerald-600" :
                                    n.type === "EMAIL" ? "text-blue-600" : "text-violet-600"
                                  )} />
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs font-medium">
                                        {templateLabels[n.templateKey] || n.templateKey}
                                      </span>
                                      <span className="text-[10px] text-muted-foreground">
                                        · {formatDateTime(n.createdAt)}
                                      </span>
                                    </div>
                                    <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                                      {n.message.slice(0, 100)}{n.message.length > 100 ? "..." : ""}
                                    </div>
                                    {n.status === "FALHA" && n.errorMessage && (
                                      <div className="text-[11px] text-red-600 mt-1 flex items-start gap-1">
                                        <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                                        <span>{n.errorMessage}</span>
                                      </div>
                                    )}
                                  </div>
                                  <Badge variant="outline" className={cn("text-[10px] h-5 shrink-0", s.className)}>
                                    <SIcon className="h-2.5 w-2.5 mr-1" />
                                    {s.label}
                                  </Badge>
                                </div>
                              </button>
                            );
                          })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            // ==================================================
            // VISÃO: CRONOLÓGICA (lista plana)
            // ==================================================
            <div className="divide-y">
              {stats.filtered
                .slice()
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map((n) => {
                  const s = statusConfig[n.status] || statusConfig.PENDENTE;
                  const SIcon = s.icon;
                  const TIcon = typeIcons[n.type] || MessageCircle;
                  return (
                    <button
                      key={n.id}
                      onClick={() => { setSelectedNotification(n); setDetailOpen(true); }}
                      className="w-full px-4 py-3 hover:bg-muted/30 transition-colors text-left"
                    >
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          "h-9 w-9 shrink-0 rounded-lg flex items-center justify-center",
                          n.type === "WHATSAPP" ? "bg-emerald-100" :
                          n.type === "EMAIL" ? "bg-blue-100" : "bg-violet-100"
                        )}>
                          <TIcon className={cn(
                            "h-4 w-4",
                            n.type === "WHATSAPP" ? "text-emerald-600" :
                            n.type === "EMAIL" ? "text-blue-600" : "text-violet-600"
                          )} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium truncate">{n.recipientName}</span>
                            <span className="text-[11px] text-muted-foreground">· {templateLabels[n.templateKey] || n.templateKey}</span>
                          </div>
                          <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                            {n.message.slice(0, 120)}{n.message.length > 120 ? "..." : ""}
                          </div>
                          {n.status === "FALHA" && n.errorMessage && (
                            <div className="text-[11px] text-red-600 mt-1">⚠️ {n.errorMessage}</div>
                          )}
                        </div>
                        <div className="text-right shrink-0">
                          <Badge variant="outline" className={cn("text-[10px] h-5", s.className)}>
                            <SIcon className="h-2.5 w-2.5 mr-1" />
                            {s.label}
                          </Badge>
                          <div className="text-[10px] text-muted-foreground mt-1">
                            {formatDateTime(n.createdAt)}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
            </div>
          )}
        </div>
      </div>

      {/* ---- Detail Dialog ---- */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bell className="h-5 w-5" />
              Detalhes da Notificação
            </DialogTitle>
            <DialogDescription>Informações completas sobre a notificação enviada.</DialogDescription>
          </DialogHeader>
          {selectedNotification && (
            <div className="space-y-3 mt-2 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[11px] text-muted-foreground uppercase tracking-wide">Status</div>
                  {(() => {
                    const s = statusConfig[selectedNotification.status] || statusConfig.PENDENTE;
                    const SIcon = s.icon;
                    return (
                      <Badge variant="outline" className={cn("text-xs mt-1", s.className)}>
                        <SIcon className="h-3 w-3 mr-1" /> {s.label}
                      </Badge>
                    );
                  })()}
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground uppercase tracking-wide">Canal</div>
                  <div className="font-medium">{selectedNotification.type}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground uppercase tracking-wide">Destinatário</div>
                  <div className="font-medium">{selectedNotification.recipientName}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground uppercase tracking-wide">Telefone/Email</div>
                  <div className="font-medium">
                    {selectedNotification.recipientPhone
                      ? formatPhone(selectedNotification.recipientPhone)
                      : selectedNotification.recipientEmail || "-"}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground uppercase tracking-wide">Template</div>
                  <div className="font-medium">
                    {templateLabels[selectedNotification.templateKey] || selectedNotification.templateKey}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground uppercase tracking-wide">Data</div>
                  <div className="font-medium">{formatDate(selectedNotification.createdAt)}</div>
                </div>
              </div>
              <div>
                <div className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">Mensagem</div>
                <div className="bg-muted/30 rounded-md p-3 text-xs whitespace-pre-wrap">{selectedNotification.message}</div>
              </div>
              {selectedNotification.errorMessage && (
                <div>
                  <div className="text-[11px] text-red-700 uppercase tracking-wide mb-1">Erro</div>
                  <div className="bg-red-50 border border-red-200 rounded-md p-3 text-xs text-red-700">
                    {selectedNotification.errorMessage}
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ---- Send Billing Result ---- */}
      <Dialog open={sendResultOpen} onOpenChange={setSendResultOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-5 w-5" />
              Resultado do envio
            </DialogTitle>
          </DialogHeader>
          {sendResult && (
            <div className="space-y-3 mt-2 text-sm">
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-md border bg-emerald-50/40 border-emerald-200 p-3 text-center">
                  <div className="text-2xl font-bold text-emerald-900">{sendResult.sent}</div>
                  <div className="text-[11px] text-emerald-700">Enviadas</div>
                </div>
                <div className="rounded-md border bg-amber-50/40 border-amber-200 p-3 text-center">
                  <div className="text-2xl font-bold text-amber-900">{sendResult.skipped}</div>
                  <div className="text-[11px] text-amber-700">Puladas</div>
                </div>
                <div className="rounded-md border bg-red-50/40 border-red-200 p-3 text-center">
                  <div className="text-2xl font-bold text-red-900">{sendResult.errors}</div>
                  <div className="text-[11px] text-red-700">Erros</div>
                </div>
              </div>
              {sendResult.message && (
                <p className="text-xs text-muted-foreground">{sendResult.message}</p>
              )}
              {sendResult.details.length > 0 && (
                <div className="max-h-[300px] overflow-y-auto border rounded-md divide-y text-xs">
                  {sendResult.details.map((d, idx) => (
                    <div key={idx} className="px-3 py-2 flex items-center justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{d.tenantName}</div>
                        <div className="text-muted-foreground">{d.paymentCode} · {d.action}</div>
                      </div>
                      <span className="text-[11px] shrink-0">{d.result}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
