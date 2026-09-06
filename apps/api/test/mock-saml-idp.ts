import selfsigned from 'selfsigned';
import { SignedXml } from 'xml-crypto';

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function instant(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

export interface MockSamlIdP {
  entityId: string;
  ssoUrl: string;
  certPem: string;
  privateKeyPem: string;
  metadataXml(): string;
}

export async function createMockSamlIdP(
  entityId = 'https://mock-idp.test/metadata',
): Promise<MockSamlIdP> {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'mock-idp.test' }], {
    keySize: 2048,
    notAfterDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
  });
  const certBody = pems.cert.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  const ssoUrl = 'https://mock-idp.test/sso';
  return {
    entityId,
    ssoUrl,
    certPem: pems.cert,
    privateKeyPem: pems.private,
    metadataXml(): string {
      return (
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${esc(entityId)}">` +
        `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
        `<md:KeyDescriptor use="signing">` +
        `<ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">` +
        `<ds:X509Data><ds:X509Certificate>${certBody}</ds:X509Certificate></ds:X509Data>` +
        `</ds:KeyInfo></md:KeyDescriptor>` +
        `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${esc(ssoUrl)}"/>` +
        `</md:IDPSSODescriptor></md:EntityDescriptor>`
      );
    },
  };
}

export interface SignResponseOptions {
  spEntityId: string;
  acsUrl: string;
  requestId: string;
  email?: string;
  omitEmailAttribute?: boolean;
  omitNameIdEmail?: boolean;
  name?: string;
  nameId?: string;
  signAssertion?: boolean;
  tamperAfterSign?: boolean;
  audienceOverride?: string;
  statusSuccess?: boolean;
  notBeforeMs?: number;
  notOnOrAfterMs?: number;
}

/**
 * Builds a SAML Response with an enveloped-signed Assertion, exactly as a
 * real IdP would (RSA-SHA256 over exc-c14n). Mutations exercise the negative
 * paths: unsigned, tampered, wrong audience, expired.
 */
export function signSamlResponse(idp: MockSamlIdP, opts: SignResponseOptions): string {
  const email = opts.email ?? 'saml-user@example.test';
  const nameId = opts.omitNameIdEmail ? 'transient-name-id' : (opts.nameId ?? email);
  const assertionId = `_assert-${Math.random().toString(36).slice(2)}`;
  const audience = opts.audienceOverride ?? opts.spEntityId;
  const statusSuccess = opts.statusSuccess ?? true;

  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${instant()}">` +
    `<saml:Issuer>${esc(idp.entityId)}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${esc(nameId)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData InResponseTo="${esc(opts.requestId)}" NotOnOrAfter="${instant(opts.notOnOrAfterMs ?? 5 * 60 * 1000)}" Recipient="${esc(opts.acsUrl)}"/>` +
    `</saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${instant(opts.notBeforeMs ?? -60 * 1000)}" NotOnOrAfter="${instant(opts.notOnOrAfterMs ?? 5 * 60 * 1000)}">` +
    `<saml:AudienceRestriction><saml:Audience>${esc(audience)}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AttributeStatement>` +
    (opts.omitEmailAttribute
      ? ''
      : `<saml:Attribute Name="email" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic"><saml:AttributeValue>${esc(email)}</saml:AttributeValue></saml:Attribute>`) +
    (opts.name
      ? `<saml:Attribute Name="displayName" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic"><saml:AttributeValue>${esc(opts.name)}</saml:AttributeValue></saml:Attribute>`
      : '') +
    `</saml:AttributeStatement></saml:Assertion>`;

  let signedAssertion = assertion;
  if (opts.signAssertion ?? true) {
    const sig = new SignedXml({
      privateKey: idp.privateKeyPem,
      publicCert: idp.certPem,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    });
    sig.addReference({
      xpath: "//*[local-name(.)='Assertion']",
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        'http://www.w3.org/2001/10/xml-exc-c14n#',
      ],
    });
    sig.computeSignature(assertion, {
      prefix: 'ds',
      location: { reference: "//*[local-name(.)='Issuer']", action: 'after' },
    });
    signedAssertion = sig.getSignedXml();
    if (opts.tamperAfterSign) {
      signedAssertion = signedAssertion.replace(esc(email), esc(`evil+${email}`));
    }
  }

  const response =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
    `ID="_resp-${Math.random().toString(36).slice(2)}" Version="2.0" IssueInstant="${instant()}" ` +
    `Destination="${esc(opts.acsUrl)}" InResponseTo="${esc(opts.requestId)}">` +
    `<saml:Issuer>${esc(idp.entityId)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="${statusSuccess ? 'urn:oasis:names:tc:SAML:2.0:status:Success' : 'urn:oasis:names:tc:SAML:2.0:status:Responder'}"/></samlp:Status>` +
    signedAssertion +
    `</samlp:Response>`;
  return Buffer.from(response, 'utf8').toString('base64');
}
