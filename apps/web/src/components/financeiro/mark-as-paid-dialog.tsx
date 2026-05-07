"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Loader2, AlertTriangle, CheckCircle2, DollarSign } from "lucide-react";
import { toast } from "sonner";

interface PaymentLite {
  id: string;
  code: string;
  value: number;
  dueDate: string;
  multaTipoBoleto?: string | null;
  multaValorBoleto?: number | null;
  jurosTipoBoleto?: string | null;
  jurosValorBoleto?: number | null;
}

interface BillingRules {
  multaTipo: string;
  multaValor: number;
  multaAposVenc: boolean;
  jurosTipo: string;
  jurosValor: number;
}

interface Props {
  payment: PaymentLite | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

function formatCurrency(v: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(v);
}

function todayLocalISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Calcula juros/multa estimados pra um pagamento numa data especifica.
 * Prioridade: snapshot do boleto > regras globais > fallback hardcoded.
 */
function calcEncargos(
  payment: PaymentLite,
  paidAtISO: string,
  globalSettings: BillingRules | null,
): { fine: number; interest: number; daysLate: number } {
  const due = new Date(payment.dueDate + (payment.dueDate.includes("T") ? "" : "T12:00:00"));
  const paid = new Date(paidAtISO + "T12:00:00");
  const daysLate = Math.max(
    0,
    Math.floor((paid.getTime() - due.getTime()) / 86400000),
  );
  if (daysLate <= 0) return { fine: 0, interest: 0, daysLate: 0 };

  const hasSnapshot =
    payment.multaTipoBoleto != null ||
    payment.multaValorBoleto != null ||
    payment.jurosTipoBoleto != null ||
    payment.jurosValorBoleto != null;

  let multaTipo: string;
  let multaValor: number;
  let multaAposVenc: boolean;
  let jurosTipo: string;
  let jurosValor: number;

  if (hasSnapshot) {
    multaTipo = payment.multaTipoBoleto || "PERCENTUAL";
    multaValor = payment.multaValorBoleto ?? 0;
    multaAposVenc = multaValor > 0;
    jurosTipo = payment.jurosTipoBoleto || "ISENTO";
    jurosValor = payment.jurosValorBoleto ?? 0;
  } else if (globalSettings) {
    multaTipo = globalSettings.multaTipo;
    multaValor = globalSettings.multaValor;
    multaAposVenc = globalSettings.multaAposVenc;
    jurosTipo = globalSettings.jurosTipo;
    jurosValor = globalSettings.jurosValor;
  } else {
    multaTipo = "PERCENTUAL";
    multaValor = 2;
    multaAposVenc = true;
    jurosTipo = "PERCENTUAL_MES";
    jurosValor = 1;
  }

  let fine = 0;
  if (multaAposVenc && multaValor > 0) {
    fine =
      multaTipo === "PERCENTUAL"
        ? (payment.value * multaValor) / 100
        : multaValor;
  }

  let interest = 0;
  if (jurosTipo === "PERCENTUAL_MES" || jurosTipo === "PERCENTUAL") {
    interest = ((payment.value * jurosValor) / 100 / 30) * daysLate;
  } else if (jurosTipo === "PERCENTUAL_DIA") {
    interest = ((payment.value * jurosValor) / 100) * daysLate;
  } else if (jurosTipo === "VALOR_DIA" || jurosTipo === "VALOR") {
    interest = jurosValor * daysLate;
  }

  return {
    fine: Math.round(fine * 100) / 100,
    interest: Math.round(interest * 100) / 100,
    daysLate,
  };
}

export function MarkAsPaidDialog({ payment, open, onOpenChange, onSuccess }: Props) {
  const [paidAt, setPaidAt] = useState<string>(todayLocalISO());
  const [paymentMethod, setPaymentMethod] = useState<string>("DINHEIRO");
  const [cobrarEncargos, setCobrarEncargos] = useState<boolean>(true);
  const [fineValue, setFineValue] = useState<string>("0");
  const [interestValue, setInterestValue] = useState<string>("0");
  const [paidValue, setPaidValue] = useState<string>("");
  const [billingSettings, setBillingSettings] = useState<BillingRules | null>(null);
  const [loading, setLoading] = useState(false);
  const [manualOverride, setManualOverride] = useState(false);

  // Carrega regras globais ao abrir
  useEffect(() => {
    if (!open) return;
    fetch("/api/billing-settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (s && !s.error) {
          setBillingSettings({
            multaTipo: s.multaTipo || "PERCENTUAL",
            multaValor: s.multaValor ?? 2,
            multaAposVenc: s.multaAposVenc ?? true,
            jurosTipo: s.jurosTipo || "PERCENTUAL_MES",
            jurosValor: s.jurosValor ?? 1,
          });
        }
      })
      .catch(() => { /* ignore */ });
  }, [open]);

  // Reset ao abrir / mudar pagamento
  useEffect(() => {
    if (!open || !payment) return;
    setPaidAt(todayLocalISO());
    setPaymentMethod("DINHEIRO");
    setCobrarEncargos(true);
    setManualOverride(false);
  }, [open, payment?.id]);

  // Recalcula automaticamente sempre que paidAt, cobrarEncargos ou settings mudam
  useEffect(() => {
    if (!payment) return;
    if (manualOverride) return; // usuario tomou controle, nao sobrescreve

    const enc = calcEncargos(payment, paidAt, billingSettings);
    if (cobrarEncargos) {
      setFineValue(enc.fine.toFixed(2));
      setInterestValue(enc.interest.toFixed(2));
      setPaidValue((payment.value + enc.fine + enc.interest).toFixed(2));
    } else {
      setFineValue("0.00");
      setInterestValue("0.00");
      setPaidValue(payment.value.toFixed(2));
    }
  }, [payment, paidAt, cobrarEncargos, billingSettings, manualOverride]);

  if (!payment) return null;

  const enc = calcEncargos(payment, paidAt, billingSettings);
  const isLate = enc.daysLate > 0;

  async function handleConfirm() {
    if (!payment) return;
    setLoading(true);
    try {
      const fine = parseFloat(fineValue) || 0;
      const interest = parseFloat(interestValue) || 0;
      const paid = parseFloat(paidValue) || 0;

      const res = await fetch(`/api/payments/${payment.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "PAGO",
          paidAt: paidAt + "T12:00:00",
          paidValue: paid,
          fineValue: fine || null,
          interestValue: interest || null,
          paymentMethod,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j?.error || "Erro ao marcar como pago");
        return;
      }
      toast.success(
        isLate && cobrarEncargos
          ? `Pagamento confirmado com juros/multa de ${formatCurrency(fine + interest)}.`
          : isLate
          ? "Pagamento confirmado SEM juros/multa (isento)."
          : "Pagamento confirmado.",
      );
      onSuccess();
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err?.message || "Erro ao marcar como pago");
    } finally {
      setLoading(false);
    }
  }

  const total =
    (parseFloat(paidValue) || 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            Marcar Pagamento como Pago
          </DialogTitle>
          <DialogDescription>
            {payment.code} — Valor original: <strong>{formatCurrency(payment.value)}</strong> — Vencimento{" "}
            {new Date(payment.dueDate).toLocaleDateString("pt-BR", { timeZone: "UTC" })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Data e forma */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="paidAt" className="text-xs">
                Data do pagamento
              </Label>
              <Input
                id="paidAt"
                type="date"
                value={paidAt}
                onChange={(e) => setPaidAt(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="paymentMethod" className="text-xs">
                Forma de pagamento
              </Label>
              <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                <SelectTrigger id="paymentMethod">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DINHEIRO">Dinheiro</SelectItem>
                  <SelectItem value="PIX">PIX</SelectItem>
                  <SelectItem value="TRANSFERENCIA">Transferência</SelectItem>
                  <SelectItem value="BOLETO">Boleto</SelectItem>
                  <SelectItem value="CARTAO">Cartão</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Toggle de cobrar encargos quando atrasado */}
          {isLate && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-amber-900">
                    <AlertTriangle className="h-4 w-4" />
                    Pagamento atrasado: {enc.daysLate} dia
                    {enc.daysLate > 1 ? "s" : ""}
                  </div>
                  <div className="text-xs text-amber-800 mt-0.5">
                    Cobrar juros e multa do cliente?
                  </div>
                </div>
                <Switch
                  checked={cobrarEncargos}
                  onCheckedChange={(v) => {
                    setCobrarEncargos(v);
                    setManualOverride(false);
                  }}
                />
              </div>

              {cobrarEncargos && (
                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-amber-200">
                  <div className="space-y-1">
                    <Label htmlFor="fineValue" className="text-[11px]">
                      Multa (R$)
                    </Label>
                    <Input
                      id="fineValue"
                      type="number"
                      step="0.01"
                      value={fineValue}
                      onChange={(e) => {
                        setFineValue(e.target.value);
                        setManualOverride(true);
                      }}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="interestValue" className="text-[11px]">
                      Juros (R$)
                    </Label>
                    <Input
                      id="interestValue"
                      type="number"
                      step="0.01"
                      value={interestValue}
                      onChange={(e) => {
                        setInterestValue(e.target.value);
                        setManualOverride(true);
                      }}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
              )}

              {!cobrarEncargos && (
                <div className="text-[11px] text-amber-800 italic">
                  Cliente isento de juros/multa neste pagamento.
                </div>
              )}
            </div>
          )}

          {/* Valor total recebido (editavel) */}
          <div className="space-y-1.5">
            <Label htmlFor="paidValue" className="text-xs flex items-center gap-1">
              <DollarSign className="h-3.5 w-3.5" />
              Valor total recebido
            </Label>
            <Input
              id="paidValue"
              type="number"
              step="0.01"
              value={paidValue}
              onChange={(e) => {
                setPaidValue(e.target.value);
                setManualOverride(true);
              }}
              className="font-semibold"
            />
            {!manualOverride && isLate && cobrarEncargos && (
              <p className="text-[11px] text-muted-foreground">
                = {formatCurrency(payment.value)} (original) +{" "}
                {formatCurrency(enc.fine + enc.interest)} (encargos)
              </p>
            )}
          </div>

          {/* Resumo */}
          <div className="rounded-md bg-muted/30 border p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Valor original:</span>
              <span>{formatCurrency(payment.value)}</span>
            </div>
            {isLate && cobrarEncargos && (
              <>
                <div className="flex justify-between text-rose-700">
                  <span>+ Multa:</span>
                  <span>{formatCurrency(parseFloat(fineValue) || 0)}</span>
                </div>
                <div className="flex justify-between text-rose-700">
                  <span>+ Juros ({enc.daysLate} dia{enc.daysLate > 1 ? "s" : ""}):</span>
                  <span>{formatCurrency(parseFloat(interestValue) || 0)}</span>
                </div>
              </>
            )}
            <div className="flex justify-between font-bold border-t mt-1.5 pt-1.5">
              <span>Total recebido:</span>
              <span className="text-emerald-700">{formatCurrency(total)}</span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancelar
          </Button>
          <Button onClick={handleConfirm} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                Salvando...
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4 mr-1" />
                Confirmar pagamento
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
