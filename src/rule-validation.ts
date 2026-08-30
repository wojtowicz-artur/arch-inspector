import type { RuleSpec, RuleValue } from "./rules.js";
import { ruleFieldsBySource } from "./rule-schema.js";

function isFieldRef(value: RuleValue | undefined): value is { field: string } {
  return typeof value === "object" && value !== null && "field" in value;
}

function validateRuleField(rule: RuleSpec, fieldName: string, context: string): void {
  if (!ruleFieldsBySource[rule.source].includes(fieldName)) {
    throw new Error(
      `Invalid rule specification '${rule.code}': ${context} field '${fieldName}' is not available for '${rule.source}'.`,
    );
  }
}

/** Validate references against the fields emitted by the selected collection. */
export function validateRuleSemantics(rule: RuleSpec): void {
  for (const condition of rule.where ?? []) {
    validateRuleField(rule, condition.field, "condition");
    if (isFieldRef(condition.value)) validateRuleField(rule, condition.value.field, "condition value");
  }
  const finding = rule.finding;
  for (const reference of [finding.file, finding.line, finding.related]) {
    if (reference) validateRuleField(rule, reference.field, "finding");
  }
  for (const reference of Object.values(finding.data ?? {})) validateRuleField(rule, reference.field, "finding data");
  for (const match of finding.message.matchAll(/\$\{([^}]+)\}/g)) {
    validateRuleField(rule, match[1], "finding message");
  }
}
