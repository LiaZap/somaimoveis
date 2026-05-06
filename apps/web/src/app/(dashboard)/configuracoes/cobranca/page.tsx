"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Save, AlertTriangle, Calendar, Percent, Receipt } from "lucide-react";

interface BillingSettings {
  multaTipo: string;
  multaValor: number;
  multaAposVenc: boolean;
  jurosTipo: string;
  jurosValor: number;
  validadeAposVencimentoDias: number;
  diaCorteJurosMulta: number;
  mensagemPadrao: string | null;
  notes: string | null;
}

export default function ConfiguracoesCobrancaPage() {
  const [settings, setSettings] = useState<BillingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/billing-settings")
      .then((r) => r.json())
      .then(setSettings)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  function update<K extends keyof BillingSettings>(field: K, value: BillingSettings[K]) {
    setSettings((prev) => (prev ? { ...prev, [field]: value } : prev));
  }

  async function handleSave() {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await fetch("/api/billing-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Erro");
      }
      const data = await res.json();
      setSettings(data);
      toast.success("Configurações de cobrança salvas");
    } catch (err: any) {
      toast.error(err.message || "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  }

  if (loading || !settings) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Calcular juros equivalente para o usuario entender
  const jurosDiaEquivalente = (() => {
    if (settings.jurosTipo === "PERCENTUAL_MES") return settings.jurosValor / 30;
    if (settings.jurosTipo === "PERCENTUAL_DIA") return settings.jurosValor;
    return null;
  })();

  return (
    <div className="flex flex-col">
      <Header
        title="Configurações de Cobrança"
        subtitle="Multa, juros e validade do PIX após vencimento"
      />

      <div className="p-4 sm:p-6 space-y-6 max-w-3xl">
        {/* Aviso */}
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold text-amber-900">
                Por que isso é importante?
              </p>
              <p className="text-amber-800 mt-1">
                Sem essas configurações, o Sicredi gera o boleto com PIX que
                expira no vencimento. Cliente atrasado não consegue mais pagar
                via PIX. Com juros/multa configurados e validade pós-vencimento,
                o boleto continua sendo aceito (com acréscimos legais) por X
                dias após o vencimento.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Multa */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Receipt className="h-4 w-4 text-muted-foreground" />
              Multa por Atraso
            </CardTitle>
            <CardDescription>
              Cobrada uma única vez, no dia seguinte ao vencimento
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <Checkbox
                id="multaAposVenc"
                checked={settings.multaAposVenc}
                onCheckedChange={(c) => update("multaAposVenc", !!c)}
              />
              <Label htmlFor="multaAposVenc" className="font-normal cursor-pointer text-sm">
                Cobrar multa após vencimento
              </Label>
            </div>

            {settings.multaAposVenc && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="multaTipo">Tipo</Label>
                  <Select
                    value={settings.multaTipo}
                    onValueChange={(v) => update("multaTipo", v)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PERCENTUAL">Percentual (%)</SelectItem>
                      <SelectItem value="VALOR">Valor fixo (R$)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="multaValor">
                    {settings.multaTipo === "PERCENTUAL" ? "Percentual (%)" : "Valor (R$)"}
                  </Label>
                  <Input
                    id="multaValor"
                    type="number"
                    step="0.01"
                    min="0"
                    value={settings.multaValor}
                    onChange={(e) => update("multaValor", parseFloat(e.target.value) || 0)}
                    placeholder="Ex: 2"
                  />
                  <p className="text-xs text-muted-foreground">
                    Padrão de mercado: 2% (limite legal: 2%)
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Juros */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Percent className="h-4 w-4 text-muted-foreground" />
              Juros por Atraso
            </CardTitle>
            <CardDescription>
              Cobrado proporcional aos dias de atraso
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="jurosTipo">Tipo</Label>
                <Select
                  value={settings.jurosTipo}
                  onValueChange={(v) => update("jurosTipo", v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ISENTO">Isento (sem juros)</SelectItem>
                    <SelectItem value="PERCENTUAL_MES">% ao mês</SelectItem>
                    <SelectItem value="PERCENTUAL_DIA">% ao dia</SelectItem>
                    <SelectItem value="VALOR_DIA">R$ por dia</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {settings.jurosTipo !== "ISENTO" && (
                <div className="space-y-1.5">
                  <Label htmlFor="jurosValor">
                    {settings.jurosTipo === "VALOR_DIA" ? "Valor (R$/dia)" : "Percentual (%)"}
                  </Label>
                  <Input
                    id="jurosValor"
                    type="number"
                    step="0.001"
                    min="0"
                    value={settings.jurosValor}
                    onChange={(e) => update("jurosValor", parseFloat(e.target.value) || 0)}
                    placeholder="Ex: 1"
                  />
                  {jurosDiaEquivalente !== null && (
                    <p className="text-xs text-muted-foreground">
                      Equivalente a aprox.{" "}
                      <strong>{jurosDiaEquivalente.toFixed(4)}% ao dia</strong>
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Padrão de mercado: 1% ao mês
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Validade do PIX */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              Validade do PIX após Vencimento
            </CardTitle>
            <CardDescription>
              Quantos dias o PIX (copia e cola) continua válido após vencer
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="validade">Dias após vencimento</Label>
              <Input
                id="validade"
                type="number"
                min="0"
                max="365"
                value={settings.validadeAposVencimentoDias}
                onChange={(e) =>
                  update("validadeAposVencimentoDias", parseInt(e.target.value) || 0)
                }
                placeholder="30"
              />
              <p className="text-xs text-muted-foreground">
                <strong>Recomendado: 30 dias.</strong> Com 0, o PIX expira no
                dia do vencimento (causa o erro &quot;não foi possível pagar&quot;
                que vocês viram). Com 30, o cliente pode pagar via PIX por 30
                dias após vencer (com juros/multa aplicados automaticamente).
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Dia limite juros/multa retidos pela imobiliaria */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Receipt className="h-4 w-4" />
              Destino de Juros e Multa por Atraso
            </CardTitle>
            <CardDescription>
              Define até que dia do mês os juros e multa do inquilino atrasado
              ficam com a imobiliária. Após esse dia, são repassados ao
              proprietário.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="diaCorte">
                Dia de corte (do mês)
              </Label>
              <Input
                id="diaCorte"
                type="number"
                min="1"
                max="31"
                value={settings.diaCorteJurosMulta ?? 10}
                onChange={(e) =>
                  update("diaCorteJurosMulta", parseInt(e.target.value) || 10)
                }
                placeholder="10"
              />
              <p className="text-xs text-muted-foreground leading-relaxed">
                <strong>Padrão: dia 10.</strong> Inquilino paga até esse dia →
                juros/multa fica com a <strong>imobiliária</strong>. Paga
                depois → juros/multa vai pro <strong>proprietário</strong>.
                <br />
                <em>Exceção: contratos com &quot;Aluguel garantido pela imobiliária&quot; marcado
                — juros/multa fica sempre com a imobiliária, independente
                do dia.</em>
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Link pra gestão de paymentDay dos contratos */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Dia de Vencimento dos Boletos (por contrato)
            </CardTitle>
            <CardDescription>
              O dia em que o boleto do inquilino vence é configurado
              individualmente em cada contrato. Use a tela de gestão pra
              ver e editar todos de uma vez.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <a href="/configuracoes/payment-day">
                Gerenciar dia de vencimento dos contratos →
              </a>
            </Button>
          </CardContent>
        </Card>

        {/* Mensagem padrao */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Mensagem Padrão do Boleto</CardTitle>
            <CardDescription>
              Aparece nas instruções do boleto Sicredi
            </CardDescription>
          </CardHeader>
          <CardContent>
            <textarea
              className="w-full min-h-[80px] rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={settings.mensagemPadrao || ""}
              onChange={(e) => update("mensagemPadrao", e.target.value)}
              placeholder="Ex: Apos vencimento: multa de 2% e juros de 1% ao mes."
            />
          </CardContent>
        </Card>

        {/* Save */}
        <div className="flex justify-end gap-2 sticky bottom-0 bg-background py-3 -mx-1 px-1 border-t">
          <Button onClick={handleSave} disabled={saving} className="gap-2">
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Salvar Configurações
          </Button>
        </div>
      </div>
    </div>
  );
}
