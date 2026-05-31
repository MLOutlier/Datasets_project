export const TASK_TYPE_LABELS: Record<string, string> = {
  video_annotation: "Video intervals",
  video_interval_validation: "Interval validation",
  bbox_annotation: "Bounding boxes",
  bbox_validation: "BBox validation",
  text_annotation: "Text annotation",
  image_annotation: "Image labels",
  classification: "Classification",
  comparison: "Comparison",
};

export const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  open: "Open",
  paused: "Paused",
  closed: "Closed",
  review: "Validation",
  candidate: "Candidate",
  retired: "Retired",
};

export const ROLE_LABELS: Record<string, string> = {
  customer: "Customer",
  annotator: "Annotator",
  admin: "Admin",
};

export function taskTypeLabel(value?: string | null) {
  const key = String(value || "");
  return TASK_TYPE_LABELS[key] || key.replace(/_/g, " ") || "Project";
}

export function statusLabel(value?: string | null) {
  const key = String(value || "");
  return STATUS_LABELS[key] || key.replace(/_/g, " ") || "Unknown";
}

export function roleLabel(value?: string | null) {
  const key = String(value || "");
  return ROLE_LABELS[key] || "User";
}
