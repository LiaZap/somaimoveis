"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Search, Trash2 } from "lucide-react";
import { useCepLookup } from "@/hooks/use-cep-lookup";
import { useCnpjLookup } from "@/hooks/use-cnpj-lookup";
import { formatPhone as formatPhoneShared } from "@/lib/format-phone";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ownerSchema = z.object({
  name: z.string().min(1, "Nome é obrigatório"),
  cpfCnpj: z.string().min(1, "CPF/CNPJ é obrigatório"),
  personType: z.string().default("PF"),
  email: z.string().email("Email invalido").or(z.literal("")).optional(),
  phone: z.string().optional(),
  phone2: z.string().optional(),
  email2: z.string().email("Email invalido").or(z.literal("")).optional(),
  street: z.string().optional(),
  number: z.string().optional(),
  complement: z.string().optional(),
  neighborhood: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  stateRegistration: z.string().optional(),
  rgIssuer: z.string().optional(),
  birthDate: z.string().optional(),
  bankName: z.string().optional(),
  bankAgency: z.string().optional(),
  bankAccount: z.string().optional(),
  bankPixType: z.string().optional(),
  bankPix: z.string().optional(),
  thirdPartyName: z.string().optional(),
  thirdPartyDocument: z.string().optional(),
  thirdPartyBank: z.string().optional(),
  thirdPartyAgency: z.string().optional(),
  thirdPartyAccount: z.string().optional(),
  thirdPartyPixKeyType: z.string().optional(),
  thirdPartyPix: z.string().optional(),
  paymentDay: z.coerce.number().min(1).max(31).default(10),
  notes: z.string().optional(),
});

type OwnerFormData = z.infer<typeof ownerSchema>;

interface OwnerFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  owner?: any;
  onSuccess: () => void;
}

interface BeneficiaryRow {
  name: string;
  pixKey: string;
  pixKeyType: string;
  percentage: string; // string no form para permitir digitar livremente
}

const EMPTY_BENEF: BeneficiaryRow = { name: "", pixKey: "", pixKeyType: "CPF", percentage: "" };

