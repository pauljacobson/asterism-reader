export const accentIds = [
  "violet",
  "blue",
  "teal",
  "rose",
  "amber",
  "slate",
] as const;
export const accentChoices = accentIds.map((id) => ({
  id,
  label: id[0].toUpperCase() + id.slice(1),
}));
export const defaultPreferences = {
  theme: "system",
  font: "sans",
  size: 18,
  accent: "violet",
};

// Older accounts have no accent field; keep their existing reading settings.
export function accountPreferences(stored: string) {
  return { ...defaultPreferences, ...JSON.parse(stored) };
}
