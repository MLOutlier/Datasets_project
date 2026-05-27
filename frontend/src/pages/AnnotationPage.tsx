import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AnnotationCanvas from "../components/AnnotationCanvas";
import { annotatorAPI, projectsAPI } from "../services/api";
import { BoundingBox, Role } from "../types";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { useAuthStore } from "../store";

type SiteNavItem = {
  to: string;
  label: string;
  icon: string;
  roles: Role[];
};

const siteNavItems: SiteNavItem[] = [
  {
    to: "/",
    label: "Дашборд",
    icon: "📊",
    roles: ["customer", "annotator", "admin"],
  },
  {
    to: "/projects",
    label: "Проекты",
    icon: "📁",
    roles: ["customer", "admin"],
  },
  {
    to: "/datasets",
    label: "Датасеты",
    icon: "🗂️",
    roles: ["annotator", "admin"],
  },
  { to: "/tasks", label: "Задачи", icon: "✅", roles: ["customer", "admin"] },
  {
    to: "/labeling",
    label: "Разметка",
    icon: "🏷️",
    roles: ["annotator", "admin"],
  },
  {
    to: "/quality",
    label: "Качество",
    icon: "⭐",
    roles: ["customer", "admin"],
  },
  {
    to: "/finance",
    label: "Финансы",
    icon: "💰",
    roles: ["customer", "annotator", "admin"],
  },
  {
    to: "/profile",
    label: "Профиль",
    icon: "👤",
    roles: ["customer", "annotator", "admin"],
  },
];

