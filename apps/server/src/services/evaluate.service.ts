import type { CaseEvaluation, ClinicalExtraction } from "@test-evals/shared";
import { detectHallucinations, scoreExtraction } from "@test-evals/shared/evaluate";

export function evaluateCase(transcriptId: string, transcript: string, prediction: ClinicalExtraction, gold: ClinicalExtraction): CaseEvaluation {
  return {
    transcriptId,
    scores: scoreExtraction(prediction, gold),
    hallucinations: detectHallucinations(transcript, prediction),
    schemaValid: true,
  };
}
