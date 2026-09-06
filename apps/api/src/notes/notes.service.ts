import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { contactNotes, users } from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService } from '../audit/audit.service';
import { ContactsService } from '../contacts/contacts.service';
import { hasScope } from '../rbac/permissions';
import type { CreateNoteInput, UpdateNoteInput } from './notes.schemas';

export interface SerializedNote {
  id: string;
  contactId: string;
  author: { id: string; name: string } | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

function preview(body: string): string {
  return body.length > 500 ? `${body.slice(0, 500)}…` : body;
}

@Injectable()
export class NotesService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
  ) {}

  async create(
    auth: AuthContext,
    contactId: string,
    input: CreateNoteInput,
  ): Promise<SerializedNote> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.contacts.requireLiveContact(db, auth.org.id, contactId);
      this.contacts.assertContactReadable(auth, row.contact.ownerId);
      const [note] = await db
        .insert(contactNotes)
        .values({
          orgId: auth.org.id,
          contactId: row.contact.id,
          authorId: auth.user.id,
          body: input.body,
        })
        .returning();
      if (!note) throw new Error('Failed to create note');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'contact.note_added',
        entityType: 'contact',
        entityId: row.contact.id,
        newValues: { noteId: note.id, preview: preview(note.body) },
      });
      return this.serialize(db, auth, note.contactId, note);
    });
  }

  async list(auth: AuthContext, contactId: string): Promise<SerializedNote[]> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.contacts.requireLiveContact(db, auth.org.id, contactId);
      this.contacts.assertContactReadable(auth, row.contact.ownerId);
      const rows = await db
        .select()
        .from(contactNotes)
        .where(and(eq(contactNotes.orgId, auth.org.id), eq(contactNotes.contactId, row.contact.id)))
        .orderBy(desc(contactNotes.createdAt));
      return Promise.all(rows.map((note) => this.serialize(db, auth, row.contact.id, note)));
    });
  }

  async update(
    auth: AuthContext,
    contactId: string,
    noteId: string,
    input: UpdateNoteInput,
  ): Promise<SerializedNote> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.contacts.requireLiveContact(db, auth.org.id, contactId);
      this.contacts.assertContactReadable(auth, row.contact.ownerId);
      const note = await this.findNote(db, auth.org.id, row.contact.id, noteId);
      if (!note) {
        throw new NotFoundException({ message: 'Note not found', code: 'NOTE_NOT_FOUND' });
      }
      this.assertCanModify(auth, note.authorId);
      const [updated] = await db
        .update(contactNotes)
        .set({ body: input.body, updatedAt: new Date() })
        .where(eq(contactNotes.id, note.id))
        .returning();
      if (!updated) throw new Error('Failed to update note');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'contact.note_updated',
        entityType: 'contact',
        entityId: row.contact.id,
        oldValues: { preview: preview(note.body) },
        newValues: { preview: preview(updated.body) },
      });
      return this.serialize(db, auth, row.contact.id, updated);
    });
  }

  async remove(auth: AuthContext, contactId: string, noteId: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.contacts.requireLiveContact(db, auth.org.id, contactId);
      this.contacts.assertContactReadable(auth, row.contact.ownerId);
      const note = await this.findNote(db, auth.org.id, row.contact.id, noteId);
      if (!note) {
        throw new NotFoundException({ message: 'Note not found', code: 'NOTE_NOT_FOUND' });
      }
      this.assertCanModify(auth, note.authorId);
      await db.delete(contactNotes).where(eq(contactNotes.id, note.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'contact.note_deleted',
        entityType: 'contact',
        entityId: row.contact.id,
        oldValues: { preview: preview(note.body) },
      });
      return { ok: true as const };
    });
  }

  /** Authors edit their own notes; user managers may edit anyone's. */
  private assertCanModify(auth: AuthContext, authorId: string | null): void {
    if (authorId && authorId === auth.user.id) return;
    if (hasScope(auth.role.permissions, 'users:manage')) return;
    throw new ForbiddenException({
      message: 'Only the author or a user manager can modify this note',
      code: 'NOTE_MODIFY_FORBIDDEN',
    });
  }

  private async findNote(db: NexusDb, orgId: string, contactId: string, noteId: string) {
    const [note] = await db
      .select()
      .from(contactNotes)
      .where(
        and(
          eq(contactNotes.id, noteId),
          eq(contactNotes.orgId, orgId),
          eq(contactNotes.contactId, contactId),
        ),
      );
    return note ?? null;
  }

  private async serialize(
    db: NexusDb,
    _auth: AuthContext,
    _contactId: string,
    note: typeof contactNotes.$inferSelect,
  ): Promise<SerializedNote> {
    const [author] = note.authorId
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(eq(users.id, note.authorId))
      : [undefined];
    return {
      id: note.id,
      contactId: note.contactId,
      author: author ?? null,
      body: note.body,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    };
  }
}
