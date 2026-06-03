export interface BuildQueryVariantsInput {
  semanticQuery: string;
  technicalTerms?: string[];
  enabled?: boolean;
  maxVariants?: number;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const normalized = value.trim().replace(/\s+/g, ' ');
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    out.push(normalized);
  }

  return out;
}

export function buildQueryVariants(input: BuildQueryVariantsInput): string[] {
  const maxVariants = input.maxVariants ?? 4;
  const base = input.semanticQuery.trim().replace(/\s+/g, ' ');
  if (!input.enabled) return base ? [base] : [];

  const terms = unique(input.technicalTerms ?? []);
  const variants = [base];

  if (terms.length > 0) {
    variants.push(`${terms.join(' ')} ${base}`);
  }

  const separators = /\b(?:and|or|with|plus|then|after|before|与|和|以及|然后)\b|[,;，；]/i;
  for (const part of base.split(separators)) {
    const trimmed = part.trim();
    if (trimmed.length >= 8) variants.push(trimmed);
  }

  return unique(variants).slice(0, maxVariants);
}
