import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { participantsAPI, projectsAPI, workflowAPI } from "../services/api";
import { Participant, Project, ProjectLabel, ProjectParticipantRules, Role } from "../types";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { useAuthStore } from "../store";

const DEFAULT_LABEL_COLORS = ["#2563eb", "#16a34a", "#dc2626", "#ea580c", "#7c3aed", "#0891b2", "#ca8a04", "#4f46e5"];
const TRACKING_ALGORITHMS = ["CSRT", "KCF", "MOSSE", "MIL", "MedianFlow", "TLD", "BOOSTING"] as const;

function splitLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function joinLines(lines?: string[]): string {
  return (lines ?? []).join("\n");
}

function getDefaultLabelColor(index: number): string {
  return DEFAULT_LABEL_COLORS[index % DEFAULT_LABEL_COLORS.length];
}

function ensureUniqueLabelNames(labels: ProjectLabel[]): { ok: boolean; error?: string } {
  const seen = new Set<string>();
  for (const label of labels) {
    const key = (label.name || "").trim().toLowerCase();
    if (!key) return { ok: false, error: "Label name cannot be empty." };
    if (seen.has(key)) return { ok: false, error: `Duplicate label name: ${label.name}` };
    seen.add(key);
  }
  return { ok: true };
}

function ensureUniqueLabelColors(labels: ProjectLabel[]): { ok: boolean; error?: string } {
  const seen = new Set<string>();
  for (const label of labels) {
    const color = (label.color || "").trim().toLowerCase();
    if (!color) continue;
    if (seen.has(color)) return { ok: false, error: `Duplicate label color: ${label.color}` };
    seen.add(color);
  }
  return { ok: true };
}

function normalizeParticipantRules(rules?: ProjectParticipantRules): Required<ProjectParticipantRules> {
  return {
    specialization: String(rules?.specialization ?? ""),
    group: String(rules?.group ?? ""),
    assignment_scope: (rules?.assignment_scope as Required<ProjectParticipantRules>["assignment_scope"]) ?? "selected_only",
    stage_pools: rules?.stage_pools ?? {},
    ai_prelabel_enabled: Boolean(rules?.ai_prelabel_enabled ?? true),
    ai_model: String(rules?.ai_model ?? "baseline-box-v1"),
    ai_confidence_threshold: Number(rules?.ai_confidence_threshold ?? 0.7),
    video_keyframe_interval: Number(rules?.video_keyframe_interval ?? 1),
    tracking_algorithm: String(rules?.tracking_algorithm ?? "CSRT"),
    task_batch_size: Number(rules?.task_batch_size ?? 10),
    min_sequence_size: Number(rules?.min_sequence_size ?? 3),
    interval_annotators_per_chunk: Number(rules?.interval_annotators_per_chunk ?? 1),
    interval_validators_per_item: Number(rules?.interval_validators_per_item ?? 3),
    bbox_validators_per_batch: Number(rules?.bbox_validators_per_batch ?? 3),
    bbox_real_items_per_batch: Number(rules?.bbox_real_items_per_batch ?? 20),
    bbox_golden_items_per_batch: Number(rules?.bbox_golden_items_per_batch ?? 10),
    golden_min_score: Number(rules?.golden_min_score ?? 0.8),
    golden_candidate_threshold: Number(rules?.golden_candidate_threshold ?? 0.9),
    golden_promotion_target: Number(rules?.golden_promotion_target ?? 10),
    interval_review_padding_sec: Number(rules?.interval_review_padding_sec ?? 3),
    stuck_assignment_ttl_minutes: Number(rules?.stuck_assignment_ttl_minutes ?? 30),
  };
}

function canEditProject(role?: Role): boolean {
  return role === "customer" || role === "admin";
}