function clampNumber(
  raw: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export default function AnnotationPage() {
  const { assignmentId } = useParams<{ assignmentId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const [boxes, setBoxes] = useState<BoundingBox[]>([]);
  const [comment, setComment] = useState("");
  const [selectedLabel, setSelectedLabel] = useState("");
  const [selectedBoxIndex, setSelectedBoxIndex] = useState<number | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false); // unsaved changes indicator
  const [isSiteMenuOpen, setIsSiteMenuOpen] = useState(false);
  const [isInfoPanelOpen, setIsInfoPanelOpen] = useState(false);
  const [isCommentOpen, setIsCommentOpen] = useState(false);
  const [isInstructionOpen, setIsInstructionOpen] = useState(false);

  const assignmentQuery = useQuery({
    queryKey: ["annotator-assignment", assignmentId],
    queryFn: () => annotatorAPI.detail(assignmentId!),
    enabled: !!assignmentId,
  });

  const projectQuery = useQuery({
    queryKey: ["project", assignmentQuery.data?.project_id],
    queryFn: () => projectsAPI.get(assignmentQuery.data!.project_id),
    enabled: !!assignmentQuery.data?.project_id,
  });

  useEffect(() => {
    if (!assignmentQuery.data) return;
    const draftBoxes = assignmentQuery.data.draft?.boxes ?? [];
    const initialBoxes = draftBoxes;
    setBoxes(initialBoxes);
    setComment(assignmentQuery.data.comment ?? "");
    setSelectedLabel(
      (assignmentQuery.data.label_schema?.[0]?.name as string | undefined) ??
        "",
    );
    setSelectedBoxIndex(initialBoxes.length > 0 ? 0 : null);
    setIsDirty(false);
  }, [assignmentQuery.data]);

  const labels = useMemo(
    () => assignmentQuery.data?.label_schema ?? [],
    [assignmentQuery.data],
  );
  const allowedLabels = useMemo(
    () => new Set(labels.map((label) => label.name)),
    [labels],
  );
  const selectedBox =
    selectedBoxIndex !== null ? (boxes[selectedBoxIndex] ?? null) : null;

  const submitMutation = useMutation({
    mutationFn: (isFinal: boolean) =>
      annotatorAPI.submit(assignmentId!, {
        label_data: { boxes },
        comment,
        is_final: isFinal,
      }),
    onSuccess: async (result) => {
      setIsDirty(false);
      await queryClient.invalidateQueries({ queryKey: ["annotator-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["annotator-projects"] });
      await queryClient.invalidateQueries({
        queryKey: [
          "annotator-project-detail",
          assignmentQuery.data?.project_id,
        ],
      });
      await queryClient.invalidateQueries({
        queryKey: ["annotator-assignment", assignmentId],
      });
      if (
        result.assignment_status === "submitted" ||
        result.assignment_status === "accepted" ||
        result.evaluation?.state === "requeued"
      ) {
        try {
          const next = await annotatorAPI.nextProjectAssignment(
            assignmentQuery.data!.project_id,
          );
          navigate(`/labeling/assignments/${next.assignment_id}`);
          return;
        } catch {
          navigate(`/labeling/projects/${assignmentQuery.data!.project_id}`);
          return;
        }
      }
    },
  });

  // ============================================================
  // ⌨️ HOTKEYS — save, submit, navigate
  // ============================================================
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      // Ctrl+S — save draft
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        submit(false);
        return;
      }

      // Enter — final submit
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        submit(true);
        return;
      }

      if ((e.key === "i" || e.key === "I") && !e.ctrlKey && !e.metaKey) {
        setIsInfoPanelOpen(true);
        return;
      }

      if ((e.key === "c" || e.key === "C") && !e.ctrlKey && !e.metaKey) {
        setIsCommentOpen(true);
        return;
      }

      // Arrow keys — navigate batch
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        // This is handled by the batch item links — we just let the user click
        // But we can also trigger programmatic navigation if needed
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [boxes, comment, selectedLabel]);

  // ============================================================
  // Listen for custom events from AnnotationCanvas
  // ============================================================
  useEffect(() => {
    const onSelectLabel = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && labels.some((l) => l.name === detail)) {
        setSelectedLabel(detail);
      }
    };
    window.addEventListener("annotation:select-label", onSelectLabel);
    return () =>
      window.removeEventListener("annotation:select-label", onSelectLabel);
  }, [labels]);

  // ============================================================
  // AUTO-SAVE (every 30 seconds)
  // ============================================================
  const autoSaveRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isDirty) return;
    autoSaveRef.current = setInterval(() => {
      submitMutation.mutate(false);
    }, 30000);
    return () => {
      if (autoSaveRef.current) clearInterval(autoSaveRef.current);
    };
  }, [isDirty, boxes, comment]);

  const updateBox = (index: number, patch: Partial<BoundingBox>) => {
    setBoxes((current) =>
      current.map((box, boxIndex) =>
        boxIndex === index ? { ...box, ...patch } : box,
      ),
    );
    setIsDirty(true);
  };

  const removeSelectedBox = () => {
    if (selectedBoxIndex === null) return;
    setBoxes((current) =>
      current.filter((_, index) => index !== selectedBoxIndex),
    );
    setSelectedBoxIndex((current) => {
      if (current === null) return null;
      if (boxes.length <= 1) return null;
      return Math.max(0, current - 1);
    });
    setIsDirty(true);
  };

  const validateBeforeSubmit = (): string | null => {
    if (!assignmentQuery.data) return "Задание не загружено";
    const frameWidth = assignmentQuery.data.frame.width;
    const frameHeight = assignmentQuery.data.frame.height;
    if (boxes.length === 0) return "Добавьте хотя бы одну рамку.";
    for (const [index, box] of boxes.entries()) {
      if (
        !Number.isFinite(box.x) ||
        !Number.isFinite(box.y) ||
        !Number.isFinite(box.width) ||
        !Number.isFinite(box.height)
      ) {
        return `Рамка #${index + 1}: координаты должны быть числами.`;
      }
      if (box.width <= 0 || box.height <= 0)
        return `Рамка #${index + 1}: ширина и высота должны быть больше нуля.`;
      if (
        box.x < 0 ||
        box.y < 0 ||
        box.x + box.width > frameWidth ||
        box.y + box.height > frameHeight
      ) {
        return `Рамка #${index + 1}: выходит за границы изображения.`;
      }
      if (!allowedLabels.has(box.label))
        return `Рамка #${index + 1}: неизвестная метка "${box.label}".`;
    }
    return null;
  };

  const submit = (isFinal: boolean) => {
    const error = validateBeforeSubmit();
    setValidationError(error);
    if (error) return;
    submitMutation.mutate(isFinal);
  };

  if (assignmentQuery.isLoading) return <LoadingSpinner size="lg" />;

  if (!assignmentQuery.data) {
    return (
      <div className="card p-8 text-center">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          Задание не найдено
        </h1>
        <Link to="/labeling" className="btn-primary mt-4 inline-block">
          Назад
        </Link>
      </div>
    );
  }

  const frame = assignmentQuery.data.frame;
  const workflowMeta = assignmentQuery.data.workflow_meta;
  const batch = assignmentQuery.data.task_batch;
  const visibleSiteNavItems = siteNavItems.filter(
    (item) => !user?.role || item.roles.includes(user.role),
  );

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-gray-100 text-gray-900 dark:bg-gray-950 dark:text-white">
      <header className="relative z-[110] flex min-h-[56px] items-center gap-2 border-b border-gray-200 bg-white px-3 shadow-sm dark:border-gray-800 dark:bg-gray-950">
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-md text-gray-700 transition hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
          onClick={() => setIsSiteMenuOpen(true)}
          title="Разделы сайта"
          aria-label="Разделы сайта"
        >
          <span
            className="flex h-4 w-5 flex-col justify-between"
            aria-hidden="true"
          >
            <span className="block h-0.5 rounded bg-current" />
            <span className="block h-0.5 rounded bg-current" />
            <span className="block h-0.5 rounded bg-current" />
          </span>
        </button>

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">
            {assignmentQuery.data.project_title}
          </div>
          <div className="truncate text-xs text-gray-500 dark:text-gray-400">
            Кадр {frame.frame_number} · {frame.width}x{frame.height} ·{" "}
            {boxes.length} рамок
            {isDirty ? " · несохранено" : ""}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md text-gray-700 transition hover:bg-gray-100 disabled:opacity-40 dark:text-gray-200 dark:hover:bg-gray-800"
            onClick={() => setIsInfoPanelOpen(true)}
            title="Информация и настройки (I)"
            aria-label="Информация и настройки"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </button>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md text-gray-700 transition hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("annotation:tool-draw"))
            }
            title="Разметка (D)"
            aria-label="Разметка"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"
              />
            </svg>
          </button>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md text-gray-700 transition hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("annotation:tool-pan"))
            }
            title="Перемещение (P)"
            aria-label="Перемещение"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 12h18m-4-4 4 4-4 4M7 8l-4 4 4 4M12 3v18m-4-4 4 4 4-4M8 7l4-4 4 4"
              />
            </svg>
          </button>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md text-gray-700 transition hover:bg-gray-100 disabled:opacity-40 dark:text-gray-200 dark:hover:bg-gray-800"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("annotation:undo"))
            }
            title="Отменить (Ctrl+Z)"
            aria-label="Отменить"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 7 5 11l4 4M5 11h10a4 4 0 0 1 0 8h-2"
              />
            </svg>
          </button>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md text-gray-700 transition hover:bg-gray-100 disabled:opacity-40 dark:text-gray-200 dark:hover:bg-gray-800"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("annotation:redo"))
            }
            title="Вернуть изменение (Ctrl+Shift+Z)"
            aria-label="Вернуть изменение"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="m15 7 4 4-4 4M19 11H9a4 4 0 0 0 0 8h2"
              />
            </svg>
          </button>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md text-gray-700 transition hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("annotation:zoom-out"))
            }
            title="Уменьшить масштаб"
            aria-label="Уменьшить масштаб"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M20 12H4"
              />
            </svg>
          </button>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md text-gray-700 transition hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("annotation:zoom-in"))
            }
            title="Увеличить масштаб"
            aria-label="Увеличить масштаб"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </button>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md text-gray-700 transition hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("annotation:reset-view"))
            }
            title="Центрировать изображение"
            aria-label="Центрировать изображение"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <circle
                cx="12"
                cy="12"
                r="8"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v5m0 6v5M4 12h5m6 0h5"
              />
            </svg>
          </button>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md text-gray-700 transition hover:bg-gray-100 disabled:opacity-40 dark:text-gray-200 dark:hover:bg-gray-800"
            onClick={removeSelectedBox}
            disabled={selectedBoxIndex === null}
            title="Удалить рамку (Delete)"
            aria-label="Удалить рамку"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
          </button>
          <div className="w-0.5 h-5 bg-gray-200 dark:bg-gray-700 mx-2" />
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md text-gray-700 transition hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
            onClick={() => setIsCommentOpen(true)}
            title="Комментарий (C)"
            aria-label="Комментарий"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
          </button>
          <button
            type="button"
            className="flex h-9 items-center justify-center rounded-md bg-blue-500 px-4 text-sm font-medium text-white shadow-sm transition hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-white dark:bg-blue-600 dark:hover:bg-blue-500 dark:focus:ring-offset-gray-900"
            onClick={() => setIsInstructionOpen(true)}
            title="Инструкция"
            aria-label="Инструкция"
          >
            Инструкция
          </button>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md text-gray-700 transition hover:bg-gray-100 disabled:opacity-40 dark:text-gray-200 dark:hover:bg-gray-800"
            onClick={() => submit(false)}
            disabled={submitMutation.isPending}
            title="Сохранить черновик (Ctrl+S)"
            aria-label="Сохранить черновик"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 3h12l2 2v16H5V3zM8 3v6h8V3M8 21v-7h8v7"
              />
            </svg>
          </button>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md bg-blue-600 text-white transition hover:bg-blue-700 disabled:opacity-40"
            onClick={() => submit(true)}
            disabled={submitMutation.isPending || boxes.length === 0}
            title="Отправить и далее (Enter)"
            aria-label="Отправить и далее"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </button>
        </div>
      </header>

      {isSiteMenuOpen ? (
        <div
          className="fixed inset-0 z-[120] bg-black/30"
          onClick={() => setIsSiteMenuOpen(false)}
        >
          <aside
            className="flex h-full w-72 min-w-[280px] flex-col border-r border-gray-200 bg-white shadow-2xl transition-colors duration-300 dark:border-gray-700 dark:bg-gray-800"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="h-16 border-b border-gray-200 bg-gray-50 px-6 dark:border-gray-700 dark:bg-gray-900">
              <NavLink
                to="/"
                className="flex h-full items-center gap-2"
                onClick={() => setIsSiteMenuOpen(false)}
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-primary">
                  <svg
                    className="h-5 w-5 text-white"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                    />
                  </svg>
                </div>
                <span className="bg-gradient-primary bg-clip-text text-lg font-bold text-transparent">
                  Dataset AI
                </span>
              </NavLink>
            </div>

            <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-6">
              {visibleSiteNavItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={() => setIsSiteMenuOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center rounded-lg px-4 py-3 text-sm font-medium transition-all duration-200 ${
                      isActive
                        ? "bg-primary-100 text-primary-700 dark:bg-primary-900/20 dark:text-primary-300"
                        : "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                    }`
                  }
                >
                  <span className="mr-3 text-lg">{item.icon}</span>
                  <span className="flex-1">{item.label}</span>
                </NavLink>
              ))}
            </nav>

            <div className="border-t border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900">
              {user ? (
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-primary font-semibold text-white shadow-md">
                    {user.username.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">
                      {user.username}
                    </p>
                    <p className="text-xs capitalize text-gray-500 dark:text-gray-400">
                      {user.role}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-center text-xs text-gray-500 dark:text-gray-400">
                  Not authenticated
                </p>
              )}
            </div>
          </aside>
        </div>
      ) : null}

      <main className="min-h-0 flex-1">
        <AnnotationCanvas
          imageUrl={assignmentQuery.data.frame_url}
          value={boxes}
          labels={labels}
          currentLabel={selectedLabel}
          selectedBoxIndex={selectedBoxIndex}
          onSelectedBoxIndexChange={setSelectedBoxIndex}
          onBoxesChange={(newBoxes) => {
            setBoxes(newBoxes);
            setIsDirty(true);
          }}
        />
      </main>

      {validationError ? (
        <div className="absolute bottom-4 left-1/2 z-30 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 shadow-lg">
          {validationError}
        </div>
      ) : null}

      {isInstructionOpen ? (
        <div
          className="fixed inset-0 z-50 bg-black/30"
          onClick={() => setIsInstructionOpen(false)}
        >
          <aside
            className="ml-auto flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-gray-200 bg-white p-4 shadow-2xl dark:border-gray-800 dark:bg-gray-950"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Инструкция по разметке</h2>
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-gray-100 dark:hover:bg-gray-800"
                onClick={() => setIsInstructionOpen(false)}
                title="Закрыть"
              >
                ×
              </button>
            </div>

            <section className="mt-4 space-y-2 text-sm">
              <div className="font-medium">
                {projectQuery.data?.project_title}
              </div>
              <div className="text-gray-500 dark:text-gray-400">
                Задание {assignmentQuery.data?.assignment_id.slice(0, 8)}
              </div>
            </section>

            <section className="mt-5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">Инструкция проекта</h3>
                <span className="text-xs text-gray-500">
                  {projectQuery.data?.instructions_file_name || "инструкция"}
                </span>
              </div>
              <div className="mt-2 whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">
                {projectQuery.data?.instructions ||
                  "Инструкция для проекта пока не добавлена."}
              </div>
            </section>
          </aside>
        </div>
      ) : null}

      {isInfoPanelOpen ? (
        <div
          className="fixed inset-0 z-50 bg-black/30"
          onClick={() => setIsInfoPanelOpen(false)}
        >
          <aside
            className="ml-auto flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-gray-200 bg-white p-4 shadow-2xl dark:border-gray-800 dark:bg-gray-950"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Информация</h2>
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-gray-100 dark:hover:bg-gray-800"
                onClick={() => setIsInfoPanelOpen(false)}
                title="Закрыть"
              >
                ×
              </button>
            </div>

            <section className="mt-4 space-y-2 text-sm">
              <div className="font-medium">
                {assignmentQuery.data.project_title}
              </div>
              <div className="text-gray-500 dark:text-gray-400">
                Задание {assignmentQuery.data.assignment_id.slice(0, 8)}
              </div>
              <div>Кадр {frame.frame_number}</div>
              <div>
                {frame.width}x{frame.height}
              </div>
              <div>Статус: {assignmentQuery.data.status}</div>
              <div>Рамок: {boxes.length}</div>
              {workflowMeta?.task_batch_number ? (
                <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-200">
                  Пакет {workflowMeta.task_batch_number}/
                  {workflowMeta.task_batch_total}, кадр{" "}
                  {workflowMeta.task_batch_index}/{workflowMeta.task_batch_size}
                  , последовательность {workflowMeta.sequence_index}/
                  {workflowMeta.sequence_length}.
                </div>
              ) : null}
            </section>

            <section className="mt-5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">Метки</h3>
                <span className="text-xs text-gray-500">
                  {labels.length} шт.
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {labels.map((label, index) => (
                  <button
                    key={label.name}
                    type="button"
                    onClick={() => setSelectedLabel(label.name)}
                    className={`rounded-md px-3 py-2 text-sm font-medium transition ${selectedLabel === label.name ? "text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200"}`}
                    style={
                      selectedLabel === label.name
                        ? { backgroundColor: label.color || "#2563eb" }
                        : undefined
                    }
                    title={`Метка ${label.name} (${index + 1})`}
                  >
                    {index + 1}. {label.name}
                  </button>
                ))}
              </div>
            </section>

            <section className="mt-5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">Выбранная рамка</h3>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={removeSelectedBox}
                  disabled={selectedBoxIndex === null}
                >
                  Удалить
                </button>
              </div>
              {selectedBox ? (
                <div className="mt-3 space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                      Метка
                    </label>
                    <select
                      className="input-field"
                      value={selectedBox.label}
                      onChange={(event) =>
                        updateBox(selectedBoxIndex!, {
                          label: event.target.value,
                        })
                      }
                    >
                      {labels.map((label) => (
                        <option key={label.name} value={label.name}>
                          {label.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        X
                      </label>
                      <input
                        type="number"
                        className="input-field"
                        value={selectedBox.x}
                        onChange={(event) =>
                          updateBox(selectedBoxIndex!, {
                            x: clampNumber(
                              event.target.value,
                              0,
                              frame.width - selectedBox.width,
                              selectedBox.x,
                            ),
                          })
                        }
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        Y
                      </label>
                      <input
                        type="number"
                        className="input-field"
                        value={selectedBox.y}
                        onChange={(event) =>
                          updateBox(selectedBoxIndex!, {
                            y: clampNumber(
                              event.target.value,
                              0,
                              frame.height - selectedBox.height,
                              selectedBox.y,
                            ),
                          })
                        }
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        Ширина
                      </label>
                      <input
                        type="number"
                        className="input-field"
                        value={selectedBox.width}
                        onChange={(event) =>
                          updateBox(selectedBoxIndex!, {
                            width: clampNumber(
                              event.target.value,
                              1,
                              frame.width - selectedBox.x,
                              selectedBox.width,
                            ),
                          })
                        }
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        Высота
                      </label>
                      <input
                        type="number"
                        className="input-field"
                        value={selectedBox.height}
                        onChange={(event) =>
                          updateBox(selectedBoxIndex!, {
                            height: clampNumber(
                              event.target.value,
                              1,
                              frame.height - selectedBox.y,
                              selectedBox.height,
                            ),
                          })
                        }
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-3 rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  Выберите рамку на изображении.
                </div>
              )}
            </section>

            {batch?.items?.length ? (
              <section className="mt-5">
                <h3 className="text-sm font-semibold">
                  Кадры в пакете {batch.batch_number}/{batch.total_batches}
                </h3>
                <div className="mt-2 grid grid-cols-5 gap-2">
                  {batch.items.map((item, index) => {
                    const isCurrent =
                      item.assignment_id === assignmentQuery.data.assignment_id;
                    const isOpenable = Boolean(item.assignment_id);
                    const tone =
                      item.assignment_status === "accepted"
                        ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                        : item.assignment_status === "submitted"
                          ? "border-amber-300 bg-amber-50 text-amber-700"
                          : item.assignment_status === "draft" ||
                              item.assignment_status === "in_progress"
                            ? "border-blue-300 bg-blue-50 text-blue-700"
                            : "border-gray-300 bg-white text-gray-700 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200";
                    return isOpenable ? (
                      <Link
                        key={item.work_item_id}
                        to={`/labeling/assignments/${item.assignment_id}`}
                        className={`rounded-md border px-2 py-2 text-center text-xs font-medium transition ${tone} ${isCurrent ? "ring-2 ring-indigo-400" : ""}`}
                      >
                        {index + 1}
                      </Link>
                    ) : (
                      <div
                        key={item.work_item_id}
                        className={`rounded-md border px-2 py-2 text-center text-xs font-medium opacity-70 ${tone}`}
                      >
                        {index + 1}
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}
          </aside>
        </div>
      ) : null}

      {isCommentOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setIsCommentOpen(false)}
        >
          <section
            className="w-full max-w-lg rounded-xl bg-white p-4 shadow-2xl dark:bg-gray-950"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Комментарий</h2>
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-gray-100 dark:hover:bg-gray-800"
                onClick={() => setIsCommentOpen(false)}
                title="Закрыть"
              >
                ×
              </button>
            </div>
            <textarea
              className="input-field mt-3 min-h-[160px]"
              value={comment}
              onChange={(event) => {
                setComment(event.target.value);
                setIsDirty(true);
              }}
              placeholder="При необходимости оставьте комментарий по кадру"
            />
            <div className="mt-3 space-y-2">
              {assignmentQuery.data.pre_annotations?.boxes?.length ? (
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-700">
                  Для этого кадра есть AI-подсказки. Проверьте их перед
                  финальной отправкой.
                </div>
              ) : null}
              {assignmentQuery.data.quality_signals?.too_fast ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                  Предыдущая отправка по этому заданию была отмечена как слишком
                  быстрая.
                </div>
              ) : null}
              {workflowMeta?.validation_ready ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
                  Этот кадр находится в последовательности, готовой для
                  дальнейших межкадровых проверок.
                </div>
              ) : null}
              {validationError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                  {validationError}
                </div>
              ) : null}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setIsCommentOpen(false)}
              >
                Готово
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => submit(false)}
                disabled={submitMutation.isPending}
              >
                Сохранить
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
