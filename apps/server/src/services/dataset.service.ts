import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClinicalExtraction } from "@test-evals/shared";
import { validateExtraction } from "@test-evals/shared";

export type DatasetCase = {
  transcriptId: string;
  transcript: string;
  gold: ClinicalExtraction;
};

export async function loadDataset(filter?: string[]): Promise<DatasetCase[]> {
  const root = join(process.cwd(), "data");
  const transcriptDir = join(root, "transcripts");
  const files = (await readdir(transcriptDir)).filter((file) => file.endsWith(".txt")).sort();
  const allow = filter ? new Set(filter) : null;
  const cases = await Promise.all(
    files.map(async (file) => {
      const transcriptId = file.replace(/\.txt$/, "");
      if (allow && !allow.has(transcriptId)) return null;
      const transcript = await readFile(join(transcriptDir, file), "utf8");
      const goldRaw = JSON.parse(await readFile(join(root, "gold", `${transcriptId}.json`), "utf8"));
      const validation = validateExtraction(goldRaw);
      if (!validation.ok || !validation.data) throw new Error(`Invalid gold file for ${transcriptId}: ${validation.errors.join(", ")}`);
      return { transcriptId, transcript, gold: validation.data };
    }),
  );
  return cases.filter((item): item is DatasetCase => item !== null);
}
