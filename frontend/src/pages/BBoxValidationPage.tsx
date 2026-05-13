import { useEffect, useMemo, useState, type WheelEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { annotatorAPI } from "../services/api";

type Decision = "approve" | "needs_changes";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function BoxOverlay({
  item,
  boxes,
  zoom,
  zoomOrigin,
  onWheel,
}: {
  item: any;
  boxes: any[];
  zoom: number;
  zoomOrigin: { x: number; y: number };
  onWheel: (event: WheelEvent<HTMLDivElement>) => void;
}) {
  const width = Math.max(Number(item.width || 1), 1);
  const height = Math.max(Number(item.height || 1), 1);
  const scaledWidth = Math.max(320, Math.round(width * zoom));

  return (
    <div
      className="min-h-[68vh] overflow-auto rounded-lg bg-neutral-950 p-3"
      onWheel={onWheel}
      style={{ overscrollBehavior: "contain" }}
    >
      <div className="flex min-h-[calc(68vh-1.5rem)] min-w-full items-center justify-center">
        <div
          className="relative"
          style={{
            width: zoom <= 1 ? "min(100%, 1440px)" : `${scaledWidth}px`,
            transformOrigin: `${zoomOrigin.x}% ${zoomOrigin.y}%`,
          }}
        >
        <img src={item.frame_url} alt={`Frame ${item.frame_number}`} className="block h-auto w-full select-none rounded bg-black object-contain" draggable={false} />
        {(boxes ?? []).map((box, index) => (
          <div
            key={`${item.question_id || item.frame_id}-${index}`}
            className="absolute border-2 border-emerald-400"
            style={{
              left: `${(Number(box.x || 0) / width) * 100}%`,
              top: `${(Number(box.y || 0) / height) * 100}%`,
              width: `${(Number(box.width || 0) / width) * 100}%`,
              height: `${(Number(box.height || 0) / height) * 100}%`,
              borderColor: box.color || "#34d399",
              boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
            }}
          >
            {box.label ? <span className="absolute -top-6 left-0 rounded bg-black/80 px-2 py-0.5 text-xs text-white">{box.label}</span> : null}
          </div>
        ))}
        </div>
      </div>
    </div>
  );
}

export default function BBoxValidationPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const projectIdFilter = searchParams.get("projectId") || "";
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [zoom, setZoom] = useState(1);
  const [zoomOrigin, setZoomOrigin] = useState({ x: 50, y: 50 });
  const [currentIndex, setCurrentIndex] = useState(0);

  const queueQuery = useQuery({
    queryKey: ["bbox-validation-queue"],
    queryFn: () => annotatorAPI.bboxValidationQueue(),
  });

  const assignments = useMemo(
    () => (queueQuery.data?.items ?? []).filter((item: any) => !projectIdFilter || item.project_id === projectIdFilter),
    [queueQuery.data?.items, projectIdFilter]
  );

  const selectedAssignment = useMemo(
    () => assignments.find((item: any) => item.assignment_id === selectedAssignmentId) ?? assignments[0] ?? null,
    [assignments, selectedAssignmentId]
  );

  const questions = useMemo(() => selectedAssignment?.questions ?? selectedAssignment?.question_details ?? [], [selectedAssignment]);
  const orderedQuestions = useMemo(() => {
    if (!selectedAssignment) return questions;
    const lookup = new Map<string, any>();
    for (const question of questions) {
      lookup.set(String(question.question_id || question.golden_id || question.frame_id || question.id), question);
    }
    const sequence = Array.isArray(selectedAssignment.sequence) ? selectedAssignment.sequence : [];
    const ordered = sequence.map((entry: any) => lookup.get(String(entry.id))).filter(Boolean);
    return ordered.length > 0 ? ordered : questions;
  }, [questions, selectedAssignment]);
  const currentQuestion = orderedQuestions[currentIndex] ?? null;
  const backToProject = projectIdFilter ? `/labeling/projects/${projectIdFilter}` : "/labeling";
  const allAnswered = orderedQuestions.length > 0 && orderedQuestions.every((question: any) => Boolean(decisions[question.question_id]));

  useEffect(() => {
    if (!selectedAssignmentId && selectedAssignment?.assignment_id) {
      setSelectedAssignmentId(selectedAssignment.assignment_id);
      setCurrentIndex(0);
      setZoom(1);
      setZoomOrigin({ x: 50, y: 50 });
      setDecisions({});
    }
  }, [selectedAssignment?.assignment_id, selectedAssignmentId]);

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!selectedAssignment) throw new Error("Validation assignment not selected");
      const realQuestions = orderedQuestions.filter((question: any) => !question.golden_id);
      const goldenQuestions = orderedQuestions.filter((question: any) => question.golden_id);
      const body = {
        decisions: Object.fromEntries(realQuestions.map((question: any) => [question.question_id, decisions[question.question_id] ?? "approve"])),
        golden_decisions: Object.fromEntries(goldenQuestions.map((question: any) => [question.question_id, decisions[question.question_id] ?? "approve"])),
      };
      return annotatorAPI.submitBBoxValidation(selectedAssignment.assignment_id, body);
    },
    onSuccess: async () => {
      setSelectedAssignmentId(null);
      setDecisions({});
      setZoom(1);
      setZoomOrigin({ x: 50, y: 50 });
      setCurrentIndex(0);
      await queryClient.invalidateQueries({ queryKey: ["bbox-validation-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["annotator-projects"] });
    },
  });

  const setDecision = (decision: Decision) => {
    if (!currentQuestion) return;
    setDecisions((prev) => ({ ...prev, [currentQuestion.question_id]: decision }));
    setCurrentIndex((prev) => Math.min(orderedQuestions.length - 1, prev + 1));
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setZoomOrigin({
        x: clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100),
        y: clamp(((event.clientY - rect.top) / rect.height) * 100, 0, 100),
      });
    }
    setZoom((prev) => {
      const step = event.deltaY < 0 ? 0.18 : -0.18;
      const next = prev + step;
      return Number(clamp(Number(next.toFixed(2)), 1, 4).toFixed(2));
    });
  };

  return (
    <div className="min-h-[calc(100vh-6rem)] space-y-4">
      <div className="sticky top-0 z-20 -mx-4 border-b border-gray-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-gray-800 dark:bg-gray-950/95 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Этап 4</div>
            <h1 className="truncate text-xl font-semibold text-gray-900 dark:text-white">Валидация объектов</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-secondary" type="button" onClick={() => setCurrentIndex((prev) => Math.max(0, prev - 1))} disabled={!orderedQuestions.length || currentIndex <= 0}>
              Назад
            </button>
            <button className="btn-secondary" type="button" onClick={() => setCurrentIndex((prev) => Math.min(orderedQuestions.length - 1, prev + 1))} disabled={!orderedQuestions.length || currentIndex >= orderedQuestions.length - 1}>
              Далее
            </button>
            <button className="btn-secondary" type="button" onClick={() => setZoom((prev) => clamp(Number((prev - 0.2).toFixed(2)), 1, 4))}>
              -
            </button>
            <button className="btn-secondary" type="button" onClick={() => setZoom(1)}>
              {Math.round(zoom * 100)}%
            </button>
            <button className="btn-secondary" type="button" onClick={() => setZoom((prev) => clamp(Number((prev + 0.2).toFixed(2)), 1, 4))}>
              +
            </button>
            <Link className="btn-secondary" to={backToProject}>
              К проекту
            </Link>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(220px,320px),minmax(0,1fr)]">
        <aside className="space-y-2 xl:max-h-[calc(100vh-12rem)] xl:overflow-auto">
          <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950">
            <div className="text-sm font-medium text-gray-900 dark:text-white">Пакеты валидации</div>
            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{assignments.length} задач</div>
          </div>
          {assignments.map((item: any) => (
            <button
              key={item.assignment_id}
              className={`w-full rounded-lg border p-3 text-left text-sm transition ${
                selectedAssignment?.assignment_id === item.assignment_id
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-950"
                  : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-800 dark:bg-gray-950"
              }`}
              onClick={() => {
                setSelectedAssignmentId(item.assignment_id);
                setCurrentIndex(0);
                setZoom(1);
                setZoomOrigin({ x: 50, y: 50 });
                setDecisions({});
              }}
            >
              <div className="truncate font-medium text-gray-900 dark:text-white">{item.project_title}</div>
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">Кадров: {item.total}</div>
            </button>
          ))}
          {assignments.length === 0 ? <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-700">Нет задач bbox-валидации.</div> : null}
        </aside>

        <main className="space-y-4">
          {selectedAssignment && currentQuestion ? (
            <>
              <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Кадр {currentQuestion.frame_number} · {currentIndex + 1}/{orderedQuestions.length}
                    </div>
                    <div className="mt-1 text-sm font-medium text-gray-900 dark:text-white">
                      {currentQuestion.width}x{currentQuestion.height}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button className={decisions[currentQuestion.question_id] === "approve" ? "btn-primary" : "btn-secondary"} type="button" onClick={() => setDecision("approve")}>
                      Принять
                    </button>
                    <button className={decisions[currentQuestion.question_id] === "needs_changes" ? "btn-primary" : "btn-secondary"} type="button" onClick={() => setDecision("needs_changes")}>
                      Отклонить
                    </button>
                  </div>
                </div>
              </div>

              <BoxOverlay
                item={currentQuestion}
                boxes={currentQuestion.candidate_annotation?.boxes ?? currentQuestion.final_annotation?.boxes ?? []}
                zoom={zoom}
                zoomOrigin={zoomOrigin}
                onWheel={onWheel}
              />

              <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950">
                <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-gray-600 dark:text-gray-400">
                  <span>Отмечено: {Object.keys(decisions).length}/{orderedQuestions.length}</span>
                  <button className="btn-primary" onClick={() => submitMutation.mutate()} disabled={submitMutation.isPending || !allAnswered}>
                    {submitMutation.isPending ? "Отправка..." : "Отправить валидацию"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-gray-700">Выберите пакет bbox-валидации.</div>
          )}
        </main>
      </div>
    </div>
  );
}
