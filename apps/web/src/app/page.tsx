"use client";

import type { RunDetailDto, RunSummary } from "@test-evals/shared";
import { Activity, GitCompare, Play, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const API = "http://localhost:8787/api/v1";
const fields = ["chief_complaint", "vitals", "medications", "diagnoses", "plan", "follow_up"] as const;

export default function Home() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRun, setSelectedRun] = useState<RunDetailDto | null>(null);
  const [selectedCase, setSelectedCase] = useState<string | null>(null);
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [strategy, setStrategy] = useState("zero_shot");

  async function loadRuns() {
    const response = await fetch(`${API}/runs`);
    if (response.ok) setRuns(await response.json());
  }

  async function loadRun(id: string) {
    const response = await fetch(`${API}/runs/${id}`);
    if (response.ok) {
      const detail = (await response.json()) as RunDetailDto;
      setSelectedRun(detail);
      setSelectedCase(detail.cases[0]?.transcriptId ?? null);
    }
  }

  async function startRun() {
    const response = await fetch(`${API}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy }),
    });
    if (response.ok) {
      const { runId } = await response.json();
      await loadRuns();
      await loadRun(runId);
    }
  }

  useEffect(() => {
    void loadRuns();
  }, []);

  const activeCase = selectedRun?.cases.find((item) => item.transcriptId === selectedCase) ?? null;
  const leftRun = runs.find((run) => run.runId === left);
  const rightRun = runs.find((run) => run.runId === right);
  const deltas = useMemo(() => {
    if (!leftRun || !rightRun) return [];
    return [...fields, "aggregate" as const].map((field) => {
      const delta = rightRun.fieldAggregates[field] - leftRun.fieldAggregates[field];
      return { field, delta, winner: delta > 0 ? rightRun.strategy : delta < 0 ? leftRun.strategy : "tie" };
    });
  }, [leftRun, rightRun]);

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <section className="border-b border-zinc-800 bg-zinc-950">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">HEALOSBENCH</h1>
            <p className="text-sm text-zinc-400">Structured clinical extraction eval harness</p>
          </div>
          <div className="flex items-center gap-2">
            <select className="h-10 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm" value={strategy} onChange={(event) => setStrategy(event.target.value)}>
              <option value="zero_shot">zero_shot</option>
              <option value="few_shot">few_shot</option>
              <option value="cot">cot</option>
            </select>
            <button className="inline-flex h-10 items-center gap-2 rounded-md bg-cyan-500 px-4 text-sm font-medium text-zinc-950" onClick={startRun}>
              <Play size={16} /> Run
            </button>
            <button className="inline-flex h-10 items-center gap-2 rounded-md border border-zinc-700 px-3 text-sm" onClick={loadRuns}>
              <RefreshCw size={16} /> Refresh
            </button>
          </div>
        </div>
      </section>

      <div className="mx-auto grid max-w-7xl grid-cols-12 gap-6 px-6 py-6">
        <section className="col-span-12 lg:col-span-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-300">
            <Activity size={16} /> Runs
          </div>
          <div className="overflow-hidden rounded-md border border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-900 text-zinc-400">
                <tr>
                  <th className="p-3">Strategy</th>
                  <th className="p-3">F1</th>
                  <th className="p-3">Cost</th>
                  <th className="p-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.runId} className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-900" onClick={() => void loadRun(run.runId)}>
                    <td className="p-3">{run.strategy}</td>
                    <td className="p-3">{run.aggregateF1.toFixed(3)}</td>
                    <td className="p-3">${run.costUsd.toFixed(4)}</td>
                    <td className="p-3 text-zinc-400">{run.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="col-span-12 lg:col-span-8">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-300">
            <GitCompare size={16} /> Compare
          </div>
          <div className="mb-6 grid gap-3 rounded-md border border-zinc-800 p-4 md:grid-cols-2">
            <select className="h-10 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm" value={left} onChange={(event) => setLeft(event.target.value)}>
              <option value="">Left run</option>
              {runs.map((run) => (
                <option key={run.runId} value={run.runId}>{`${run.strategy} ${run.aggregateF1.toFixed(3)}`}</option>
              ))}
            </select>
            <select className="h-10 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm" value={right} onChange={(event) => setRight(event.target.value)}>
              <option value="">Right run</option>
              {runs.map((run) => (
                <option key={run.runId} value={run.runId}>{`${run.strategy} ${run.aggregateF1.toFixed(3)}`}</option>
              ))}
            </select>
            <div className="md:col-span-2 grid gap-2 md:grid-cols-7">
              {deltas.map((item) => (
                <div key={item.field} className="rounded-md border border-zinc-800 p-3">
                  <div className="truncate text-xs text-zinc-500">{item.field}</div>
                  <div className={item.delta >= 0 ? "text-lg font-semibold text-emerald-300" : "text-lg font-semibold text-rose-300"}>{item.delta.toFixed(3)}</div>
                  <div className="truncate text-xs text-zinc-400">{item.winner}</div>
                </div>
              ))}
            </div>
          </div>

          {selectedRun ? (
            <div className="grid gap-6">
              <div className="grid gap-2 md:grid-cols-6">
                {fields.map((field) => (
                  <div key={field} className="rounded-md bg-zinc-900 p-3">
                    <div className="truncate text-xs text-zinc-500">{field}</div>
                    <div className="text-lg font-semibold">{selectedRun.fieldAggregates[field].toFixed(3)}</div>
                  </div>
                ))}
              </div>
              <div className="overflow-hidden rounded-md border border-zinc-800">
                <table className="w-full text-left text-sm">
                  <tbody>
                    {selectedRun.cases.map((item) => (
                      <tr key={item.id} className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-900" onClick={() => setSelectedCase(item.transcriptId)}>
                        <td className="p-3">{item.transcriptId}</td>
                        <td className="p-3">{item.evaluation?.scores.aggregate.toFixed(3) ?? "failed"}</td>
                        <td className="p-3 text-zinc-400">{item.cached ? "cached" : `${item.attempts.length} attempts`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {activeCase ? (
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="max-h-[520px] overflow-auto rounded-md border border-zinc-800 bg-zinc-900 p-4 text-xs leading-6 whitespace-pre-wrap">
                    <HighlightedTranscript transcript={activeCase.transcript} prediction={activeCase.prediction} />
                  </div>
                  <div className="grid gap-4">
                    <JsonBlock title="Field Diff" value={{ scores: activeCase.evaluation?.scores, hallucinations: activeCase.evaluation?.hallucinations }} />
                    <JsonBlock title="Gold" value={activeCase.gold} />
                    <JsonBlock title="Prediction" value={activeCase.prediction} />
                    <JsonBlock title="Trace" value={activeCase.attempts} />
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rounded-md border border-zinc-800 p-8 text-sm text-zinc-400">Select a run to inspect case scores, JSON diffs, and attempt traces.</div>
          )}
        </section>
      </div>
    </main>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900">
      <div className="border-b border-zinc-800 px-3 py-2 text-sm font-medium">{title}</div>
      <pre className="max-h-64 overflow-auto p-3 text-xs">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

function HighlightedTranscript({ transcript, prediction }: { transcript: string; prediction: RunDetailDto["cases"][number]["prediction"] }) {
  if (!prediction) return transcript;
  const values = [
    prediction.chief_complaint,
    prediction.vitals.bp,
    prediction.vitals.hr?.toString(),
    prediction.vitals.temp_f?.toString(),
    prediction.vitals.spo2?.toString(),
    ...prediction.medications.flatMap((med) => [med.name, med.dose, med.frequency].filter(Boolean)),
    ...prediction.diagnoses.flatMap((diagnosis) => [diagnosis.description, diagnosis.icd10].filter(Boolean)),
    ...prediction.plan,
    prediction.follow_up.reason,
  ]
    .filter((value): value is string => Boolean(value && value.length > 2))
    .sort((a, b) => b.length - a.length)
    .slice(0, 40);
  const escaped = values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escaped.length === 0) return transcript;
  const regex = new RegExp(`(${escaped.join("|")})`, "gi");
  return transcript.split(regex).map((part, index) =>
    values.some((value) => value.toLowerCase() === part.toLowerCase()) ? (
      <mark key={`${part}-${index}`} className="rounded bg-cyan-300/25 px-0.5 text-cyan-100">
        {part}
      </mark>
    ) : (
      <span key={`${part}-${index}`}>{part}</span>
    ),
  );
}
