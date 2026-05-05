/**
 * Utilitarios para extrair certificado X.509 e chave privada de um arquivo
 * PKCS#12 (.pfx) usando node-forge.
 *
 * Usado pra:
 *  1) Validar a senha do certificado no upload
 *  2) Extrair PEM cert + PEM key pra mTLS no fetch ao SEFIN
 *  3) Extrair chave privada pra assinatura XAdES
 *  4) Ler validade + subject pra exibir na tela de configuracao
 */
import forge from "node-forge";

export interface ExtractedCertificate {
  /** Certificado em PEM (PEM-encoded) — incluir cabecalhos -----BEGIN CERTIFICATE----- */
  certPem: string;
  /** Chave privada em PEM (formato RSA PRIVATE KEY) */
  keyPem: string;
  /** Cadeia de certificados intermediarios em PEM (concatenados) */
  caPem: string;
  /** Validade — fim */
  validUntil: Date;
  /** Validade — inicio */
  validFrom: Date;
  /** Subject (CN) — geralmente "EMPRESA:CNPJ" */
  subject: string;
  /** CNPJ extraido do subject (so digitos), se conseguir parsear */
  cnpj: string | null;
  /** Issuer (autoridade certificadora) */
  issuer: string;
  /** Numero serial do certificado (hex) */
  serialNumber: string;
}

/**
 * Le um arquivo PFX e extrai certificado + chave privada.
 *
 * @throws Error se a senha estiver errada ou o arquivo for invalido
 */
export function extractPfx(buffer: Buffer, password: string): ExtractedCertificate {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const der = forge.util.binary.raw.encode(new Uint8Array(buffer));
    const asn1 = forge.asn1.fromDer(der);
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password);
  } catch (err: any) {
    if (err?.message?.includes("MAC")) {
      throw new Error("Senha do certificado incorreta.");
    }
    throw new Error(`Arquivo PFX invalido: ${err?.message || err}`);
  }

  // Buscar bags por tipo
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  // Tambem busca keys nao-encriptadas (alguns geradores usam)
  const keyBagsAlt = p12.getBags({ bagType: forge.pki.oids.keyBag });

  const certs = certBags[forge.pki.oids.certBag] || [];
  const keys = [
    ...(keyBags[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(keyBagsAlt[forge.pki.oids.keyBag] || []),
  ];

  if (certs.length === 0) {
    throw new Error("Nenhum certificado encontrado no PFX.");
  }
  if (keys.length === 0) {
    throw new Error("Nenhuma chave privada encontrada no PFX.");
  }

  // Identifica o certificado da empresa (geralmente eh o primeiro nao-CA)
  let mainCert: forge.pki.Certificate | null = null;
  const caCerts: forge.pki.Certificate[] = [];

  for (const bag of certs) {
    if (!bag.cert) continue;
    const isCA = bag.cert.getExtension("basicConstraints");
    if (isCA && (isCA as any).cA === true) {
      caCerts.push(bag.cert);
    } else if (!mainCert) {
      mainCert = bag.cert;
    } else {
      caCerts.push(bag.cert);
    }
  }
  if (!mainCert && certs[0]?.cert) mainCert = certs[0].cert;
  if (!mainCert) {
    throw new Error("Nao foi possivel identificar o certificado principal.");
  }

  const privateKey = keys[0].key;
  if (!privateKey) {
    throw new Error("Chave privada vazia.");
  }

  const certPem = forge.pki.certificateToPem(mainCert);
  const keyPem = forge.pki.privateKeyToPem(privateKey as forge.pki.PrivateKey);
  const caPem = caCerts.map((c) => forge.pki.certificateToPem(c)).join("\n");

  // Subject como string
  const subjectStr = mainCert.subject.attributes
    .map((a) => `${a.shortName || a.name}=${a.value}`)
    .join(", ");
  const issuerStr = mainCert.issuer.attributes
    .map((a) => `${a.shortName || a.name}=${a.value}`)
    .join(", ");

  // CNPJ — extrai do CN (formato 'EMPRESA:CNPJ')
  const cnAttr = mainCert.subject.getField({ name: "commonName" });
  const cnValue = cnAttr?.value || "";
  const cnpjMatch = String(cnValue).match(/:(\d{14})/);
  const cnpj = cnpjMatch ? cnpjMatch[1] : null;

  return {
    certPem,
    keyPem,
    caPem,
    validUntil: mainCert.validity.notAfter,
    validFrom: mainCert.validity.notBefore,
    subject: subjectStr,
    cnpj,
    issuer: issuerStr,
    serialNumber: mainCert.serialNumber,
  };
}

/**
 * Valida apenas se a senha esta correta (sem extrair tudo).
 * Mais rapido pra validacao no upload.
 */
export function validatePfxPassword(buffer: Buffer, password: string): boolean {
  try {
    const der = forge.util.binary.raw.encode(new Uint8Array(buffer));
    const asn1 = forge.asn1.fromDer(der);
    forge.pkcs12.pkcs12FromAsn1(asn1, password);
    return true;
  } catch {
    return false;
  }
}
