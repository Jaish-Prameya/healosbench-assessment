import type { PromptStrategyName } from "@test-evals/shared";

export type PromptStrategy = {
  name: PromptStrategyName;
  system: string;
  examples: string[];
  userInstruction: string;
};

const baseSystem = `You extract structured clinical data from synthetic doctor-patient transcripts.
Return only by calling the provided extraction tool. Use null when a value is not stated.
Do not infer unsupported facts. Keep strings concise and faithful to the transcript.`;

const fewShotExamples = [
  `Transcript: Vitals BP 130/82 HR 72. Patient has burning urination for two days. Diagnosed uncomplicated UTI. Start nitrofurantoin 100 mg twice daily by mouth for 5 days. Follow up if fever or flank pain.
Extraction: chief complaint burning urination for two days; vitals bp 130/82 hr 72 temp null spo2 null; medication nitrofurantoin 100 mg BID PO; diagnosis uncomplicated urinary tract infection; plan antibiotics and return precautions; follow_up as needed for fever or flank pain.`,
  `Transcript: Patient reports migraine since yesterday with nausea. Temp 98.4, HR 80. Continue sumatriptan 50 mg PO as needed and keep headache diary. Recheck in 30 days.
Extraction: chief complaint migraine since yesterday with nausea; vitals temp 98.4 hr 80; medication sumatriptan 50 mg PRN PO; diagnosis migraine; plan headache diary; follow_up 30 days for migraine review.`,
];

export const strategies: Record<PromptStrategyName, PromptStrategy> = {
  zero_shot: {
    name: "zero_shot",
    system: baseSystem,
    examples: [],
    userInstruction: "Extract the clinical JSON from this transcript.",
  },
  few_shot: {
    name: "few_shot",
    system: `${baseSystem}\nFollow the style of the examples: compact, literal, and schema complete.`,
    examples: fewShotExamples,
    userInstruction: "Extract the clinical JSON from this transcript using the examples as formatting guidance.",
  },
  cot: {
    name: "cot",
    system: `${baseSystem}\nBefore calling the tool, silently identify evidence spans for complaint, vitals, medications, diagnoses, plan, and follow-up. The final tool input must contain only the extraction.`,
    examples: fewShotExamples,
    userInstruction: "Extract the clinical JSON. Reason privately over evidence, then call the extraction tool.",
  },
};
