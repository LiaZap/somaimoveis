/**
 * Assinatura XAdES-Enveloped para a DPS do Padrao Nacional NFS-e.
 *
 * Caracteristicas obrigatorias do gov.br (validadas contra XML real
 * autorizado pelo EmissorWeb 1.6.0.0):
 *  - Algoritmo: RSA-SHA256
 *  - Canonicalization: C14N exclusiva COM comentarios (#WithComments)
 *  - Tipo: enveloped (assinatura DENTRO do XML, dentro do elemento DPS)
 *  - Reference URI: aponta pro Id do infDPS (ex: "#DPS-...")
 *  - KeyInfo: inclui o certificado X.509 base64
 *
 * Usa xml-crypto para a estrutura da assinatura + node-forge pra
 * extracao da chave do PFX (via nfse-pfx).
 */
import { SignedXml } from "xml-crypto";

export interface SignDpsParams {
  /** XML da DPS sem assinatura (gerado por nfse-dps-builder) */
  xml: string;
  /** Id do elemento infDPS (ex: "DPS40528068000162000010000000000000001") */
  idDps: string;
  /** Chave privada em PEM (extraida do PFX) */
  privateKeyPem: string;
  /** Certificado em PEM (extraido do PFX) */
  certificatePem: string;
}

/**
 * Assina o XML da DPS no padrao XAdES-Enveloped.
 *
 * Retorna o XML assinado (com o elemento <Signature> dentro de DPS).
 */
export function signDps(params: SignDpsParams): string {
  const sig = new SignedXml({
    privateKey: params.privateKeyPem,
    publicCert: params.certificatePem,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    // C14N exclusiva COM comentarios — alinhado com o XML real do
    // EmissorWeb (validado em DPS411370025041074700019670000000000000000013)
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#WithComments",
  });

  // Reference: aponta pro id do infDPS, com transforms padrao SEFIN
  // (enveloped + c14n exclusiva COM comentarios)
  sig.addReference({
    xpath: `//*[@Id='${params.idDps}']`,
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#WithComments",
    ],
  });

  // Coloca a assinatura DENTRO de <DPS>, depois de <infDPS>
  sig.computeSignature(params.xml, {
    location: {
      reference: "//*[local-name()='DPS']",
      action: "append",
    },
  });

  return sig.getSignedXml();
}

/**
 * Calcula a chave de acesso da NFS-e (50 digitos, padrao nacional).
 *
 * Formato: cMun(7) + AAMM(4) + tpInsc(1) + nInsc(14) + tpAmb(1) + tpEmis(1) + nNFSe(13) + cDV(1) + cMod(2) + serie(5) + nDPS(15)
 *
 * IMPORTANTE: este eh um placeholder — a chave de acesso eh calculada
 * pela SEFIN ao processar a DPS. Ela nao precisa estar no XML enviado.
 *
 * Mantido aqui pra futuras necessidades (ex: gerar chave provisoria local).
 */
export function generateChaveAcesso(_params: unknown): string {
  throw new Error("Chave de acesso eh atribuida pela SEFIN, nao geramos localmente.");
}
