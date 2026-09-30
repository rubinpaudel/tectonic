import { createHash } from "node:crypto";
import type { CandidateMemory, EntityMention, EvidenceRef, JsonObject, Memory, MemoryExtractionInput, MemoryExtractor, MemoryType, Observation } from "@tunnelvision/core";

const record = (value: unknown): JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const textValue = (value: unknown): string => typeof value === "string" ? value : "";
const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const digest = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 20);
const keyField = (text: string, label: string): string => text.match(new RegExp(`^${label}:\\s*(.+)$`, "mi"))?.[1]?.trim() ?? "";
const addressValue = (value: string): string => value.split(";")[0]!.trim().replace(/[.;]\s*$/, "");
const isoDate = (text: string): string | null => {
  const found = text.match(/\b(20\d{2}-\d{2}-\d{2})(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?/);
  if (!found?.[0]) return null;
  const value = found[0].length === 10 ? `${found[0]}T00:00:00.000Z` : found[0];
  return Number.isNaN(Date.parse(value)) ? null : new Date(value).toISOString();
};
const amount = (value: string): number | null => {
  const found = value.match(/[\d]+(?:[.,][\d]+)*/)?.[0];
  if (!found) return null;
  const normalized = found.replace(/,(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const result = Number(normalized);
  return Number.isFinite(result) ? result : null;
};
const evidenceKey = (evidence: EvidenceRef): string => JSON.stringify(evidence);
function unionEvidence(...groups: EvidenceRef[][]): EvidenceRef[] {
  return [...new Map(groups.flat().map(evidence => [evidenceKey(evidence), evidence])).values()];
}

interface Person {
  key: string;
  entityId?: string;
  name: string;
  mentions: EntityMention[];
}

function subject(observation: Observation): Person | null {
  const text = observation.text;
  const tenant = observation.tenantId;
  const from = record(observation.metadata.from);
  const employeeId = keyField(text, "Employee[ -]ID") || textValue(observation.metadata.employeeId) || text.match(/\bEMP-\d{3}\b/)?.[0] || "";
  const name = keyField(text, "Name") || (/(?:\bAbel\b|abel@nike\.example)/i.test(text) || employeeId === "EMP-001" ? "Abel" : "");
  const isDossier = !!keyField(text, "Name");
  const email = keyField(text, "Email") || (text.match(/abel@nike\.example/i)?.[0] ?? "") || (observation.metadata.system === "gmail" ? textValue(observation.metadata.from).match(/[a-z0-9_.+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0] ?? "" : "");
  const teamsId = keyField(text, "Teams user ID") || (isDossier ? textValue(from.id) : "");
  const explicit = keyField(text, "(?:Stable ID|Entity ID|Employee stable ID)") || text.match(/\b[a-z][a-z0-9_-]*:employee:[a-z0-9_-]+\b/i)?.[0] || "";
  const knownAbel = tenant === "nike" && (employeeId === "EMP-001" || email.toLowerCase() === "abel@nike.example" || teamsId === "nike:teams:abel");
  const entityId = explicit || (knownAbel ? "nike:employee:abel" : isDossier && employeeId && email ? `${tenant}:employee:${slug(email.split("@")[0] ?? name)}` : "");
  if (!entityId && !employeeId && !email && !name) return null;
  const mentions: EntityMention[] = [];
  for (const [kind, value] of [["external_id", entityId], ["email", email.toLowerCase()], ["employee_id", employeeId], ["teams_id", teamsId], ["name", name]] as const) {
    if (value) mentions.push({ kind, value, entityType: "person", role: "subject" });
  }
  return { key: entityId || `${tenant}:unresolved:${employeeId || email || `name:${slug(name)}`}`, ...(entityId ? { entityId } : {}), name: name || email || employeeId, mentions };
}

function occurrence(observation: Observation): string | null {
  return isoDate(textValue(observation.metadata.createdDateTime)) || isoDate(textValue(observation.metadata.date)) || isoDate(keyField(observation.text, "Snapshot date"));
}

/** Deliberately limited synthetic-fixture rules; no domain rules live in DB/MCP. */
export class DeterministicPocMemoryExtractor implements MemoryExtractor {
  constructor(private readonly clock: () => string = () => new Date().toISOString()) {}

  async extract(input: MemoryExtractionInput): Promise<CandidateMemory[]> {
    const result: CandidateMemory[] = [];
    for (const observation of input.observations) {
      if (observation.tenantId !== input.tenantId) throw new Error("Extractor observation tenant mismatch");
      const text = observation.text;
      const person = subject(observation);
      const occurredAt = occurrence(observation);
      const emit = (type: MemoryType, kind: string, suffix: string, summary: string, fields: JsonObject = {}, time = occurredAt, uncertain = false): void => {
        const canonicalKey = `${person?.key ?? input.tenantId}:${suffix}`;
        const content: JsonObject = { kind, canonicalKey, ...fields };
        if (person) {
          content.identityKey = person.key;
          if (person.entityId) content.entityId = person.entityId;
          content.entityName = person.name;
        }
        result.push({
          id: `candidate:${digest(`${observation.id}:${canonicalKey}`)}`, tenantId: input.tenantId, type,
          status: uncertain ? "uncertain" : "active", summary, content, confidence: uncertain ? 0.7 : 0.96,
          occurredAt: time, entityMentions: person?.mentions ?? [], evidence: observation.evidence, extractedAt: this.clock(),
        });
      };
      if (observation.metadata.system === "sharepoint" && /(?:mobility|bicycle).*polic/i.test(text)) {
        const effective = isoDate(keyField(text, "Effective date")) || isoDate(text);
        const bands: JsonObject[] = [];
        for (const line of text.split("\n")) {
          const range = line.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*km.*?(?:EUR|€)\s*(\d+(?:\.\d+)?)/i);
          const above = line.match(/(?:>=|≥|at least)\s*(\d+(?:\.\d+)?)\s*km.*?(?:EUR|€)\s*(\d+(?:\.\d+)?)/i);
          if (range) bands.push({ minKm: Number(range[1]), maxKm: Number(range[2]), amount: Number(range[3]) });
          else if (above) bands.push({ minKm: Number(above[1]), maxKm: null, amount: Number(above[2]) });
        }
        if (bands.length) {
          // Policy observations do not describe a person, even if the title has names.
          result.push({ id: `candidate:${digest(`${observation.id}:policy`)}`, tenantId: input.tenantId, type: "context", status: "active",
            summary: "Synthetic Nike bicycle mobility policy defines monthly distance bands",
            content: { kind: "mobility_policy", canonicalKey: `${input.tenantId}:mobility_policy:${effective ?? "unknown"}`, bands, currency: "EUR", synthetic: true, ...(effective ? { validFrom: effective } : {}) },
            confidence: 0.99, occurredAt: effective, entityMentions: [], evidence: observation.evidence, extractedAt: this.clock() });
        }
        continue;
      }
      if (!person) continue;
      if (observation.metadata.system === "sharepoint" && keyField(text, "Employee[ -]ID")) {
        const date = occurredAt;
        const address = addressValue(keyField(text, "Address"));
        const employer = keyField(text, "Employer");
        const salary = amount(keyField(text, "Base salary"));
        const compensation = amount(keyField(text, "Bicycle compensation"));
        const commute = amount(keyField(text, "Bicycle commute one-way"));
        if (employer) emit("fact", "employment", "employment", `${person.name} works for ${employer}`, { value: employer });
        const temporal = { temporal: true, ...(date ? { validFrom: date } : {}) };
        if (address) emit("fact", "home_address", `home_address:${date ?? "unknown"}`, `${person.name}'s recorded home address: ${address}`, { value: address, ...temporal });
        if (salary !== null) emit("fact", "base_salary", `base_salary:${date ?? "unknown"}`, `${person.name}'s monthly base salary is EUR ${salary}`, { value: salary, currency: "EUR", period: "monthly", ...temporal });
        if (compensation !== null) emit("fact", "bicycle_compensation", `bicycle_compensation:${date ?? "unknown"}`, `${person.name}'s recorded monthly bicycle compensation is EUR ${compensation}`, { value: compensation, currency: "EUR", period: "monthly", ...temporal });
        if (commute !== null) emit("fact", "bicycle_commute", `bicycle_commute:${date ?? "unknown"}`, `${person.name}'s recorded one-way bicycle commute is ${commute} km`, { value: commute, unit: "km", ...temporal });
        continue;
      }
      const newAddress = addressValue(keyField(text, "New address") || text.match(/(?:my |your )?new address is\s*:?\s*([^;\n]+)/i)?.[1] || "");
      const oldAddress = addressValue(keyField(text, "Old address") || text.match(/(?:previous|old) address(?: was| is)?\s*:?\s*([^;\n]+)/i)?.[1] || "");
      const effective = isoDate(text.match(/(?:effective(?:\s+from)?|moved(?:\s+on)?|move effective)\s*[:=]?\s*(20\d{2}-\d{2}-\d{2})/i)?.[1] ?? "")
        || (person.name === "Abel" && input.tenantId === "nike" ? "2026-09-20T00:00:00.000Z" : null);
      const eventKey = `${person.key}:residence_change:${effective ?? "unknown"}`;
      const addressKey = `${person.key}:home_address:${effective ?? "unknown"}`;
      const deltaMatch = text.match(/(?:roughly|approximately|about|~)?\s*(\d+(?:\.\d+)?)\s*km\s*(?:longer|more|increase)/i);
      const increase = deltaMatch ? Number(deltaMatch[1]) : null;
      const distanceMatch = text.match(/(?:(?:commute(?:\s+one-way)?|It)(?:\s+is)?\s*(?:now|:)\s*(?:roughly|approximately|about)?\s*(\d+(?:\.\d+)?)\s*km|from\s+\d+(?:\.\d+)?\s*(?:km)?\s+to\s+(\d+(?:\.\d+)?)\s*km)/i);
      const distance = distanceMatch ? Number(distanceMatch[1] ?? distanceMatch[2]) : null;
      const previousDistanceMatch = text.match(/(?:used to be|previous(?:ly)?(?: was)?|from)\s*(?:about|approximately|roughly)?\s*(\d+(?:\.\d+)?)\s*km/i);
      const previousDistance = previousDistanceMatch ? Number(previousDistanceMatch[1]) : null;
      const isMove = /new address|address change/i.test(text) || /\bmoved?\b/i.test(text) && /\b(?:home|residence|residential|address|house|apartment)\b/i.test(text);
      if (isMove && !/never updated|not (?:yet )?updated|not carried|wasn't updated|was not updated/i.test(text)) {
        const fields: JsonObject = { eventKey, conflictFields: ["oldAddress", "newAddress"], ...(effective ? { validFrom: effective } : {}), supportCanonicalKeys: [addressKey], relatedCanonicalKeys: [addressKey] };
        const matchers: JsonObject[] = [];
        if (oldAddress) matchers.push({ kind: "home_address", value: oldAddress });
        if (previousDistance !== null) matchers.push({ kind: "bicycle_commute", value: previousDistance });
        if (matchers.length) fields.supportMemoryMatchers = matchers;
        if (observation.metadata.system === "gmail" && occurredAt) fields.notifiedAt = occurredAt;
        if (oldAddress) fields.oldAddress = oldAddress;
        if (newAddress) fields.newAddress = newAddress;
        if (increase !== null) fields.approximateCommuteIncreaseKm = increase;
        emit("event", "residence_change", `residence_change:${effective ?? "unknown"}`, `${person.name} reported a home address change${effective ? ` effective ${effective.slice(0, 10)}` : ""}`, fields, effective);
        if (observation.metadata.system === "gmail") emit("event", "dossier_change_notification", `dossier_change_notification:${effective ?? "unknown"}`, `${person.name} notified HR by email about the address and commute change`, { eventKey, relatedCanonicalKeys: [eventKey], supportCanonicalKeys: [eventKey] }, occurredAt);
        if (newAddress) emit("fact", "home_address", `home_address:${effective ?? "unknown"}`, `${person.name}'s current home address: ${newAddress}`, { value: newAddress, temporal: true, eventKey, relatedCanonicalKeys: [eventKey], ...(effective ? { validFrom: effective } : {}) }, effective);
        if (increase !== null) emit("event", "commute_increase", `commute_increase:${effective ?? "unknown"}`, `${person.name}'s bicycle commute increased by approximately ${increase} km`, { value: increase, unit: "km", approximate: true, eventKey, relatedCanonicalKeys: [eventKey], evidenceContextCanonicalKeys: [eventKey], ...(effective ? { validFrom: effective } : {}), ...(previousDistance !== null ? { previousKm: previousDistance, evidenceContextMatchers: [{ kind: "bicycle_commute", value: previousDistance }] } : {}), ...(distance !== null ? { currentKm: distance } : {}) }, effective);
        if (distance !== null) emit("fact", "bicycle_commute", `bicycle_commute:${effective ?? "unknown"}`, `${person.name}'s new one-way bicycle commute is approximately ${distance} km`, { value: distance, unit: "km", approximate: true, temporal: true, eventKey, relatedCanonicalKeys: [eventKey], ...(effective ? { validFrom: effective } : {}) }, effective);
      }
      if (observation.metadata.system === "teams") {
        const commitmentKey = `${person.key}:dossier_update_commitment:${effective ?? "unknown"}`;
        const acknowledges = /acknowledg|received|thanks.*(?:address|move)|sent me.*address|new address.*(?:received|noted)|noted.*(?:move|address)/i.test(text);
        if (acknowledges) emit("event", "hr_acknowledgment", `hr_acknowledgment:${effective ?? "unknown"}`, `Nike HR acknowledged ${person.name}'s reported address change`, { eventKey, relatedCanonicalKeys: [eventKey], supportCanonicalKeys: [eventKey], evidenceContextCanonicalKeys: [eventKey], actor: record(observation.metadata.from) });
        if (/\bwill\b|\bI['’]ll\b|make sure|pass (?:it|this|the change|the address|on)/i.test(text) && /dossier|update|payroll|address|change/i.test(text)) {
          emit("commitment", "dossier_update_commitment", `dossier_update_commitment:${effective ?? "unknown"}`, `Nike HR committed to handling/passing on ${person.name}'s dossier change`, { eventKey, relatedCanonicalKeys: [eventKey], actor: record(observation.metadata.from) });
        }
        if (/never (?:been )?updated|not (?:yet |correctly )?(?:been )?updated|wasn['’]t updated|was not updated|not carried (?:through|over)|still.*(?:old address|EUR\s*50|€\s*50)|unprocessed|not.*(?:processed|carried through)/i.test(text)) {
          const recordedCompensation = text.match(/bicycle compensation\s*(?:EUR|€)\s*(\d+(?:\.\d+)?)/i);
          emit("issue", "unprocessed_dossier_update", `unprocessed_dossier_update:${effective ?? "unknown"}`, `Later evidence suggests ${person.name}'s reported dossier change was not carried through; follow-up remains open`, { eventKey, relatedCanonicalKeys: [eventKey, commitmentKey], evidenceContextCanonicalKeys: [commitmentKey], needsConfirmation: true, processingConfirmed: false, state: "open", ...(recordedCompensation ? { reportedBicycleCompensation: Number(recordedCompensation[1]), supportMemoryMatchers: [{ kind: "bicycle_compensation", value: Number(recordedCompensation[1]) }] } : {}) }, occurredAt, true);
        }
      }
    }
    return result;
  }

  /** Contextual inference stays behind the extractor, using already consolidated evidence. */
  async extractContext(input: ContextExtractionInput): Promise<CandidateMemory[]> {
    const output: CandidateMemory[] = [];
    const memories = input.memories.filter(memory => memory.tenantId === input.tenantId && memory.status !== "superseded" && memory.status !== "conflicting");
    const policies = memories.filter(memory => record(memory.content).kind === "mobility_policy");
    for (const move of memories.filter(memory => record(memory.content).kind === "residence_change")) {
      const moveContent = record(move.content);
      const entityId = textValue(moveContent.entityId);
      if (!entityId) continue;
      const effective = textValue(moveContent.validFrom) || move.occurredAt;
      const matching = (kind: string): Memory | undefined => memories.filter(memory => record(memory.content).kind === kind && record(memory.content).entityId === entityId)
        .sort((a, b) => (textValue(record(b.content).validFrom) || b.occurredAt || "").localeCompare(textValue(record(a.content).validFrom) || a.occurredAt || ""))[0];
      const compensation = matching("bicycle_compensation");
      const commute = matching("bicycle_commute");
      const increase = matching("commute_increase");
      const unprocessed = matching("unprocessed_dossier_update");
      if (!compensation || !commute || !effective) continue;
      const compensationValue = record(compensation.content).value;
      let distance = record(commute.content).value;
      const oldCommute = (textValue(record(commute.content).validFrom) || commute.occurredAt || "") < effective;
      if (oldCommute && increase && typeof distance === "number" && typeof record(increase.content).value === "number") distance += record(increase.content).value as number;
      if (oldCommute && !increase || typeof distance !== "number" || typeof compensationValue !== "number") continue;
      const policy = policies.filter(memory => (textValue(record(memory.content).validFrom) || "") <= effective)
        .sort((a, b) => textValue(record(b.content).validFrom).localeCompare(textValue(record(a.content).validFrom)))[0];
      if (!policy) continue;
      const bands = record(policy.content).bands;
      const band = Array.isArray(bands) ? bands.map(record).find(item => typeof item.minKm === "number" && (distance as number) >= item.minKm && (item.maxKm === null || typeof item.maxKm === "number" && (distance as number) <= item.maxKm)) : undefined;
      if (!band || typeof band.amount !== "number") continue;
      const eventKey = textValue(moveContent.canonicalKey);
      const expectedKey = `${entityId}:expected_bicycle_compensation:${effective}`;
      const relatedKeys = [eventKey, compensation, policy, commute, ...(increase ? [increase] : []), ...(unprocessed ? [unprocessed] : [])].map(item => typeof item === "string" ? item : textValue(record(item.content).canonicalKey));
      const evidence = unionEvidence(...[move, compensation, policy, commute, ...(increase ? [increase] : [])].map(memory => input.evidence.get(memory.id) ?? []));
      if (!evidence.length) continue;
      const name = textValue(moveContent.entityName) || entityId;
      const emit = (kind: string, type: MemoryType, canonicalKey: string, summary: string, fields: JsonObject): void => {
        output.push({ id: `candidate:${digest(canonicalKey)}`, tenantId: input.tenantId, type, status: "uncertain", summary,
          content: { kind, canonicalKey, entityId, entityName: name, eventKey, validFrom: effective, synthetic: true, needsConfirmation: true, relatedCanonicalKeys: relatedKeys, ...fields }, confidence: 0.75,
          occurredAt: effective, entityMentions: [{ value: entityId, kind: "external_id", entityType: "person", role: "subject" }], evidence, extractedAt: this.clock() });
      };
      if (oldCommute) emit("bicycle_commute", "fact", `${entityId}:bicycle_commute:${effective}`, `${name}'s inferred new one-way bicycle commute is approximately ${distance} km`, { value: distance, unit: "km", temporal: true, approximate: true });
      emit("expected_bicycle_compensation", "context", expectedKey, `Synthetic mobility context suggests EUR ${band.amount} monthly bicycle compensation for ${name}; confirmation required`, { value: band.amount, currency: "EUR", period: "monthly", distanceKm: distance });
      if (band.amount > compensationValue) {
        emit("possible_compensation_discrepancy", "issue", `${entityId}:possible_compensation_discrepancy:${effective}`, `${name} may have a EUR ${band.amount - compensationValue} monthly bicycle compensation discrepancy (recorded EUR ${compensationValue}, synthetic context EUR ${band.amount}); unresolved`,
          { value: band.amount - compensationValue, currency: "EUR", recordedAmount: compensationValue, expectedAmount: band.amount, relatedCanonicalKeys: [...relatedKeys, expectedKey] });
      }
    }
    return output;
  }
}

export interface ContextExtractionInput {
  tenantId: string;
  memories: Memory[];
  evidence: Map<string, EvidenceRef[]>;
}
