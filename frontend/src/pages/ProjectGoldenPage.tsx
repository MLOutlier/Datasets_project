import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AnnotationCanvas from "../components/AnnotationCanvas";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { projectsAPI, workflowAPI } from "../services/api";
import { useAuthStore } from "../store";
import type { BoundingBox, GoldenCandidate, GoldenSourceFrame } from "../types";
import { statusLabel } from "../lib/projectDisplay";

type CaseType = "positive" | "negative";
type GoldenStatus = "candidate" | "active";
type GoldenUsage = "control" | "instruction_example" | "both";
type ExpectedDecision = "approve" | "needs_changes";

const ISSUE_OPTIONS = [
  "manual_positive",
  "manual_negative",
  "missing_box",
  "bad_geometry",
  "wrong_label",
  "extra_box",
  "false_positive",
];

function boxesFromAnnotation(annotation?: Record<string, unknown>): BoundingBox[] {
  const rawBoxes = ((annotation as any)?.boxes ?? []) as Array<Partial<BoundingBox>>;
  return rawBoxes.map((box) => ({
    x: Number(box.x || 0),
    y: Number(box.y || 0),
    width: Number(box.width || 0),
    height: Number(box.height || 0),
    label: String(box.label || "object"),
  }));
}

function candidateToFrame(candidate: GoldenCandidate): GoldenSourceFrame {
  return {
    frame_id: candidate.frame_id,
    frame_url: candidate.frame_url,
    frame_number: candidate.frame_number,
    timestamp_sec: candidate.timestamp_sec,
    width: candidate.width,
    height: candidate.height,
    asset_id: candidate.asset_id,
    golden_frame_id: candidate.golden_frame_id,
    golden_status: candidate.status || (candidate.is_active ? "active" : "candidate"),
    case_type: candidate.case_type,
    issue_type: candidate.issue_type,
    reference_annotation: candidate.reference_annotation,
    candidate_score: candidate.candidate_score,
  };
}

