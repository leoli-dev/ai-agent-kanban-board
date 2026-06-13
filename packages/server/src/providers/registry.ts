import { and, asc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { TIER_RANK, type AgentRole, type EngineId, type ModelTier, type ProviderProfile, type RoleAssignment } from '@akb/shared';
import { schema, type Db } from '../db/index.js';
import { toProviderProfile } from '../db/mappers.js';
import type { ResolvedProfile } from '../engines/types.js';
import type { SecretStore } from './secrets.js';

export interface ProfileInput {
  name: string;
  engine: EngineId;
  env: Record<string, string>;
  modelLabel?: string | null;
  tier?: ModelTier;
  notes?: string | null;
}

export class ProviderRegistry {
  constructor(
    private db: Db,
    private secrets: SecretStore,
  ) {}

  list(): ProviderProfile[] {
    return this.db.select().from(schema.providerProfiles).all().map(toProviderProfile);
  }

  get(id: string): ProviderProfile | null {
    const row = this.db
      .select()
      .from(schema.providerProfiles)
      .where(eq(schema.providerProfiles.id, id))
      .get();
    return row ? toProviderProfile(row) : null;
  }

  create(input: ProfileInput): ProviderProfile {
    const id = nanoid(10);
    this.db
      .insert(schema.providerProfiles)
      .values({
        id,
        name: input.name,
        engine: input.engine,
        envJson: JSON.stringify(input.env),
        modelLabel: input.modelLabel ?? null,
        tier: input.tier ?? 'low',
        notes: input.notes ?? null,
      })
      .run();
    return this.get(id)!;
  }

  update(id: string, patch: Partial<ProfileInput> & { enabled?: boolean }): ProviderProfile | null {
    const existing = this.get(id);
    if (!existing) return null;
    this.db
      .update(schema.providerProfiles)
      .set({
        name: patch.name ?? existing.name,
        engine: patch.engine ?? existing.engine,
        envJson: JSON.stringify(patch.env ?? existing.env),
        modelLabel: patch.modelLabel !== undefined ? patch.modelLabel : existing.modelLabel,
        tier: patch.tier ?? existing.tier,
        notes: patch.notes !== undefined ? patch.notes : existing.notes,
        enabled: (patch.enabled ?? existing.enabled) ? 1 : 0,
        // Re-enabling clears failure state.
        ...(patch.enabled === true ? { disabledReason: null, cooldownUntil: null } : {}),
      })
      .where(eq(schema.providerProfiles.id, id))
      .run();
    return this.get(id);
  }

  delete(id: string): void {
    this.db.delete(schema.providerProfiles).where(eq(schema.providerProfiles.id, id)).run();
    this.db
      .delete(schema.roleAssignments)
      .where(eq(schema.roleAssignments.providerProfileId, id))
      .run();
  }

  resolve(profile: ProviderProfile): ResolvedProfile {
    return { ...profile, resolvedEnv: this.secrets.resolveEnv(profile.env) };
  }

  assignments(role?: AgentRole): RoleAssignment[] {
    const rows = role
      ? this.db
          .select()
          .from(schema.roleAssignments)
          .where(eq(schema.roleAssignments.role, role))
          .orderBy(asc(schema.roleAssignments.priority))
          .all()
      : this.db
          .select()
          .from(schema.roleAssignments)
          .orderBy(asc(schema.roleAssignments.role), asc(schema.roleAssignments.priority))
          .all();
    return rows.map((r) => ({
      id: r.id,
      role: r.role as AgentRole,
      providerProfileId: r.providerProfileId,
      priority: r.priority,
    }));
  }

  /** Replace the ordered provider list for a role. */
  setRoleOrder(role: AgentRole, profileIds: string[]): RoleAssignment[] {
    this.db.delete(schema.roleAssignments).where(eq(schema.roleAssignments.role, role)).run();
    profileIds.forEach((profileId, i) => {
      this.db
        .insert(schema.roleAssignments)
        .values({ id: nanoid(10), role, providerProfileId: profileId, priority: i })
        .run();
    });
    return this.assignments(role);
  }

  /**
   * Provider selection for a role.
   *
   * Profiles are tried in the role's priority order, skipping disabled /
   * cooled-down / already-tried ones (availability fallback). `minTier` is the
   * intelligence floor: used to escalate a task to a more capable model after
   * its work keeps getting rejected. We return the first eligible profile at or
   * above that tier (still honoring priority order); if none qualifies — the
   * configured models are all weaker than the floor — we fall back to the
   * strongest available so the task still runs on the best model on hand.
   */
  pickForRole(
    role: AgentRole,
    excludeIds: string[] = [],
    minTier: ModelTier = 'low',
  ): ProviderProfile | null {
    const now = Date.now();
    const available = this.assignments(role)
      .map((a) => this.get(a.providerProfileId))
      .filter(
        (p): p is ProviderProfile =>
          !!p &&
          p.enabled &&
          !excludeIds.includes(p.id) &&
          !(p.cooldownUntil && p.cooldownUntil > now),
      );
    if (available.length === 0) return null;
    const floor = TIER_RANK[minTier];
    return (
      available.find((p) => TIER_RANK[p.tier] >= floor) ??
      available.reduce((best, p) => (TIER_RANK[p.tier] > TIER_RANK[best.tier] ? p : best))
    );
  }

  markOk(id: string): void {
    this.db
      .update(schema.providerProfiles)
      .set({ lastOkAt: Date.now(), cooldownUntil: null, disabledReason: null })
      .where(eq(schema.providerProfiles.id, id))
      .run();
  }

  markCooldown(id: string, untilTs: number, reason: string): void {
    this.db
      .update(schema.providerProfiles)
      .set({ cooldownUntil: untilTs, disabledReason: reason })
      .where(eq(schema.providerProfiles.id, id))
      .run();
  }

  markDisabled(id: string, reason: string): void {
    this.db
      .update(schema.providerProfiles)
      .set({ enabled: 0, disabledReason: reason })
      .where(and(eq(schema.providerProfiles.id, id)))
      .run();
  }
}
