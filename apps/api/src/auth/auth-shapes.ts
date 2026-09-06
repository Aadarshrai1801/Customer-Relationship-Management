export interface PublicUser {
  id: string;
  email: string;
  name: string;
  status: string;
  twoFactorEnrolled?: boolean;
  role: { id: string; key: string; name: string; permissions?: unknown };
}

export interface TwoFactorState {
  enrolled: boolean;
  required: boolean;
  verified: boolean;
}

export interface PublicOrg {
  id: string;
  name: string;
  slug: string;
}

export function toPublicUser(
  user: { id: string; email: string; name: string; status: string },
  role: { id: string; key: string; name: string },
): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    role: { id: role.id, key: role.key, name: role.name },
  };
}

export function toPublicOrg(org: { id: string; name: string; slug: string }): PublicOrg {
  return { id: org.id, name: org.name, slug: org.slug };
}