export function OwnerForm({ open, onOpenChange, owner, onSuccess }: OwnerFormProps) {
  const [loading, setLoading] = useState(false);
  const [beneficiaries, setBeneficiaries] = useState<BeneficiaryRow[]>([]);
  const isEditing = !!owner;

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<OwnerFormData>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(ownerSchema) as any,
    defaultValues: {
      name: "",
      cpfCnpj: "",
      personType: "PF",
      email: "",
      phone: "",
      phone2: "",
      email2: "",
      street: "",
      number: "",
      complement: "",
      neighborhood: "",
      city: "",
      state: "",
      zipCode: "",
      stateRegistration: "",
      rgIssuer: "",
      birthDate: "",
      bankName: "",
      bankAgency: "",
      bankAccount: "",
      bankPixType: "",
      bankPix: "",
      thirdPartyName: "",
      thirdPartyDocument: "",
      thirdPartyBank: "",
      thirdPartyAgency: "",
      thirdPartyAccount: "",
      thirdPartyPixKeyType: "",
      thirdPartyPix: "",
      paymentDay: 10,
      notes: "",
    },
  });

  const personType = watch("personType");

  const handleCepResult = useCallback((data: { street: string; neighborhood: string; city: string; state: string }) => {
    setValue("street", data.street, { shouldValidate: true });
    setValue("neighborhood", data.neighborhood, { shouldValidate: true });
    setValue("city", data.city, { shouldValidate: true });
    setValue("state", data.state, { shouldValidate: true });
  }, [setValue]);

  const { lookup: lookupCep, loading: cepLoading, error: cepError, formatCep } = useCepLookup({ onResult: handleCepResult });

  const handleCnpjResult = useCallback((data: { name: string; email: string; phone: string; street: string; number: string; complement: string; neighborhood: string; city: string; state: string; zipCode: string }) => {
    const fields: [keyof OwnerFormData, string][] = [
      ["name", data.name], ["email", data.email], ["phone", data.phone],
      ["street", data.street], ["number", data.number], ["complement", data.complement],
      ["neighborhood", data.neighborhood], ["city", data.city], ["state", data.state],
      ["zipCode", data.zipCode],
    ];
    // Set react-hook-form values
    for (const [field, value] of fields) {
      if (value) setValue(field, value, { shouldValidate: true, shouldDirty: true });
    }
    // Update DOM after React re-render
    requestAnimationFrame(() => {
      for (const [field, value] of fields) {
        if (!value) continue;
        const el = document.getElementById(field) as HTMLInputElement;
        if (el) el.value = value;
      }
    });
  }, [setValue]);

  const { lookup: lookupCnpj, loading: cnpjLoading, error: cnpjError, formatCpfCnpj } = useCnpjLookup({ onResult: handleCnpjResult });

  const formatPhone = useCallback((value: string): string => formatPhoneShared(value), []);

  const DRAFT_KEY = "somma-draft-owner";

  useEffect(() => {
    if (open) {
      if (owner) {
        reset({
          name: owner.name || "",
          cpfCnpj: owner.cpfCnpj || "",
          personType: owner.personType || "PF",
          email: owner.email || "",
          phone: owner.phone || "",
          phone2: owner.phone2 || "",
          email2: owner.email2 || "",
          street: owner.street || "",
          number: owner.number || "",
          complement: owner.complement || "",
          neighborhood: owner.neighborhood || "",
          city: owner.city || "",
          state: owner.state || "",
          zipCode: owner.zipCode || "",
          stateRegistration: owner.stateRegistration || "",
          rgIssuer: owner.rgIssuer || "",
          birthDate: owner.birthDate ? String(owner.birthDate).split("T")[0] : "",
          bankName: owner.bankName || "",
          bankAgency: owner.bankAgency || "",
          bankAccount: owner.bankAccount || "",
          bankPixType: owner.bankPixType || "",
          bankPix: owner.bankPix || "",
          thirdPartyName: owner.thirdPartyName || "",
          thirdPartyDocument: owner.thirdPartyDocument || "",
          thirdPartyBank: owner.thirdPartyBank || "",
          thirdPartyAgency: owner.thirdPartyAgency || "",
          thirdPartyAccount: owner.thirdPartyAccount || "",
          thirdPartyPixKeyType: owner.thirdPartyPixKeyType || "",
          thirdPartyPix: owner.thirdPartyPix || "",
          paymentDay: owner.paymentDay ?? 10,
          notes: owner.notes || "",
        });
        // Carrega beneficiarios de repasse cadastrados (Fase 2.9 — caso Roberta)
        if (Array.isArray(owner.payoutBeneficiaries)) {
          setBeneficiaries(
            owner.payoutBeneficiaries.map((b: any) => ({
              name: b.name || "",
              pixKey: b.pixKey || "",
              pixKeyType: b.pixKeyType || "CPF",
              percentage: b.percentage != null ? String(b.percentage) : "",
            }))
          );
        } else {
          setBeneficiaries([]);
        }
      } else {
        // Novo cadastro: limpa beneficiarios
        setBeneficiaries([]);
        // Try to restore draft
        try {
          const draft = localStorage.getItem(DRAFT_KEY);
          if (draft) {
            const parsed = JSON.parse(draft);
            reset(parsed);
          } else {
            reset({
              name: "", cpfCnpj: "", personType: "PF", email: "", phone: "", phone2: "", email2: "",
              street: "", number: "", complement: "", neighborhood: "",
              city: "", state: "", zipCode: "", stateRegistration: "",
              rgIssuer: "", birthDate: "",
              bankName: "", bankAgency: "", bankAccount: "", bankPixType: "", bankPix: "",
              thirdPartyName: "", thirdPartyDocument: "", thirdPartyBank: "",
              thirdPartyAgency: "", thirdPartyAccount: "", thirdPartyPixKeyType: "", thirdPartyPix: "",
              paymentDay: 10, notes: "",
            });
          }
        } catch {
          reset({
            name: "", cpfCnpj: "", personType: "PF", email: "", phone: "", phone2: "", email2: "",
            street: "", number: "", complement: "", neighborhood: "",
            city: "", state: "", zipCode: "", stateRegistration: "",
            bankName: "", bankAgency: "", bankAccount: "", bankPix: "",
            thirdPartyName: "", thirdPartyDocument: "", thirdPartyBank: "",
            thirdPartyAgency: "", thirdPartyAccount: "", thirdPartyPixKeyType: "", thirdPartyPix: "",
            paymentDay: 10, notes: "",
          });
        }
      }
    }
  }, [open, owner, reset]);

  // Save draft when closing without saving
  const handleOpenChange = useCallback((newOpen: boolean) => {
    if (!newOpen && !isEditing) {
      const current = watch();
      const hasData = Object.values(current).some(v => v && v !== "PF");
      if (hasData) {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(current));
      }
    }
    onOpenChange(newOpen);
  }, [isEditing, watch, onOpenChange]);

  // Soma dos percentuais dos beneficiarios (clamp em 100). O proprietario
  // recebe o restante (100 - soma) automaticamente.
  const beneficiariesSum = beneficiaries.reduce((s, b) => {
    const v = parseFloat((b.percentage || "0").replace(",", "."));
    return s + (Number.isFinite(v) ? v : 0);
  }, 0);
  const ownerRemainingPercent = Math.max(0, Math.round((100 - beneficiariesSum) * 100) / 100);

  function addBeneficiary() {
    if (beneficiaries.length >= 3) {
      toast.error("Maximo de 3 beneficiarios.");
      return;
    }
    setBeneficiaries([...beneficiaries, { ...EMPTY_BENEF }]);
  }

  function updateBeneficiary(index: number, patch: Partial<BeneficiaryRow>) {
    setBeneficiaries((prev) => prev.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  }

  function removeBeneficiary(index: number) {
    setBeneficiaries((prev) => prev.filter((_, i) => i !== index));
  }

  async function onSubmit(data: OwnerFormData) {
    // Validacao dos beneficiarios antes de submeter
    const cleaned: { name: string; pixKey: string; pixKeyType: string; percentage: number }[] = [];
    let sum = 0;
    for (let i = 0; i < beneficiaries.length; i++) {
      const b = beneficiaries[i];
      const pct = parseFloat((b.percentage || "").replace(",", "."));
      if (!b.name.trim() && !b.pixKey.trim() && !b.percentage.trim()) continue; // linha vazia, ignora
      if (!b.name.trim() || !b.pixKey.trim()) {
        toast.error(`Beneficiario ${i + 1}: nome e chave PIX sao obrigatorios.`);
        return;
      }
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        toast.error(`Beneficiario ${i + 1}: percentual deve ser maior que 0 e ate 100.`);
        return;
      }
      sum += pct;
      cleaned.push({
        name: b.name.trim(),
        pixKey: b.pixKey.trim(),
        pixKeyType: (b.pixKeyType || "CPF").toUpperCase(),
        percentage: pct,
      });
    }
    if (sum > 100.0001) {
      toast.error(`Soma dos percentuais (${sum.toFixed(2)}%) excede 100%.`);
      return;
    }

    setLoading(true);
    try {
      const url = isEditing ? `/api/owners/${owner.id}` : "/api/owners";
      const method = isEditing ? "PUT" : "POST";

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, payoutBeneficiaries: cleaned }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Erro ao salvar proprietario");
      }

      localStorage.removeItem(DRAFT_KEY);
      onOpenChange(false);
      onSuccess();
    } catch (error: any) {
      toast.error(error.message || "Erro ao salvar proprietario");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[680px] sm:max-h-[90vh]" preventOutsideClose>
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Editar Proprietário" : "Novo Proprietário"}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Atualize as informacoes do proprietario abaixo."
              : "Preencha as informacoes do novo proprietario."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          {/* Dados Pessoais */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Dados Pessoais
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">Nome *</Label>
                <Input
                  id="name"
                  placeholder="Nome completo ou razao social"
                  {...register("name")}
                />
                {errors.name && (
                  <p className="text-xs text-destructive">{errors.name.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="personType">Tipo de Pessoa</Label>
                <Select
                  value={personType}
                  onValueChange={(value) => setValue("personType", value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Selecione" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PF">Pessoa Física</SelectItem>
                    <SelectItem value="PJ">Pessoa Jurídica</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="cpfCnpj">{personType === "PJ" ? "CNPJ" : "CPF"} *</Label>
                <div className="flex gap-2">
                  <Input
                    id="cpfCnpj"
                    placeholder={personType === "PJ" ? "00.000.000/0000-00" : "000.000.000-00"}
                    maxLength={personType === "PJ" ? 18 : 14}
                    {...register("cpfCnpj", {
                      onChange: (e) => {
                        const formatted = formatCpfCnpj(e.target.value);
                        setValue("cpfCnpj", formatted);
                        // Auto-detect person type
                        const clean = formatted.replace(/\D/g, "");
                        if (clean.length > 11) setValue("personType", "PJ");
                        // Auto-lookup CNPJ when complete
                        if (clean.length === 14) lookupCnpj(formatted);
                      },
                    })}
                  />
                  {personType === "PJ" && (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      disabled={cnpjLoading}
                      onClick={() => lookupCnpj(watch("cpfCnpj") || "")}
                      title="Buscar CNPJ"
                    >
                      {cnpjLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                    </Button>
                  )}
                </div>
                {errors.cpfCnpj && (
                  <p className="text-xs text-destructive">{errors.cpfCnpj.message}</p>
                )}
                {cnpjError && (
                  <p className="text-xs text-destructive">{cnpjError}</p>
                )}
              </div>

              {personType === "PJ" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="stateRegistration">Inscrição Estadual</Label>
                    <Input
                      id="stateRegistration"
                      placeholder="Inscrição estadual"
                      {...register("stateRegistration")}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rgIssuer">Órgão Expedidor</Label>
                    <Input
                      id="rgIssuer"
                      placeholder="SSP, DETRAN, etc."
                      {...register("rgIssuer")}
                    />
                  </div>
                </>
              )}

              {personType === "PF" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="rgIssuer">Órgão Expedidor</Label>
                    <Input
                      id="rgIssuer"
                      placeholder="SSP, DETRAN, etc."
                      {...register("rgIssuer")}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="birthDate">Data de Nascimento</Label>
                    <Input
                      id="birthDate"
                      type="date"
                      {...register("birthDate")}
                    />
                  </div>
                </>
              )}

              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="email@exemplo.com"
                  {...register("email")}
                />
                {errors.email && (
                  <p className="text-xs text-destructive">{errors.email.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="phone">Telefone</Label>
                <Input
                  id="phone"
                  placeholder="(00) 00000-0000 ou +55 11 99999 8888"
                  maxLength={22}
                  {...register("phone", {
                    onChange: (e) => {
                      setValue("phone", formatPhone(e.target.value));
                    },
                  })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email2">Email 2</Label>
                <Input
                  id="email2"
                  type="email"
                  placeholder="email2@exemplo.com"
                  {...register("email2")}
                />
                {errors.email2 && (
                  <p className="text-xs text-destructive">{errors.email2.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="phone2">Telefone 2</Label>
                <Input
                  id="phone2"
                  placeholder="(00) 00000-0000 ou +55 11 99999 8888"
                  maxLength={22}
                  {...register("phone2", {
                    onChange: (e) => {
                      setValue("phone2", formatPhone(e.target.value));
                    },
                  })}
                />
              </div>
            </div>
          </div>

          {/* Endereço */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Endereço
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="street">Rua</Label>
                <Input
                  id="street"
                  placeholder="Nome da rua"
                  {...register("street")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="number">Número</Label>
                <Input
                  id="number"
                  placeholder="123"
                  {...register("number")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="complement">Complemento</Label>
                <Input
                  id="complement"
                  placeholder="Apto, bloco, etc."
                  {...register("complement")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="neighborhood">Bairro</Label>
                <Input
                  id="neighborhood"
                  placeholder="Nome do bairro"
                  {...register("neighborhood")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="city">Cidade</Label>
                <Input
                  id="city"
                  placeholder="Nome da cidade"
                  {...register("city")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="state">Estado</Label>
                <Input
                  id="state"
                  placeholder="UF"
                  {...register("state")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="zipCode">CEP</Label>
                <div className="flex gap-2">
                  <Input
                    id="zipCode"
                    placeholder="00000-000"
                    maxLength={9}
                    {...register("zipCode", {
                      onChange: (e) => {
                        const formatted = formatCep(e.target.value);
                        setValue("zipCode", formatted);
                        if (formatted.length === 9) lookupCep(formatted);
                      },
                    })}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    disabled={cepLoading}
                    onClick={() => lookupCep(watch("zipCode") || "")}
                    title="Buscar CEP"
                  >
                    {cepLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  </Button>
                </div>
                {cepError && (
                  <p className="text-xs text-destructive">{cepError}</p>
                )}
              </div>
            </div>
          </div>

          {/* Dados Bancarios */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Dados Bancarios
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="bankName">Banco</Label>
                <Input
                  id="bankName"
                  placeholder="Nome do banco"
                  {...register("bankName")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="bankAgency">Agência</Label>
                <Input
                  id="bankAgency"
                  placeholder="0000"
                  {...register("bankAgency")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="bankAccount">Conta</Label>
                <Input
                  id="bankAccount"
                  placeholder="00000-0"
                  {...register("bankAccount")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="bankPixType">Tipo da Chave PIX</Label>
                <Select
                  value={watch("bankPixType") || ""}
                  onValueChange={(value) => setValue("bankPixType", value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Selecione" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CPF">CPF</SelectItem>
                    <SelectItem value="CNPJ">CNPJ</SelectItem>
                    <SelectItem value="EMAIL">EMAIL</SelectItem>
                    <SelectItem value="TELEFONE">TELEFONE</SelectItem>
                    <SelectItem value="ALEATORIA">ALEATORIA</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="bankPix">Chave PIX</Label>
                <Input
                  id="bankPix"
                  placeholder="CPF, email, telefone ou chave aleatoria"
                  {...register("bankPix")}
                />
              </div>
            </div>
          </div>

          {/* Terceiro Recebedor */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Terceiro Recebedor
            </h3>
            <p className="text-xs text-muted-foreground -mt-2">
              Preencha apenas se o repasse vai para outra pessoa
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="thirdPartyName">Nome do Terceiro</Label>
                <Input
                  id="thirdPartyName"
                  placeholder="Nome completo do recebedor"
                  {...register("thirdPartyName")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="thirdPartyDocument">CPF/CNPJ do Terceiro</Label>
                <Input
                  id="thirdPartyDocument"
                  placeholder="000.000.000-00"
                  {...register("thirdPartyDocument")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="thirdPartyBank">Banco</Label>
                <Input
                  id="thirdPartyBank"
                  placeholder="Nome do banco"
                  {...register("thirdPartyBank")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="thirdPartyAgency">Agência</Label>
                <Input
                  id="thirdPartyAgency"
                  placeholder="0000"
                  {...register("thirdPartyAgency")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="thirdPartyAccount">Conta</Label>
                <Input
                  id="thirdPartyAccount"
                  placeholder="00000-0"
                  {...register("thirdPartyAccount")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="thirdPartyPixKeyType">Tipo da Chave PIX</Label>
                <Select
                  value={watch("thirdPartyPixKeyType") || ""}
                  onValueChange={(value) => setValue("thirdPartyPixKeyType", value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Selecione" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CPF">CPF</SelectItem>
                    <SelectItem value="CNPJ">CNPJ</SelectItem>
                    <SelectItem value="EMAIL">EMAIL</SelectItem>
                    <SelectItem value="TELEFONE">TELEFONE</SelectItem>
                    <SelectItem value="ALEATORIA">ALEATORIA</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="thirdPartyPix">Chave PIX</Label>
                <Input
                  id="thirdPartyPix"
                  placeholder="CPF, email, telefone ou chave aleatoria"
                  {...register("thirdPartyPix")}
                />
              </div>
            </div>
          </div>

          {/* Divisao do repasse — beneficiarios secundarios (caso Roberta) */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2 flex items-center justify-between">
              <span>Divisão do repasse</span>
              <span className="text-[11px] font-normal text-muted-foreground">
                Restante para o proprietário: <strong>{ownerRemainingPercent.toFixed(2)}%</strong>
              </span>
            </h3>
            <p className="text-[11px] text-muted-foreground -mt-2">
              Use para dividir o pagamento mensal entre múltiplos destinos PIX (ex: irmã, cônjuge).
              Não tem efeito fiscal — IRRF, contrato e DIRF continuam no CPF do proprietário.
              Máximo 3 beneficiários, soma ≤ 100%.
            </p>

            {beneficiaries.map((b, i) => (
              <div key={i} className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end p-3 border rounded-md">
                <div className="space-y-1 col-span-2 sm:col-span-3">
                  <Label className="text-xs">Nome</Label>
                  <Input
                    placeholder="Nome do beneficiário"
                    value={b.name}
                    onChange={(e) => updateBeneficiary(i, { name: e.target.value })}
                  />
                </div>
                <div className="space-y-1 col-span-1 sm:col-span-2">
                  <Label className="text-xs">Tipo PIX</Label>
                  <Select
                    value={b.pixKeyType}
                    onValueChange={(v) => updateBeneficiary(i, { pixKeyType: v })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CPF">CPF</SelectItem>
                      <SelectItem value="CNPJ">CNPJ</SelectItem>
                      <SelectItem value="EMAIL">EMAIL</SelectItem>
                      <SelectItem value="TELEFONE">TELEFONE</SelectItem>
                      <SelectItem value="ALEATORIA">ALEATORIA</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1 col-span-1 sm:col-span-4">
                  <Label className="text-xs">Chave PIX</Label>
                  <Input
                    placeholder="Chave PIX"
                    value={b.pixKey}
                    onChange={(e) => updateBeneficiary(i, { pixKey: e.target.value })}
                  />
                </div>
                <div className="space-y-1 col-span-1 sm:col-span-2">
                  <Label className="text-xs">% do líquido</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0.01"
                    max="100"
                    placeholder="30"
                    value={b.percentage}
                    onChange={(e) => updateBeneficiary(i, { percentage: e.target.value })}
                  />
                </div>
                <div className="col-span-1 sm:col-span-1 flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-muted-foreground hover:text-destructive"
                    onClick={() => removeBeneficiary(i)}
                    title="Remover beneficiário"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}

            {beneficiaries.length < 3 && (
              <Button type="button" variant="outline" size="sm" onClick={addBeneficiary}>
                + Adicionar beneficiário
              </Button>
            )}

            {beneficiariesSum > 100 && (
              <p className="text-xs text-destructive">
                Soma dos percentuais ({beneficiariesSum.toFixed(2)}%) excede 100%.
              </p>
            )}
          </div>

          {/* Pagamento */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Pagamento
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="paymentDay">Dia Pagamento Proprietário</Label>
                <Input
                  id="paymentDay"
                  type="number"
                  min={1}
                  max={31}
                  placeholder="10"
                  {...register("paymentDay")}
                />
              </div>
            </div>
          </div>

          {/* Observações */}
          <div className="space-y-2">
            <Label htmlFor="notes">Observações</Label>
            <Input
              id="notes"
              placeholder="Observações adicionais"
              {...register("notes")}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {isEditing ? "Salvar Alteracoes" : "Cadastrar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
