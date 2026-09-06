import { z } from 'zod';

const domainPattern = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;

export const oidcInputSchema = z
  .object({
    issuer: z.string().trim().min(1).max(500),
    clientId: z.string().trim().min(1).max(500),
    clientSecret: z.string().min(1).max(1000),
  })
  .strict();

export const samlInputSchema = z
  .object({
    idpMetadataXml: z.string().min(100).max(500_000).optional(),
    idpMetadataUrl: z.string().trim().url().max(1000).optional(),
    emailAttribute: z.string().trim().min(1).max(200).default('email'),
    nameAttribute: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => v.idpMetadataXml ?? v.idpMetadataUrl, {
    message: 'Provide idpMetadataXml or idpMetadataUrl',
  });

export const createSsoConfigSchema = z
  .object({
    provider: z.enum(['saml', 'oidc']),
    domains: z
      .array(z.string().trim().toLowerCase().regex(domainPattern, 'Invalid domain'))
      .max(50)
      .default([]),
    defaultRoleKey: z.string().trim().min(1).max(50).default('rep'),
    oidc: oidcInputSchema.optional(),
    saml: samlInputSchema.optional(),
  })
  .strict()
  .refine((v) => (v.provider === 'oidc' ? !!v.oidc && !v.saml : !!v.saml && !v.oidc), {
    message: 'Provide the matching provider block only',
  });

export const updateSsoConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    domains: z
      .array(z.string().trim().toLowerCase().regex(domainPattern, 'Invalid domain'))
      .max(50)
      .optional(),
    defaultRoleKey: z.string().trim().min(1).max(50).optional(),
    oidc: oidcInputSchema.optional(),
    saml: samlInputSchema.optional(),
  })
  .strict();

export type CreateSsoConfigInput = z.infer<typeof createSsoConfigSchema>;
export type UpdateSsoConfigInput = z.infer<typeof updateSsoConfigSchema>;

export interface OidcConfigJson {
  kind: 'oidc';
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export interface SamlConfigJson {
  kind: 'saml';
  idpEntityId: string;
  idpSsoUrl: string;
  idpCert: string;
  emailAttribute: string;
  nameAttribute?: string;
}

export type SsoConfigJson = OidcConfigJson | SamlConfigJson;
