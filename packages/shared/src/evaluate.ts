import type { ClinicalExtraction, FieldScores, Hallucination } from ".";
import { bestFuzzy, exactish, normalizeText, tokenSetRatio } from "./text";

type MatchOptions<T> = {
  predicted: T[];
  gold: T[];
  matches: (predicted: T, gold: T) => boolean;
};

export function setF1<T>({ predicted, gold, matches }: MatchOptions<T>): number {
  if (predicted.length === 0 && gold.length === 0) return 1;
  if (predicted.length === 0 || gold.length === 0) return 0;
  const usedGold = new Set<number>();
  let truePositive = 0;
  for (const item of predicted) {
    const index = gold.findIndex((candidate, candidateIndex) => !usedGold.has(candidateIndex) && matches(item, candidate));
    if (index >= 0) {
      usedGold.add(index);
      truePositive += 1;
    }
  }
  const precision = truePositive / predicted.length;
  const recall = truePositive / gold.length;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function vitalsScore(prediction: ClinicalExtraction, gold: ClinicalExtraction): number {
  const bp = prediction.vitals.bp === gold.vitals.bp ? 1 : 0;
  const hr = prediction.vitals.hr === gold.vitals.hr ? 1 : 0;
  const spo2 = prediction.vitals.spo2 === gold.vitals.spo2 ? 1 : 0;
  const temp =
    prediction.vitals.temp_f === null && gold.vitals.temp_f === null
      ? 1
      : prediction.vitals.temp_f !== null && gold.vitals.temp_f !== null && Math.abs(prediction.vitals.temp_f - gold.vitals.temp_f) <= 0.2
        ? 1
        : 0;
  return (bp + hr + temp + spo2) / 4;
}

function medicationMatches(predicted: ClinicalExtraction["medications"][number], gold: ClinicalExtraction["medications"][number]): boolean {
  return (
    tokenSetRatio(predicted.name, gold.name) >= 0.75 &&
    exactish(predicted.dose, gold.dose) &&
    exactish(predicted.frequency, gold.frequency)
  );
}

function diagnosesScore(prediction: ClinicalExtraction, gold: ClinicalExtraction): number {
  const base = setF1({
    predicted: prediction.diagnoses,
    gold: gold.diagnoses,
    matches: (predicted, candidate) => tokenSetRatio(predicted.description, candidate.description) >= 0.72,
  });
  if (prediction.diagnoses.length === 0 || gold.diagnoses.length === 0) return base;
  let bonus = 0;
  let possible = 0;
  for (const predicted of prediction.diagnoses) {
    const match = gold.diagnoses.find((candidate) => tokenSetRatio(predicted.description, candidate.description) >= 0.72);
    if (match?.icd10) {
      possible += 1;
      if (predicted.icd10 === match.icd10) bonus += 1;
    }
  }
  return Math.min(1, base + (possible === 0 ? 0 : (bonus / possible) * 0.1));
}

export function scoreExtraction(prediction: ClinicalExtraction, gold: ClinicalExtraction): FieldScores {
  const scores = {
    chief_complaint: tokenSetRatio(prediction.chief_complaint, gold.chief_complaint),
    vitals: vitalsScore(prediction, gold),
    medications: setF1({ predicted: prediction.medications, gold: gold.medications, matches: medicationMatches }),
    diagnoses: diagnosesScore(prediction, gold),
    plan: setF1({
      predicted: prediction.plan,
      gold: gold.plan,
      matches: (predicted, candidate) => tokenSetRatio(predicted, candidate) >= 0.68,
    }),
    follow_up:
      (prediction.follow_up.interval_days === gold.follow_up.interval_days ? 0.55 : 0) +
      tokenSetRatio(prediction.follow_up.reason, gold.follow_up.reason) * 0.45,
  };
  return {
    ...scores,
    aggregate:
      (scores.chief_complaint + scores.vitals + scores.medications + scores.diagnoses + scores.plan + scores.follow_up) / 6,
  };
}

function collectGroundableValues(prediction: ClinicalExtraction): Array<{ field: string; value: string }> {
  const values: Array<{ field: string; value: string }> = [
    { field: "chief_complaint", value: prediction.chief_complaint },
    { field: "vitals.bp", value: prediction.vitals.bp ?? "" },
    { field: "vitals.hr", value: prediction.vitals.hr === null ? "" : String(prediction.vitals.hr) },
    { field: "vitals.temp_f", value: prediction.vitals.temp_f === null ? "" : String(prediction.vitals.temp_f) },
    { field: "vitals.spo2", value: prediction.vitals.spo2 === null ? "" : String(prediction.vitals.spo2) },
    { field: "follow_up.reason", value: prediction.follow_up.reason ?? "" },
  ];
  prediction.medications.forEach((med, index) => {
    values.push({ field: `medications.${index}.name`, value: med.name });
    if (med.dose) values.push({ field: `medications.${index}.dose`, value: med.dose });
    if (med.frequency) values.push({ field: `medications.${index}.frequency`, value: med.frequency });
  });
  prediction.diagnoses.forEach((diagnosis, index) => {
    values.push({ field: `diagnoses.${index}.description`, value: diagnosis.description });
    if (diagnosis.icd10) values.push({ field: `diagnoses.${index}.icd10`, value: diagnosis.icd10 });
  });
  prediction.plan.forEach((item, index) => values.push({ field: `plan.${index}`, value: item }));
  return values.filter((item) => normalizeText(item.value).length > 1);
}

export function detectHallucinations(transcript: string, prediction: ClinicalExtraction): Hallucination[] {
  const normalizedTranscript = normalizeText(transcript);
  const windows = normalizedTranscript.split(/[.?!\n]+/).filter(Boolean);
  return collectGroundableValues(prediction).flatMap((item) => {
    const normalizedValue = normalizeText(item.value);
    const direct = normalizedTranscript.includes(normalizedValue);
    const numeric = /^[0-9./%]+$/.test(normalizedValue) && normalizedTranscript.includes(normalizedValue.replace("%", ""));
    const close = bestFuzzy(normalizedValue, windows) >= 0.62;
    if (direct || numeric || close) return [];
    return [{ field: item.field, value: item.value, reason: "No substring or close fuzzy support in transcript." }];
  });
}