export default function ProjectGoldenPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const [frameSearch, setFrameSearch] = useState("");
  const [selectedFrame, setSelectedFrame] = useState<GoldenSourceFrame | null>(null);
  const [boxes, setBoxes] = useState<BoundingBox[]>([]);
  const [selectedBoxIndex, setSelectedBoxIndex] = useState<number | null>(null);
  const [selectedLabel, setSelectedLabel] = useState("");
  const [caseType, setCaseType] = useState<CaseType>("positive");
  const [goldenStatus, setGoldenStatus] = useState<GoldenStatus>("candidate");
  const [usage, setUsage] = useState<GoldenUsage>("both");
  const [expectedDecision, setExpectedDecision] = useState<ExpectedDecision>("approve");
  const [issueType, setIssueType] = useState("manual_positive");
  const [reviewNotes, setReviewNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsAPI.get(projectId!),
    enabled: !!projectId,
  });
  const framesQuery = useQuery({
    queryKey: ["project-golden-source-frames", projectId, frameSearch],
    queryFn: () => workflowAPI.goldenSourceFrames(projectId!, { search: frameSearch.trim() || undefined, limit: 120 }),
    enabled: !!projectId,
  });
  const candidatesQuery = useQuery({
    queryKey: ["project-golden-candidates", projectId],
    queryFn: () => workflowAPI.goldenCandidates(projectId!),
    enabled: !!projectId,
  });

  const project = projectQuery.data;
  const candidates = candidatesQuery.data?.items ?? [];
  const labels = project?.label_schema ?? [];
  const activeCount = Number(candidatesQuery.data?.active_count ?? 0);
  const candidateCount = Number(candidatesQuery.data?.candidate_count ?? 0);
  const retiredCount = Number(candidatesQuery.data?.retired_count ?? 0);
  const canManage = user?.role === "admin" || user?.role === "customer";

  useEffect(() => {
    if (!selectedLabel && labels.length) {
      setSelectedLabel(labels[0].name);
    }
  }, [labels, selectedLabel]);

  useEffect(() => {
    if (caseType === "negative") {
      setExpectedDecision("needs_changes");
      if (issueType === "manual_positive") setIssueType("manual_negative");
      return;
    }
    setExpectedDecision("approve");
    if (issueType === "manual_negative") setIssueType("manual_positive");
  }, [caseType, issueType]);

  const selectFrame = (frame: GoldenSourceFrame) => {
    setSelectedFrame(frame);
    const nextBoxes = boxesFromAnnotation(frame.reference_annotation);
    setBoxes(nextBoxes);
    setSelectedBoxIndex(nextBoxes.length ? 0 : null);
    setCaseType((frame.case_type as CaseType) || "positive");
    setGoldenStatus(frame.golden_status === "active" ? "active" : "candidate");
    setIssueType(frame.issue_type || "manual_positive");
    setReviewNotes("");
    setError(null);
  };

  const selectCandidate = (candidate: GoldenCandidate) => {
    selectFrame(candidateToFrame(candidate));
    setUsage((candidate.usage as GoldenUsage) || "both");
    setExpectedDecision((candidate.expected_decision as ExpectedDecision) || "approve");
    setReviewNotes(candidate.review_notes || "");
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!projectId || !selectedFrame) throw new Error("Select a frame first.");
      if (caseType === "positive" && boxes.length === 0) throw new Error("Positive golden case requires at least one box.");
      const reference = { boxes };
      return workflowAPI.createGoldenCandidate(projectId, {
        frame_id: selectedFrame.frame_id,
        case_type: caseType,
        usage,
        expected_decision: expectedDecision,
        issue_type: issueType,
        status: goldenStatus,
        reference_annotation: reference,
        probe_annotation: caseType === "negative" ? { boxes: [] } : reference,
        review_notes: reviewNotes,
      });
    },
    onSuccess: async (saved) => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["project-golden-candidates", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["project-golden-source-frames", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["project-overview", projectId] });
      selectCandidate(saved);
    },
    onError: (err: any) => {
      setError(err?.response?.data?.detail || err?.message || "Failed to save golden case.");
    },
  });

  const promoteMutation = useMutation({
    mutationFn: ({ goldenFrameId, notes }: { goldenFrameId: string; notes?: string }) =>
      workflowAPI.promoteGoldenCandidate(projectId!, goldenFrameId, notes),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["project-golden-candidates", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["project-golden-source-frames", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["project-overview", projectId] });
    },
  });

  const retireMutation = useMutation({
    mutationFn: ({ goldenFrameId, notes }: { goldenFrameId: string; notes?: string }) =>
      workflowAPI.retireGoldenCandidate(projectId!, goldenFrameId, notes),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["project-golden-candidates", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["project-golden-source-frames", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["project-overview", projectId] });
    },
  });

  const addBox = () => {
    const label = selectedLabel || labels[0]?.name || "object";
    setBoxes((current) => [...current, { x: 0, y: 0, width: 100, height: 100, label }]);
    setSelectedBoxIndex(boxes.length);
  };

  const selectedCandidate = useMemo(
    () => candidates.find((item) => item.frame_id === selectedFrame?.frame_id),
    [candidates, selectedFrame?.frame_id],
  );

  if (projectQuery.isLoading) return <LoadingSpinner size="lg" />;

  if (!project || !canManage) {
    return (
      <div className="card p-8 text-center">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Golden dataset is not available</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Only the project owner or an admin can manage control examples.</p>
        <Link to={`/projects/${projectId}`} className="btn-secondary mt-4 inline-block">Back to project</Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{project.title}</div>
          <h1 className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">Golden Dataset</h1>
          <p className="mt-2 max-w-3xl text-sm text-gray-600 dark:text-gray-400">
            Create and manage hidden control examples used to measure annotator quality.
          </p>
        </div>
        <Link to={`/projects/${projectId}`} className="btn-secondary">Back to project</Link>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="card"><div className="text-sm text-gray-500">Active</div><div className="mt-1 text-2xl font-semibold">{activeCount}</div></div>
        <div className="card"><div className="text-sm text-gray-500">Candidates</div><div className="mt-1 text-2xl font-semibold">{candidateCount}</div></div>
        <div className="card"><div className="text-sm text-gray-500">Retired</div><div className="mt-1 text-2xl font-semibold">{retiredCount}</div></div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[320px,minmax(0,1fr),360px]">
        <aside className="card space-y-3 p-4">
          <input className="input-field" value={frameSearch} onChange={(event) => setFrameSearch(event.target.value)} placeholder="Search frames" />
          <div className="max-h-[68vh] overflow-auto rounded-lg border border-gray-200 dark:border-gray-800">
            {(framesQuery.data?.items ?? []).map((frame) => {
              const active = selectedFrame?.frame_id === frame.frame_id;
              return (
                <button
                  key={frame.frame_id}
                  type="button"
                  onClick={() => selectFrame(frame)}
                  className={`block w-full border-b border-gray-100 px-3 py-2 text-left text-sm last:border-b-0 dark:border-gray-800 ${
                    active ? "bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-100" : "hover:bg-gray-50 dark:hover:bg-gray-900"
                  }`}
                >
                  <div className="font-medium text-gray-900 dark:text-white">Frame {frame.frame_number}</div>
                  <div className="mt-1 text-xs text-gray-500">{statusLabel(frame.golden_status)} {frame.case_type ? `/ ${frame.case_type}` : ""}</div>
                </button>
              );
            })}
            {framesQuery.isLoading ? <div className="p-4"><LoadingSpinner size="sm" /></div> : null}
            {!framesQuery.isLoading && (framesQuery.data?.items ?? []).length === 0 ? (
              <div className="p-4 text-sm text-gray-500">No frames found.</div>
            ) : null}
          </div>
        </aside>

        <section className="space-y-4">
          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
            {selectedFrame ? (
              <AnnotationCanvas
                imageUrl={selectedFrame.frame_url}
                value={boxes}
                labels={labels}
                currentLabel={selectedLabel}
                selectedBoxIndex={selectedBoxIndex}
                onSelectedBoxIndexChange={setSelectedBoxIndex}
                onBoxesChange={setBoxes}
              />
            ) : (
              <div className="flex min-h-[420px] items-center justify-center rounded-lg border border-dashed border-gray-300 text-sm text-gray-500 dark:border-gray-700">
                Select a frame to start marking golden reference boxes.
              </div>
            )}
          </div>

          <div className="card space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Reference boxes</h2>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Draw boxes on the image or add/edit coordinates manually.</p>
              </div>
              <button type="button" className="btn-secondary" onClick={addBox} disabled={!selectedFrame}>Add box</button>
            </div>
            <div className="max-h-64 overflow-auto rounded-lg border border-gray-200 dark:border-gray-800">
              {boxes.map((box, index) => (
                <div key={index} className="grid grid-cols-2 gap-2 border-b border-gray-100 p-3 last:border-b-0 md:grid-cols-6 dark:border-gray-800">
                  <select
                    className="input-field"
                    value={box.label}
                    onChange={(event) => setBoxes((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))}
                  >
                    {labels.map((label) => <option key={label.name} value={label.name}>{label.name}</option>)}
                  </select>
                  {(["x", "y", "width", "height"] as const).map((field) => (
                    <input
                      key={field}
                      className="input-field"
                      type="number"
                      value={box[field]}
                      onChange={(event) => setBoxes((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: Number(event.target.value) } : item))}
                    />
                  ))}
                  <button type="button" className="btn-secondary" onClick={() => setBoxes((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>
                </div>
              ))}
              {boxes.length === 0 ? <div className="p-4 text-sm text-gray-500">No boxes yet.</div> : null}
            </div>
          </div>
        </section>

        <aside className="space-y-4">
          <div className="card space-y-4">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Case settings</h2>
            <select className="input-field" value={caseType} onChange={(event) => setCaseType(event.target.value as CaseType)}>
              <option value="positive">Positive: correct annotation</option>
              <option value="negative">Negative: should be rejected</option>
            </select>
            <select className="input-field" value={goldenStatus} onChange={(event) => setGoldenStatus(event.target.value as GoldenStatus)}>
              <option value="candidate">Candidate</option>
              <option value="active">Active</option>
            </select>
            <select className="input-field" value={usage} onChange={(event) => setUsage(event.target.value as GoldenUsage)}>
              <option value="control">Control only</option>
              <option value="instruction_example">Instruction example</option>
              <option value="both">Control and instruction</option>
            </select>
            <select className="input-field" value={expectedDecision} onChange={(event) => setExpectedDecision(event.target.value as ExpectedDecision)}>
              <option value="approve">Expected approve</option>
              <option value="needs_changes">Expected needs changes</option>
            </select>
            <select className="input-field" value={issueType} onChange={(event) => setIssueType(event.target.value)}>
              {ISSUE_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <textarea className="input-field min-h-[88px]" value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} placeholder="Notes for this control case" />
            {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}
            <button
              type="button"
              className="btn-primary w-full"
              disabled={!selectedFrame || saveMutation.isPending || (caseType === "positive" && boxes.length === 0)}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? "Saving..." : selectedCandidate ? "Update golden case" : "Save golden case"}
            </button>
          </div>

          <div className="card space-y-3">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Existing cases</h2>
            <div className="max-h-[52vh] space-y-2 overflow-auto pr-1">
              {candidates.map((candidate) => (
                <div key={candidate.golden_frame_id} className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-800">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium text-gray-900 dark:text-white">Frame {candidate.frame_number}</div>
                      <div className="mt-1 text-xs text-gray-500">
                        {statusLabel(candidate.status)} / {candidate.case_type || "positive"} / {candidate.issue_type || "manual"}
                      </div>
                    </div>
                    <button type="button" className="text-sm text-blue-600 hover:underline dark:text-blue-400" onClick={() => selectCandidate(candidate)}>
                      Edit
                    </button>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={candidate.status === "active" || promoteMutation.isPending}
                      onClick={() => promoteMutation.mutate({ goldenFrameId: candidate.golden_frame_id, notes: candidate.review_notes })}
                    >
                      Promote
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={candidate.status === "retired" || retireMutation.isPending}
                      onClick={() => retireMutation.mutate({ goldenFrameId: candidate.golden_frame_id, notes: candidate.review_notes })}
                    >
                      Retire
                    </button>
                  </div>
                </div>
              ))}
              {candidatesQuery.isLoading ? <LoadingSpinner size="sm" /> : null}
              {!candidatesQuery.isLoading && candidates.length === 0 ? <div className="text-sm text-gray-500">No golden cases yet.</div> : null}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
