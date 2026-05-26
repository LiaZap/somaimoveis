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
import { Loader2, Save, FileText, ShieldCheck, Building2, MapPin, Receipt, Globe, Webhook, CheckCircle2, XCircle, RefreshCw } from "lucide-react";

interface FiscalSettings {
  razaoSocial: string | null;
  cnpj: string | null;
  inscricaoMunicipal: string | null;
  inscricaoEstadual: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  cnae: string | null;
  codigoServicoMunicipal: string | null;
  aliquotaIss: number | null;
  regimeTributario: string | null;
  optanteSimples: boolean;
  simplesAliquota: number | null;
  incentivadorCultural: boolean;
  retemIss: boolean;
  certificadoNome: string | null;
  certificadoExpiraEm: string | null;
  certificadoUploaded: boolean;
  certificadoPasswordSet: boolean;
  provedor: string | null;
  apiTokenSet: boolean;
  ambiente: string;
  notes: string | null;
}

export default function ConfiguracoesFiscalPage() {
  const [settings, setSettings] = useState<FiscalSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [apiTokenInput, setApiTokenInput] = useState("");
  // Certificate upload
  const [certFile, setCertFile] = useState<File | null>(null);
  const [certPwdInput, setCertPwdInput] = useState("");
  const [uploadingCert, setUploadingCert] = useState(false);
  const [removingCert, setRemovingCert] = useState(false);

  async function reloadSettings() {
    const res = await fetch("/api/fiscal-settings");
    if (res.ok) {
      const data = await res.json();
      setSettings(data);
    }
  }

  async function handleUploadCertificate() {
    if (!certFile || !certPwdInput) return;
    setUploadingCert(true);
    try {
      const formData = new FormData();
      formData.append("certificate", certFile);
      formData.append("password", certPwdInput);
      const res = await fetch("/api/fiscal-settings/certificate", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro ao subir certificado");
      toast.success(data.message || "Certificado carregado");
      setCertFile(null);
      setCertPwdInput("");
      // Limpa o input file na DOM
      const input = document.getElementById("certFile") as HTMLInputElement;
      if (input) input.value = "";
      await reloadSettings();
    } catch (err: any) {
      toast.error(err.message || "Erro ao subir certificado");
    } finally {
      setUploadingCert(false);
    }
  }

  async function handleRemoveCertificate() {
    if (!confirm("Remover o certificado salvo? Voce tera que subir novamente para emitir NFs.")) {
      return;
    }
    setRemovingCert(true);
    try {
      const res = await fetch("/api/fiscal-settings/certificate", {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro ao remover");
      toast.success(data.message || "Certificado removido");
      await reloadSettings();
    } catch (err: any) {
      toast.error(err.message || "Erro ao remover certificado");
    } finally {
      setRemovingCert(false);
    }
  }

  useEffect(() => {
    fetch("/api/fiscal-settings")
      .then((r) => r.json())
      .then((data) => setSettings(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  function update<K extends keyof FiscalSettings>(field: K, value: FiscalSettings[K]) {
    setSettings((prev) => (prev ? { ...prev, [field]: value } : prev));
  }

  async function handleSave() {
    if (!settings) return;
    setSaving(true);
    try {
      const payload: any = { ...settings };
      // Apenas enviar apiToken se digitou um valor novo
      if (apiTokenInput) {
        payload.apiToken = apiTokenInput;
      } else {
        delete payload.apiToken;
      }
      // Formatar data de validade do certificado
      if (settings.certificadoExpiraEm) {
        payload.certificadoExpiraEm = String(settings.certificadoExpiraEm).split("T")[0];
      }

      const res = await fetch("/api/fiscal-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Erro ao salvar");
      }
      const data = await res.json();
      setSettings(data);
      setApiTokenInput("");
      toast.success("Configurações fiscais salvas com sucesso");
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

  return (
    <div className="flex flex-col">
      <Header
        title="Configurações Fiscais"
        subtitle="Dados para emissão de NFS-e (Notas Fiscais de Serviço Eletrônica)"
      />

      <div className="p-4 sm:p-6 space-y-6 max-w-4xl">
        {/* Aviso de status */}
        <Card className="border-blue-200 bg-blue-50">
          <CardContent className="p-4 flex items-start gap-3">
            <FileText className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold text-blue-900">Como funciona</p>
              <p className="text-blue-800 mt-1">
                Preencha aqui os dados que serão usados na emissão de NFS-e.
                A integração efetiva com a prefeitura/provedor depende do
                certificado digital A1 e cadastro no provedor escolhido.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Dados da empresa */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              Dados da Empresa
            </CardTitle>
            <CardDescription>
              Informações cadastrais da prestadora de serviço
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="razaoSocial">Razão Social</Label>
                <Input
                  id="razaoSocial"
                  value={settings.razaoSocial || ""}
                  onChange={(e) => update("razaoSocial", e.target.value)}
                  placeholder="Somma Imóveis Ltda"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cnpj">CNPJ</Label>
                <Input
                  id="cnpj"
                  value={settings.cnpj || ""}
                  onChange={(e) => update("cnpj", e.target.value)}
                  placeholder="00.000.000/0000-00"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="inscricaoMunicipal">Inscrição Municipal *</Label>
                <Input
                  id="inscricaoMunicipal"
                  value={settings.inscricaoMunicipal || ""}
                  onChange={(e) => update("inscricaoMunicipal", e.target.value)}
                  placeholder="Necessária para NFS-e"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="inscricaoEstadual">Inscrição Estadual</Label>
                <Input
                  id="inscricaoEstadual"
                  value={settings.inscricaoEstadual || ""}
                  onChange={(e) => update("inscricaoEstadual", e.target.value)}
                  placeholder="Opcional"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Endereco */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              Endereço Fiscal
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="street">Logradouro</Label>
                <Input
                  id="street"
                  value={settings.street || ""}
                  onChange={(e) => update("street", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="number">Número</Label>
                <Input
                  id="number"
                  value={settings.number || ""}
                  onChange={(e) => update("number", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="complement">Complemento</Label>
                <Input
                  id="complement"
                  value={settings.complement || ""}
                  onChange={(e) => update("complement", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="neighborhood">Bairro</Label>
                <Input
                  id="neighborhood"
                  value={settings.neighborhood || ""}
                  onChange={(e) => update("neighborhood", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="zipCode">CEP</Label>
                <Input
                  id="zipCode"
                  value={settings.zipCode || ""}
                  onChange={(e) => update("zipCode", e.target.value)}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="city">Cidade</Label>
                <Input
                  id="city"
                  value={settings.city || ""}
                  onChange={(e) => update("city", e.target.value)}
                  placeholder="Santa Cruz do Sul"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="state">UF</Label>
                <Input
                  id="state"
                  value={settings.state || ""}
                  onChange={(e) => update("state", e.target.value)}
                  placeholder="RS"
                  maxLength={2}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Tributos */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Receipt className="h-4 w-4 text-muted-foreground" />
              Tributos e Regime
            </CardTitle>
            <CardDescription>
              Códigos de serviço e impostos. Pegue com sua contadora.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="cnae">CNAE Principal</Label>
                <Input
                  id="cnae"
                  value={settings.cnae || ""}
                  onChange={(e) => update("cnae", e.target.value)}
                  placeholder="6822-6/00 (Adm de imóveis)"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="codigoServicoMunicipal">Código de Serviço (LC 116/2003)</Label>
                <Input
                  id="codigoServicoMunicipal"
                  value={settings.codigoServicoMunicipal || ""}
                  onChange={(e) => update("codigoServicoMunicipal", e.target.value)}
                  placeholder="17.13 (Administração de bens)"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="aliquotaIss">Alíquota ISS (%)</Label>
                <Input
                  id="aliquotaIss"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={settings.aliquotaIss ?? ""}
                  onChange={(e) =>
                    update("aliquotaIss", e.target.value === "" ? null : parseFloat(e.target.value))
                  }
                  placeholder="Ex: 5"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="regimeTributario">Regime Tributário</Label>
                <Select
                  value={settings.regimeTributario || ""}
                  onValueChange={(v) => update("regimeTributario", v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MEI">MEI</SelectItem>
                    <SelectItem value="SIMPLES_NACIONAL">Simples Nacional</SelectItem>
                    <SelectItem value="LUCRO_PRESUMIDO">Lucro Presumido</SelectItem>
                    <SelectItem value="LUCRO_REAL">Lucro Real</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {settings.regimeTributario === "SIMPLES_NACIONAL" && (
              <div className="space-y-1.5 max-w-md">
                <Label htmlFor="simplesAliquota">Alíquota efetiva do Simples Nacional (%)</Label>
                <Input
                  id="simplesAliquota"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={settings.simplesAliquota ?? ""}
                  onChange={(e) =>
                    update("simplesAliquota", e.target.value === "" ? null : parseFloat(e.target.value))
                  }
                  placeholder="Ex: 6"
                />
                <p className="text-xs text-muted-foreground">
                  Alíquota efetiva do mês corrente, calculada pela contadora com base na RBT12.
                  Atualize sempre que a contadora informar uma nova alíquota — a NFS-e Nacional
                  exige esse campo no XML pra prestadores Optantes do Simples.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="optanteSimples"
                  checked={settings.optanteSimples}
                  onCheckedChange={(c) => update("optanteSimples", !!c)}
                />
                <Label htmlFor="optanteSimples" className="font-normal cursor-pointer text-sm">
                  Optante pelo Simples Nacional
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="retemIss"
                  checked={settings.retemIss}
                  onCheckedChange={(c) => update("retemIss", !!c)}
                />
                <Label htmlFor="retemIss" className="font-normal cursor-pointer text-sm">
                  ISS Retido na fonte (raro para imobiliárias)
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="incentivadorCultural"
                  checked={settings.incentivadorCultural}
                  onCheckedChange={(c) => update("incentivadorCultural", !!c)}
                />
                <Label htmlFor="incentivadorCultural" className="font-normal cursor-pointer text-sm">
                  Incentivador Cultural
                </Label>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Provedor de NFS-e */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Globe className="h-4 w-4 text-muted-foreground" />
              Provedor de Emissão
            </CardTitle>
            <CardDescription>
              Como o sistema vai enviar a NFS-e para o município
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="provedor">Provedor</Label>
                <Select
                  value={settings.provedor || ""}
                  onValueChange={(v) => update("provedor", v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione o provedor" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MANUAL">
                      Manual (apenas exporta dados)
                    </SelectItem>
                    <SelectItem value="NFSE_NACIONAL">
                      NFS-e Nacional (gov.br) - GRATUITO
                    </SelectItem>
                    <SelectItem value="NFE_IO">
                      NFE.io (R$ 0,29/nota)
                    </SelectItem>
                    <SelectItem value="PLUG_NOTAS">
                      Plug Notas (R$ 0,40/nota)
                    </SelectItem>
                    <SelectItem value="GISSONLINE">
                      GISSONLINE (Santa Cruz do Sul, direto)
                    </SelectItem>
                    <SelectItem value="SPEDY">
                      Spedy NFe (api.spedy.com.br)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ambiente">Ambiente</Label>
                <Select
                  value={settings.ambiente}
                  onValueChange={(v) => update("ambiente", v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="HOMOLOGACAO">Homologação (testes)</SelectItem>
                    <SelectItem value="PRODUCAO">Produção (real)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="apiToken">
                  Token / API Key {settings.apiTokenSet && <span className="text-xs text-emerald-600 ml-2">(configurado)</span>}
                </Label>
                <Input
                  id="apiToken"
                  type="password"
                  value={apiTokenInput}
                  onChange={(e) => setApiTokenInput(e.target.value)}
                  placeholder={settings.apiTokenSet ? "Deixe em branco para manter o atual" : "Cole o token do provedor"}
                />
                <p className="text-xs text-muted-foreground">
                  Token armazenado de forma criptografada
                </p>
              </div>
            </div>

            {/* Configuracao automatica de webhook (Spedy) */}
            {settings.provedor === "SPEDY" && settings.apiTokenSet && (
              <SpedyWebhookSection />
            )}
          </CardContent>
        </Card>

        {/* Certificado Digital */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
              Certificado Digital A1
            </CardTitle>
            <CardDescription>
              Necessário em qualquer modalidade de emissão direta de NFS-e
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Status do certificado uploaded */}
            {settings.certificadoUploaded ? (
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 flex items-start gap-3">
                <ShieldCheck className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
                <div className="flex-1 text-sm">
                  <p className="font-semibold text-emerald-900">
                    Certificado A1 carregado
                  </p>
                  <p className="text-emerald-700 text-xs mt-0.5">
                    {settings.certificadoNome || "arquivo .pfx"}
                    {settings.certificadoPasswordSet && " - senha salva (criptografada)"}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs h-7"
                  onClick={handleRemoveCertificate}
                  disabled={removingCert}
                >
                  Remover
                </Button>
              </div>
            ) : (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
                <strong>Nenhum certificado carregado.</strong> Faça upload do
                arquivo .pfx (e a senha) abaixo para emitir NFS-e.
              </div>
            )}

            {/* Upload */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="certFile">Arquivo .pfx ou .p12</Label>
                <Input
                  id="certFile"
                  type="file"
                  accept=".pfx,.p12"
                  onChange={(e) => setCertFile(e.target.files?.[0] || null)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="certPwd">Senha do certificado</Label>
                <Input
                  id="certPwd"
                  type="password"
                  value={certPwdInput}
                  onChange={(e) => setCertPwdInput(e.target.value)}
                  placeholder="••••••••"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={handleUploadCertificate}
                disabled={!certFile || !certPwdInput || uploadingCert}
                className="gap-2"
              >
                {uploadingCert && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {uploadingCert ? "Enviando..." : "Enviar certificado"}
              </Button>
              {settings.certificadoUploaded && (
                <p className="text-xs text-muted-foreground">
                  Re-enviar substitui o certificado atual.
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t">
              <div className="space-y-1.5">
                <Label htmlFor="certificadoNome">Identificação manual</Label>
                <Input
                  id="certificadoNome"
                  value={settings.certificadoNome || ""}
                  onChange={(e) => update("certificadoNome", e.target.value)}
                  placeholder="Ex: Somma_A1_2026.pfx"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="certificadoExpiraEm">Validade (anote manual)</Label>
                <Input
                  id="certificadoExpiraEm"
                  type="date"
                  value={
                    settings.certificadoExpiraEm
                      ? String(settings.certificadoExpiraEm).split("T")[0]
                      : ""
                  }
                  onChange={(e) =>
                    update("certificadoExpiraEm", e.target.value || null)
                  }
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Observacoes */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Observações</CardTitle>
          </CardHeader>
          <CardContent>
            <textarea
              className="w-full min-h-[80px] rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={settings.notes || ""}
              onChange={(e) => update("notes", e.target.value)}
              placeholder="Notas internas sobre configuracoes fiscais..."
            />
          </CardContent>
        </Card>

        {/* Save button */}
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

// ============================================================================
// Componente: configuracao automatica de webhook Spedy
// Spedy nao oferece UI no painel deles — entao a gente cadastra via API REST
// pra eles, apontando pro nosso /api/webhook/spedy.
// ============================================================================

interface SpedyWebhookItem {
  id: string;
  url: string;
  event?: string;
  events?: string[];
  enabled?: boolean;
  description?: string;
}

function SpedyWebhookSection() {
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [webhooks, setWebhooks] = useState<SpedyWebhookItem[]>([]);
  const [error, setError] = useState<{ message: string; details?: unknown } | null>(null);
  const [lastReceiverUrl, setLastReceiverUrl] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/fiscal-settings/spedy-webhook");
      const data = await res.json();
      if (!res.ok) {
        setError({ message: data.error || "Erro ao listar webhooks", details: data.details });
        setWebhooks([]);
      } else {
        setWebhooks(data.webhooks || []);
      }
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : "Erro" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function configurar() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/fiscal-settings/spedy-webhook", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError({ message: data.error || "Erro ao configurar webhook", details: data.details });
        if (data.receiverUrl) setLastReceiverUrl(data.receiverUrl);
        return;
      }
      setLastReceiverUrl(data.receiverUrl);
      toast.success(
        data.removidos > 0
          ? `Webhook configurado (${data.removidos} duplicado(s) removido(s))`
          : "Webhook configurado com sucesso!"
      );
      await load();
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : "Erro" });
    } finally {
      setCreating(false);
    }
  }

  async function remover(id: string) {
    if (!confirm("Remover este webhook da Spedy?")) return;
    try {
      const res = await fetch(`/api/fiscal-settings/spedy-webhook?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Erro ao remover");
        return;
      }
      toast.success("Webhook removido");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro");
    }
  }

  const ourReceiverConfigured = webhooks.some((w) =>
    /\/api\/webhook\/spedy$/i.test(w.url || "")
  );

  return (
    <div className="border-t pt-4 mt-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Webhook className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-sm font-semibold">Webhook Spedy (notificações em tempo real)</h4>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading} className="gap-1.5 h-7 text-xs">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Atualizar
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        A Spedy <strong>não tem opção de webhook no painel deles</strong> — só via API.
        Clique no botão abaixo pra cadastrar automaticamente o endereço do nosso receiver
        (assim você não precisa ficar atualizando manualmente o status das notas).
      </p>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 p-2 text-xs text-red-700 space-y-1">
          <div>{error.message}</div>
          {error.details != null && (
            <pre className="text-[10px] bg-red-100 p-1.5 rounded overflow-x-auto whitespace-pre-wrap break-all">
              {typeof error.details === "string"
                ? error.details
                : JSON.stringify(error.details, null, 2)}
            </pre>
          )}
        </div>
      )}

      {!loading && webhooks.length === 0 && !error && (
        <div className="rounded-md bg-amber-50 border border-amber-200 p-2 text-xs text-amber-800 flex items-start gap-2">
          <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>Nenhum webhook cadastrado na Spedy. Clique em "Configurar Webhook" abaixo.</span>
        </div>
      )}

      {ourReceiverConfigured && (
        <div className="rounded-md bg-emerald-50 border border-emerald-200 p-2 text-xs text-emerald-800 flex items-start gap-2">
          <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>Webhook configurado corretamente apontando para este sistema.</span>
        </div>
      )}

      {webhooks.length > 0 && (
        <div className="border rounded-md divide-y text-xs">
          {webhooks.map((w) => (
            <div key={w.id} className="p-2 flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[11px] truncate">{w.url}</div>
                <div className="text-muted-foreground mt-0.5">
                  {w.event || (w.events || []).join(", ") || "—"}
                  {w.enabled === false && <span className="text-red-600 ml-2">(desabilitado)</span>}
                </div>
              </div>
              <Button variant="ghost" size="sm" className="h-6 text-[11px] text-red-600" onClick={() => remover(w.id)}>
                Remover
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={configurar} disabled={creating} size="sm" className="gap-1.5">
          {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Webhook className="h-3.5 w-3.5" />}
          {ourReceiverConfigured ? "Recadastrar Webhook" : "Configurar Webhook"}
        </Button>
        {lastReceiverUrl && (
          <code className="text-[11px] text-muted-foreground bg-muted px-2 py-1 rounded">
            {lastReceiverUrl}
          </code>
        )}
      </div>
    </div>
  );
}
