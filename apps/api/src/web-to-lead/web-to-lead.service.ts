import { organizations } from '@nexus/db';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq, or } from 'drizzle-orm';
import { IdentityDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { LeadsService } from '../leads/leads.service';
import type { WebToLeadInput } from './web-to-lead.schemas';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class WebToLeadService {
  constructor(
    @Inject(IdentityDb) private readonly identityDb: IdentityDb,
    @Inject(LeadsService) private readonly leadsService: LeadsService,
  ) {}

  async resolveOrganization(keyOrSlug: string) {
    const isUuid = UUID_REGEX.test(keyOrSlug);
    const [org] = await this.identityDb.db
      .select()
      .from(organizations)
      .where(
        isUuid
          ? or(eq(organizations.id, keyOrSlug), eq(organizations.slug, keyOrSlug))
          : eq(organizations.slug, keyOrSlug),
      );

    if (!org) {
      throw new NotFoundException({
        message: `Workspace not found for key: ${keyOrSlug}`,
        code: 'ORGANIZATION_NOT_FOUND',
      });
    }

    return org;
  }

  async ingest(
    input: WebToLeadInput,
    meta: { ip?: string; userAgent?: string; referer?: string },
  ): Promise<{ success: boolean; leadId?: string; deduplicated?: boolean; spam?: boolean }> {
    // 1. Honeypot check for spam bots
    if (input._hp || input.hp || input.honeypot) {
      return { success: true, spam: true };
    }

    // 2. Resolve organization
    const token = input.token || input.orgId || input.orgSlug;
    if (!token) {
      throw new BadRequestException({
        message: 'Missing organization token or key',
        code: 'MISSING_ORGANIZATION_KEY',
      });
    }

    const org = await this.resolveOrganization(token.trim());

    // 3. Normalize Name
    let name = input.name?.trim();
    let firstName = input.firstName?.trim();
    let lastName = input.lastName?.trim();

    if (!name && (firstName || lastName)) {
      name = [firstName, lastName].filter(Boolean).join(' ');
    } else if (name && !firstName && !lastName) {
      const parts = name.split(/\s+/);
      firstName = parts[0];
      lastName = parts.slice(1).join(' ') || undefined;
    } else if (!name) {
      name = input.email.split('@')[0];
    }

    // 4. Construct System Auth Context for lead creation
    const auth: AuthContext = {
      sessionId: 'web-to-lead',
      twoFactorVerified: true,
      user: {
        id: '' as any,
        email: input.email,
        name: name || 'Web Visitor',
        orgId: org.id,
        roleId: '00000000-0000-0000-0000-000000000000',
        status: 'active',
        twoFactorEnrolled: false,
      },
      role: {
        id: '00000000-0000-0000-0000-000000000000',
        key: 'admin',
        name: 'Admin',
        permissions: {
          version: 1,
          scopes: ['*'],
          recordAccess: { lead: 'all' },
          fields: {},
        },
      },
      org: {
        id: org.id,
        name: org.name,
        slug: org.slug,
      },
    };

    // 5. Ingest Lead through LeadsService (includes round-robin routing, 5m dedup, notification dispatch)
    const result = await this.leadsService.create(auth, {
      name,
      firstName,
      lastName,
      email: input.email,
      phone: input.phone,
      company: input.company,
      title: input.title,
      notes: input.notes,
      status: 'new',
      source: input.source ?? 'website',
      utmSource: input.utmSource,
      utmMedium: input.utmMedium,
      utmCampaign: input.utmCampaign,
      utmTerm: input.utmTerm,
      utmContent: input.utmContent,
      referrerUrl: input.referrerUrl || meta.referer,
      customFields: input.customFields,
    });

    return {
      success: true,
      leadId: result.lead.id,
      deduplicated: result.deduplicated,
    };
  }

  generateSnippet(org: { id: string; slug: string; name: string }, apiUrl: string) {
    const endpoint = `${apiUrl}/v1/web-to-lead`;
    const html = `<!-- Nexus CRM Web-to-Lead Form Embed -->
<form action="${endpoint}" method="POST" class="nexus-lead-form">
  <input type="hidden" name="token" value="${org.slug}" />
  <!-- Honeypot anti-spam field (hidden) -->
  <input type="text" name="_hp" style="display:none !important;" tabindex="-1" autocomplete="off" />

  <div class="form-group">
    <label for="lead_name">Name *</label>
    <input type="text" id="lead_name" name="name" required placeholder="John Doe" />
  </div>

  <div class="form-group">
    <label for="lead_email">Email *</label>
    <input type="email" id="lead_email" name="email" required placeholder="john@example.com" />
  </div>

  <div class="form-group">
    <label for="lead_phone">Phone</label>
    <input type="tel" id="lead_phone" name="phone" placeholder="+1 (555) 000-0000" />
  </div>

  <div class="form-group">
    <label for="lead_company">Company</label>
    <input type="text" id="lead_company" name="company" placeholder="Acme Corp" />
  </div>

  <div class="form-group">
    <label for="lead_notes">Message / Notes</label>
    <textarea id="lead_notes" name="notes" placeholder="How can we help?"></textarea>
  </div>

  <button type="submit">Submit</button>
</form>
`;

    return {
      orgId: org.id,
      slug: org.slug,
      endpoint,
      html,
    };
  }
}