function ParticipantSelector({
  title,
  hint,
  items,
  selected,
  onToggle,
}: {
  title: string;
  hint?: string;
  items: Participant[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div>
      <div className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">{title}</div>
      {hint ? <div className="mb-3 text-xs text-gray-500 dark:text-gray-400">{hint}</div> : null}
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {items.map((participant) => {
          const active = selected.includes(participant.id);
          return (
            <button
              key={participant.id}
              type="button"
              onClick={() => onToggle(participant.id)}
              className={`rounded-lg border p-3 text-left transition ${active ? "border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-900/30" : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-700 dark:bg-gray-950"}`}
            >
              <div className="font-medium text-gray-900 dark:text-white">{participant.username}</div>
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {participant.specialization || "No specialization"} | rating {participant.rating?.toFixed(2) ?? "0.00"}
              </div>
              {participant.group_name ? <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">group: {participant.group_name}</div> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function ProjectWorkflowPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const [annotationType, setAnnotationType] = useState<Project["annotation_type"]>("bbox");
  const [frameInterval, setFrameInterval] = useState("1");
  const [assignmentsPerTask, setAssignmentsPerTask] = useState("2");
  const [agreementThreshold, setAgreementThreshold] = useState("0.75");
  const [iouThreshold, setIouThreshold] = useState("0.5");
  const [specialization, setSpecialization] = useState("");
  const [groupRule, setGroupRule] = useState("");
  const [assignmentScope, setAssignmentScope] = useState<Required<ProjectParticipantRules>["assignment_scope"]>("selected_only");
  const [aiEnabled, setAiEnabled] = useState(true);
  const [aiModel, setAiModel] = useState("baseline-box-v1");
  const [aiConfidenceThreshold, setAiConfidenceThreshold] = useState("0.7");
  const [videoKeyframeInterval, setVideoKeyframeInterval] = useState("1");
  const [trackingAlgorithm, setTrackingAlgorithm] = useState<(typeof TRACKING_ALGORITHMS)[number]>("CSRT");
  const [taskBatchSize, setTaskBatchSize] = useState("10");
  const [minSequenceSize, setMinSequenceSize] = useState("3");
  const [labels, setLabels] = useState<ProjectLabel[]>([{ name: "drone", color: getDefaultLabelColor(0) }]);
  const [selectedAnnotators, setSelectedAnnotators] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [participantsCsv, setParticipantsCsv] = useState<File | null>(null);
  const [distributionResult, setDistributionResult] = useState("");

  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsAPI.get(projectId!),
    enabled: !!projectId,
  });

  const overviewQuery = useQuery({
    queryKey: ["project-overview", projectId],
    queryFn: () => workflowAPI.overview(projectId!),
    enabled: !!projectId,
  });

  const annotatorsQuery = useQuery({
    queryKey: ["participants", "annotator"],
    queryFn: () => participantsAPI.list("annotator"),
  });

  useEffect(() => {
    if (!projectQuery.data) return;
    const project = projectQuery.data;
    const rules = normalizeParticipantRules(project.participant_rules);

    setAnnotationType(project.annotation_type);
    setFrameInterval(String(project.frame_interval_sec ?? 1));
    setAssignmentsPerTask(String(project.assignments_per_task ?? 2));
    setAgreementThreshold(String(project.agreement_threshold ?? 0.75));
    setIouThreshold(String(project.iou_threshold ?? 0.5));
    setSpecialization(rules.specialization);
    setGroupRule(rules.group);
    setAssignmentScope(rules.assignment_scope);
    setAiEnabled(rules.ai_prelabel_enabled);
    setAiModel(rules.ai_model);
    setAiConfidenceThreshold(String(rules.ai_confidence_threshold));
    setVideoKeyframeInterval(String(rules.video_keyframe_interval));
    setTaskBatchSize(String(rules.task_batch_size));
    setMinSequenceSize(String(rules.min_sequence_size));
    setTrackingAlgorithm(
      (TRACKING_ALGORITHMS.includes(rules.tracking_algorithm as (typeof TRACKING_ALGORITHMS)[number]) ? rules.tracking_algorithm : "CSRT") as (typeof TRACKING_ALGORITHMS)[number]
    );
    setLabels(
      (project.label_schema?.length ? project.label_schema : [{ name: "drone", color: getDefaultLabelColor(0) }]).map((label, index) => ({
        ...label,
        color: label.color || getDefaultLabelColor(index),
      }))
    );
    setSelectedAnnotators(project.allowed_annotator_ids ?? []);
  }, [projectQuery.data]);

  const hasWorkItems = useMemo(() => Number(overviewQuery.data?.work_items?.total ?? 0) > 0, [overviewQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error("Project id missing");
      const uniqueCheck = ensureUniqueLabelNames(labels);
      if (!uniqueCheck.ok) throw new Error(uniqueCheck.error || "Invalid label schema");
      const uniqueColors = ensureUniqueLabelColors(labels);
      if (!uniqueColors.ok) throw new Error(uniqueColors.error || "Invalid label colors");

      return projectsAPI.update(projectId, {
        annotation_type: annotationType,
        frame_interval_sec: Number(frameInterval) || 1,
        assignments_per_task: Number(assignmentsPerTask) || 2,
        agreement_threshold: Number(agreementThreshold) || 0.75,
        iou_threshold: Number(iouThreshold) || 0.5,
        participant_rules: {
          specialization,
          group: groupRule,
          assignment_scope: assignmentScope,
          stage_pools: {},
          ai_prelabel_enabled: aiEnabled,
          ai_model: aiModel.trim() || "baseline-box-v1",
          ai_confidence_threshold: Number(aiConfidenceThreshold) || 0.7,
          video_keyframe_interval: Number(videoKeyframeInterval) || 1,
          tracking_algorithm: trackingAlgorithm,
          task_batch_size: Number(taskBatchSize) || 10,
          min_sequence_size: Number(minSequenceSize) || 3,
          golden_candidate_threshold: 0.9,
          golden_promotion_target: 10,
          interval_review_padding_sec: 3,
          stuck_assignment_ttl_minutes: 30,
        },
        label_schema: labels,
        allowed_annotator_ids: selectedAnnotators,
        allowed_reviewer_ids: [],
      });
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["project-overview", projectId] });
    },
    onError: (err: any) => {
      setError(err?.response?.data?.detail || err?.response?.data?.error || err?.message || "Failed to save workflow settings");
    },
  });

  const importParticipantsMutation = useMutation({
    mutationFn: async () => {
      if (!projectId || !participantsCsv) throw new Error("Choose a CSV file first");
      return projectsAPI.importParticipantsCsv(projectId, participantsCsv);
    },
    onSuccess: async (result) => {
      setDistributionResult(
        `CSV import complete: created ${result.created_users}, linked ${result.linked_memberships}, skipped ${result.skipped_rows}.`
      );
      await queryClient.invalidateQueries({ queryKey: ["participants", "annotator"] });
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["project-overview", projectId] });
    },
    onError: (err: any) => {
      setError(err?.response?.data?.detail || err?.message || "CSV import failed");
    },
  });

  const manualDistributeMutation = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error("Project id missing");
      return projectsAPI.manualDistributeAssignments(projectId, selectedAnnotators, 100);
    },
    onSuccess: (result) => {
      setDistributionResult(
        `Manual distribution complete: checked ${result.work_items_considered} items, created ${result.assignments_created} assignments.`
      );
    },
    onError: (err: any) => {
      setError(err?.response?.data?.detail || err?.message || "Manual distribution failed");
    },
  });

  const toggle = (id: string, current: string[], setter: (value: string[]) => void) => {
    setter(current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const addLabel = () => setLabels((current) => [...current, { name: "", color: getDefaultLabelColor(current.length) }]);
  const removeLabel = (index: number) => setLabels((current) => current.filter((_, i) => i !== index));
  const updateLabel = (index: number, patch: Partial<ProjectLabel>) => {
    setLabels((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    saveMutation.mutate();
  };

  if (!canEditProject(user?.role)) {
    return (
      <div className="card p-8 text-center">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Workflow Settings</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Only project owners and admins can edit workflow logic.</p>
        <Link to="/projects" className="btn-primary mt-5 inline-block">
          Back to projects
        </Link>
      </div>
    );
  }

  if (projectQuery.isLoading) return <LoadingSpinner size="lg" />;

  if (!projectQuery.data) {
    return (
      <div className="card p-8 text-center">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Project not found</h1>
        <Link to="/projects" className="btn-primary mt-5 inline-block">
          Back to projects
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Projects / {projectQuery.data.title}</div>
          <h1 className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">Workflow Settings</h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            Configure labeling rules, AI pre-annotation, participant pools, and video processing for the end-to-end CV workflow.
          </p>
        </div>
        <div className="flex gap-3">
          <button type="button" className="btn-secondary" onClick={() => navigate(`/projects/${projectId}`)}>
            Back to project
          </button>
          <button type="button" className="btn-primary" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {hasWorkItems ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          This project already has work items. Updating label rules or QC thresholds affects future imports and can make historical batches inconsistent.
        </div>
      ) : null}

      {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}

      <form onSubmit={onSubmit} className="space-y-6">
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <div className="card space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Annotation type</label>
              <select className="input-field" value={annotationType} onChange={(e) => setAnnotationType(e.target.value as Project["annotation_type"])}>
                <option value="bbox">BBox</option>
              </select>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">This release keeps the workflow focused on bounding boxes.</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Frame interval, sec</label>
                <input type="number" min="0.1" step="0.1" className="input-field" value={frameInterval} onChange={(e) => setFrameInterval(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Annotators per task</label>
                <input type="number" min="1" step="1" className="input-field" value={assignmentsPerTask} onChange={(e) => setAssignmentsPerTask(e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Agreement threshold</label>
                <input type="number" min="0" max="1" step="0.05" className="input-field" value={agreementThreshold} onChange={(e) => setAgreementThreshold(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">IoU threshold</label>
                <input type="number" min="0" max="1" step="0.05" className="input-field" value={iouThreshold} onChange={(e) => setIouThreshold(e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Required specialization</label>
                <input className="input-field" value={specialization} onChange={(e) => setSpecialization(e.target.value)} placeholder="aerial vision" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Required group</label>
                <input className="input-field" value={groupRule} onChange={(e) => setGroupRule(e.target.value)} placeholder="group-42" />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Assignment scope</label>
              <select className="input-field" value={assignmentScope} onChange={(e) => setAssignmentScope(e.target.value as Required<ProjectParticipantRules>["assignment_scope"])}>
                <option value="selected_only">Selected pool only</option>
                <option value="all">All available annotators</option>
                <option value="specialists">Prioritize matching specialization</option>
                <option value="group_only">Only matching group</option>
              </select>
            </div>

            <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium text-gray-900 dark:text-white">AI pre-labeling</div>
                  <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">Seed bounding boxes automatically before annotators open the task.</div>
                </div>
                <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <input type="checkbox" checked={aiEnabled} onChange={(e) => setAiEnabled(e.target.checked)} />
                  Enabled
                </label>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Model name</label>
                  <input className="input-field" value={aiModel} onChange={(e) => setAiModel(e.target.value)} disabled={!aiEnabled} placeholder="baseline-box-v1" />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Confidence threshold</label>
                  <input type="number" min="0" max="1" step="0.05" className="input-field" value={aiConfidenceThreshold} onChange={(e) => setAiConfidenceThreshold(e.target.value)} disabled={!aiEnabled} />
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
              <div className="text-sm font-medium text-gray-900 dark:text-white">Video processing</div>
              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Keyframe interval</label>
                  <input type="number" min="1" step="1" className="input-field" value={videoKeyframeInterval} onChange={(e) => setVideoKeyframeInterval(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Tracking algorithm</label>
                  <select className="input-field" value={trackingAlgorithm} onChange={(e) => setTrackingAlgorithm(e.target.value as (typeof TRACKING_ALGORITHMS)[number])}>
                    {TRACKING_ALGORITHMS.map((algorithm) => (
                      <option key={algorithm} value={algorithm}>
                        {algorithm}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
              <div className="text-sm font-medium text-gray-900 dark:text-white">Task packaging and validation prep</div>
              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Frames per task batch</label>
                  <input type="number" min="1" step="1" className="input-field" value={taskBatchSize} onChange={(e) => setTaskBatchSize(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Min consecutive frames</label>
                  <input type="number" min="1" step="1" className="input-field" value={minSequenceSize} onChange={(e) => setMinSequenceSize(e.target.value)} />
                </div>
              </div>
              <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                Based on the CV workflow document, batches are prepared in ordered frame groups so downstream inter-frame validation can work on neighboring frames.
              </div>
            </div>
          </div>

          <div className="card space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-lg font-semibold text-gray-900 dark:text-white">Label schema</div>
                <div className="mt-1 text-sm text-gray-600 dark:text-gray-400">Define classes, colors, rules, and examples for annotators.</div>
              </div>
              <button type="button" className="btn-secondary" onClick={addLabel}>
                Add label
              </button>
            </div>

            <div className="space-y-3">
              {labels.map((label, index) => (
                <div key={index} className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Name</label>
                      <input className="input-field" value={label.name} onChange={(e) => updateLabel(index, { name: e.target.value })} placeholder="drone" />
                    </div>
                    <button type="button" className="btn-secondary" onClick={() => removeLabel(index)} disabled={labels.length <= 1}>
                      Remove
                    </button>
                  </div>

                  <div className="mt-3">
                    <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Color</label>
                    <input
                      type="color"
                      className="h-10 w-20 rounded border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950"
                      value={label.color || getDefaultLabelColor(index)}
                      onChange={(e) => updateLabel(index, { color: e.target.value })}
                    />
                  </div>

                  <div className="mt-3">
                    <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Description</label>
                    <input
                      className="input-field"
                      value={label.description ?? ""}
                      onChange={(e) => updateLabel(index, { description: e.target.value })}
                      placeholder="What belongs to this class?"
                    />
                  </div>

                  <div className="mt-3">
                    <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Rules</label>
                    <textarea
                      className="input-field min-h-[88px]"
                      value={joinLines(label.rules)}
                      onChange={(e) => updateLabel(index, { rules: splitLines(e.target.value) })}
                      placeholder={"Draw a tight box\nMark all visible objects\nLeave a comment when uncertain"}
                    />
                  </div>

                  <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Good examples</label>
                      <textarea
                        className="input-field min-h-[88px]"
                        value={joinLines(label.examples?.good)}
                        onChange={(e) =>
                          updateLabel(index, {
                            examples: {
                              ...(label.examples ?? {}),
                              good: splitLines(e.target.value),
                            },
                          })
                        }
                        placeholder={"Drone visible in full\nPartially occluded drone still recognizable"}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Bad examples</label>
                      <textarea
                        className="input-field min-h-[88px]"
                        value={joinLines(label.examples?.bad)}
                        onChange={(e) =>
                          updateLabel(index, {
                            examples: {
                              ...(label.examples ?? {}),
                              bad: splitLines(e.target.value),
                            },
                          })
                        }
                        placeholder={"Bird instead of drone\nBox too large and includes background"}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
              <div className="text-xs font-medium text-gray-600 dark:text-gray-400">Palette preview</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {labels.map((label, index) => (
                  <div key={`palette-${index}`} className="flex items-center gap-2 rounded bg-gray-100 px-2 py-1 text-xs dark:bg-gray-900">
                    <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: label.color || getDefaultLabelColor(index) }} />
                    <span>{label.name || `label_${index + 1}`}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="card space-y-5">
          <ParticipantSelector
            title="Annotator pool"
            hint="Only people selected here can be used when assignment scope is set to the selected pool."
            items={annotatorsQuery.data?.items ?? []}
            selected={selectedAnnotators}
            onToggle={(id) => toggle(id, selectedAnnotators, setSelectedAnnotators)}
          />

          <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
            <div className="text-sm font-medium text-gray-700 dark:text-gray-300">Bulk import participants from CSV</div>
            <input type="file" accept=".csv" className="mt-2 block w-full text-sm" onChange={(e) => setParticipantsCsv(e.target.files?.[0] ?? null)} />
            <button
              type="button"
              className="btn-secondary mt-3"
              onClick={() => importParticipantsMutation.mutate()}
              disabled={!participantsCsv || importParticipantsMutation.isPending}
            >
              {importParticipantsMutation.isPending ? "Importing..." : "Import CSV"}
            </button>
          </div>

          <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
            <div className="text-sm font-medium text-gray-700 dark:text-gray-300">Manual assignment distribution</div>
            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">Useful when you want to push pending tasks to a specific subset immediately.</div>
            <button
              type="button"
              className="btn-secondary mt-3"
              onClick={() => manualDistributeMutation.mutate()}
              disabled={selectedAnnotators.length === 0 || manualDistributeMutation.isPending}
            >
              {manualDistributeMutation.isPending ? "Distributing..." : "Distribute pending tasks"}
            </button>
          </div>

          {distributionResult ? <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-xs text-green-700">{distributionResult}</div> : null}
        </div>

        <div className="flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={() => navigate(`/projects/${projectId}`)}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? "Saving..." : "Save workflow settings"}
          </button>
        </div>
      </form>
    </div>
  );
}
