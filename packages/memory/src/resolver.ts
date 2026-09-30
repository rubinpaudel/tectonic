import { createHash } from "node:crypto";
import type { Entity, EntityMention, MemoryRepository } from "@tunnelvision/core";

const priority = (kind: string): number => ["external_id", "email", "employee_id", "teams_id", "name"].indexOf(kind) < 0 ? 4 : ["external_id", "email", "employee_id", "teams_id", "name"].indexOf(kind);
const strong = (mention: EntityMention): boolean => priority(mention.kind) < 4;
export interface EntityResolution {
  entities: Array<{ entity: Entity; role: EntityMention["role"] }>;
  unresolved: Array<{ mention: EntityMention; reason: string; possibleEntityIds: string[] }>;
  created: number;
}

/** Resolve each role independently; conflicting strong identities require review. */
export class EntityResolver {
  async resolve(tenantId: string, mentions: EntityMention[], repository: MemoryRepository, nameHint?: string): Promise<EntityResolution> {
    const result: EntityResolution = { entities: [], unresolved: [], created: 0 };
    const roles = [...new Set(mentions.map(mention => mention.role))];
    for (const role of roles) {
      const group = mentions.filter(mention => mention.role === role).sort((a, b) => priority(a.kind) - priority(b.kind));
      const lookups = await Promise.all(group.map(mention => repository.resolveEntityByAlias({ tenantId, kind: mention.kind, value: mention.kind === "email" ? mention.value.toLowerCase() : mention.value })));
      for (const matches of lookups) if (matches.some(entity => entity.tenantId !== tenantId)) throw new Error("Repository leaked an entity across tenants");
      const strongIds = new Set(lookups.flatMap((matches, index) => strong(group[index]!) ? matches.map(entity => entity.id) : []));
      const ambiguousStrong = lookups.some((matches, index) => strong(group[index]!) && matches.length > 1) || strongIds.size > 1;
      const explicit = group.find(mention => mention.kind === "external_id");
      const disagreesWithExplicit = !!explicit && strongIds.size > 0 && !strongIds.has(explicit.value);
      const firstMatches = lookups.find(matches => matches.length > 0) ?? [];
      if (ambiguousStrong || disagreesWithExplicit || (!group.some(strong) && firstMatches.length > 1)) {
        const possibleEntityIds = [...new Set(lookups.flat().map(entity => entity.id))].sort();
        for (const mention of group) result.unresolved.push({ mention, reason: "ambiguous_or_conflicting_aliases", possibleEntityIds });
        continue;
      }
      let entity = firstMatches[0];
      // A new strong ID must never silently merge into a coincidental name match.
      if (group.some(strong) && strongIds.size === 0) entity = undefined;
      if (!entity && !group.some(strong)) {
        for (const mention of group) result.unresolved.push({ mention, reason: "unresolved_name", possibleEntityIds: [] });
        continue;
      }
      const primary = group.find(strong)!;
      const id = entity?.id ?? explicit?.value ?? `${tenantId}:entity:${createHash("sha256").update(`${primary.kind}:${primary.value.toLowerCase()}`).digest("hex").slice(0, 24)}`;
      const displayName = entity?.name ?? nameHint ?? group.find(mention => mention.kind === "name")?.value ?? primary.value;
      if (!entity) result.created++;
      entity = await repository.upsertEntity({
        id, tenantId, type: entity?.type ?? primary?.entityType ?? "person", name: displayName,
        metadata: entity?.metadata ?? {}, aliases: group.map(mention => ({ kind: mention.kind, value: mention.kind === "email" ? mention.value.toLowerCase() : mention.value })),
      });
      result.entities.push({ entity, role });
    }
    return result;
  }
}
