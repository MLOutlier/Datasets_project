export type Role = "customer" | "annotator" | "admin";

export interface User {
  id: string;
  email: string;
  username: string;
  role: Role;
  rating?: number;
  balance?: string;
  specialization?: string;
  group_name?: string;
  groups?: string[];
  experience_level?: string;
  avatar_url?: string | null;  // ✅ Аватар (data URL)
}

export type DatasetStatus = "draft" | "active" | "archived";

export interface Dataset {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  status: DatasetStatus;
  file_uri?: string | null;
  schema_version: number;
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export type TaskStatus = "pending" | "in_progress" | "review" | "completed" | "rejected";

export interface Task {
  id: string;
  title?: string;
  project_id?: string | null;
  dataset_id: string;
  annotator_id?: string | null;
  status: TaskStatus;
  difficulty_score: number;
  deadline_at?: string | null;
  input_ref?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export type AnnotationStatus = "draft" | "submitted" | "pending_review" | "accepted" | "rejected";
export type AnnotationFormat = "classification_v1" | "ner_v1" | "generic_v1";

export interface Annotation {
  id: string;
  task_id: string;
  dataset_id: string;
  session_id?: string | null;
  annotation_format: AnnotationFormat | string;
  label_data: Record<string, unknown>;
  predicted_data?: Record<string, unknown> | null;
  status: AnnotationStatus | string;
  is_final: boolean;
  created_at?: string;
  updated_at?: string;
}

// ✅ ИСПРАВЛЕНО: добавлен "transfer"
export type TransactionType = "payment" | "payout" | "earnings" | "transfer";
export type TransactionStatus = "pending" | "completed" | "failed" | "reversed";

export interface Transaction {
  id: string;
  type: TransactionType;
  status: TransactionStatus;
  user_id: string;
  from_user_id?: string | null;
  to_user_id?: string | null;
  from_user_name?: string | null;
  to_user_name?: string | null;
  description?: string;
  task_id?: string | null;
  amount: string;
  currency: string;
  external_id?: string | null;
  metadata: Record<string, unknown>;
  created_at?: string;
}

// ✅ ИСПРАВЛЕНО: добавлены поля для перевода по username/email
export interface TransferRequest {
  to_user_id?: string;
  to_username?: string;
  to_email?: string;
  amount: string | number;
  currency?: string;
  description?: string;
}

export interface ApiErrorResponse {
  detail?: string;
  [key: string]: unknown;
}

export interface ApiListResponse<T> {
  items: T[];
  limit?: number;
  offset?: number;
  total?: number;
}

// ------------------ Auth ------------------
export interface LoginRequest {
  email?: string;
  username?: string;
  identifier: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  username: string;
  password: string;
  role?: Role;
}

export interface AuthResponse {
  access: string;
  refresh?: string;
  user?: User;
  user_id?: string;
  email?: string;
  username?: string;
  role?: string;
  ok?: boolean;
}

// ------------------ Dataset ------------------
export interface DatasetCreateRequest {
  name: string;
  description?: string;
  status?: DatasetStatus;
  file_uri?: string | null;
  schema_version?: number;
  metadata?: Record<string, unknown>;
}

export interface DatasetUpdateRequest extends Partial<DatasetCreateRequest> {}

// ------------------ Task / Labeling ------------------
export interface TaskFilters {
  status?: TaskStatus;
  limit?: number;
  offset?: number;
}

export interface TaskCreateRequest {
  project_id?: string | null;
  dataset_id: string;
  annotator_id?: string | null;
  status?: TaskStatus;
  difficulty_score?: number;
  deadline_at?: string | null;
  input_ref?: string | null;
}

export interface TaskUpdateRequest extends Partial<TaskCreateRequest> {
  status?: TaskStatus;
}

export type ProjectStatus = "open" | "active" | "paused" | "closed";
export type ProjectType = "standard" | "cv";
export type AnnotationType = "generic" | "bbox";
export type ProjectTaskType =
  | "video_annotation"
  | "video_interval_validation"
  | "bbox_annotation"
  | "bbox_validation"
  | "text_annotation"
  | "image_annotation"
  | "classification"
  | "comparison";
export type ProjectWidgetType =
  | "video_intervals"
  | "interval_validation"
  | "bbox"
  | "bbox_validation"
  | "text"
  | "image_labels"
  | "classification"
  | "comparison";

export interface TaskTypeSpec {
  value: ProjectTaskType;
  title: string;
  description: string;
  default_widget: ProjectWidgetType;
  widgets: ProjectWidgetType[];
  annotation_type: AnnotationType;
  requires_source_project: boolean;
  uses_cv_workflow: boolean;
  input_modes: string[];
  export_formats: string[];
  executor_route: string;
  data_source?: string;
  materializer?: string;
  quality_strategy?: string;
  readiness_gates?: string[];
  source_task_types?: ProjectTaskType[];
  result_schema?: Record<string, unknown>;
  ui_hints: Record<string, unknown>;
  widget_config?: {
    widget_type: ProjectWidgetType;
    input_schema: Record<string, unknown>;
    output_schema: Record<string, unknown>;
    validation_rules: Record<string, unknown>;
    ui_hints: Record<string, unknown>;
  };
}

export interface TaskRegistryResponse {
  version: number;
  default_task_type: ProjectTaskType;
  default_widget_type: ProjectWidgetType;
  task_types: TaskTypeSpec[];
  widgets: Array<{ value: ProjectWidgetType; title: string }>;
}

export interface ProjectSourceOption {
  id: string;
  title: string;
  task_type: ProjectTaskType | string;
  status: string;
  ready: boolean;
  ready_count: number;
  details: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface ProjectSourceOptionsResponse {
  items: ProjectSourceOption[];
  task_type: ProjectTaskType | string;
  source_task_types: string[];
}

export interface ProjectLabel {
  name: string;
  color?: string;
  description?: string;
  rules?: string[];
  examples?: {
    good?: string[];
    bad?: string[];
  };
  attributes?: Record<string, boolean | string | number | null | undefined>;
}

export interface ProjectParticipantRules {
  specialization?: string;
  group?: string;
  assignment_scope?: "all" | "specialists" | "group_only" | "selected_only";
  quality_level?: "standard" | "high_accuracy" | "fast";
  validation_input_mode?: "source_project" | "upload";
  stage_pools?: Record<string, string[]>;
  ai_prelabel_enabled?: boolean;
  ai_model?: string;
  ai_confidence_threshold?: number;
  video_keyframe_interval?: number;
  tracking_algorithm?: string;
  quality_strategy?: string;
  task_batch_size?: number;
  min_sequence_size?: number;
  interval_annotators_per_chunk?: number;
  interval_validators_per_item?: number;
  bbox_validators_per_batch?: number;
  bbox_real_items_per_batch?: number;
  bbox_golden_items_per_batch?: number;
  golden_min_score?: number;
  golden_candidate_threshold?: number;
  golden_promotion_target?: number;
  annotation_golden_interval?: number;
  interval_review_padding_sec?: number;
  stuck_assignment_ttl_minutes?: number;
  quality_presets?: Record<string, Record<string, unknown>>;
}

export interface VideoInterval {
  id: string;
  asset_id: string;
  status: "draft" | "approved" | "rejected" | string;
  source: "auto" | "manual" | string;
  confidence: number;
  start_frame: number;
  end_frame: number;
  start_sec: number;
  end_sec: number;
  metadata?: Record<string, unknown>;
  validated_at?: string | null;
}

export interface GoldenCandidate {
  golden_frame_id: string;
  frame_id: string;
  frame_url: string;
  frame_number: number;
  timestamp_sec: number;
  width: number;
  height: number;
  candidate_score: number;
  candidate_source: string;
  case_type?: "positive" | "negative" | string;
  usage?: "control" | "instruction_example" | "both" | string;
  expected_decision?: "approve" | "needs_changes" | string;
  issue_type?: string;
  asset_id?: string;
  diversity_bucket?: string;
  auto_candidate_reason?: string;
  status?: "candidate" | "active" | "retired" | string;
  is_active: boolean;
  is_candidate: boolean;
  promoted_at?: string | null;
  review_notes?: string;
  reference_annotation: Record<string, unknown>;
  probe_annotation?: Record<string, unknown>;
  stats?: {
    annotation_seen: number;
    annotation_passed: number;
    annotation_failed: number;
    annotation_pass_rate: number;
    validation_seen: number;
    validation_passed: number;
    validation_failed: number;
    validation_pass_rate: number;
  };
}

export interface GoldenCandidatesResponse extends ApiListResponse<GoldenCandidate> {
  active_count: number;
  candidate_count: number;
  retired_count?: number;
}

export interface GoldenSourceFrame {
  frame_id: string;
  frame_url: string;
  frame_number: number;
  timestamp_sec: number;
  width: number;
  height: number;
  asset_id?: string;
  golden_frame_id?: string;
  golden_status: "none" | "candidate" | "active" | "retired" | string;
  case_type?: string;
  issue_type?: string;
  reference_annotation?: Record<string, unknown>;
  candidate_score?: number;
}

export interface InstructionAsset {
  id: string;
  asset_type: "instruction" | "link" | "embedded" | "good_example" | "bad_example" | "annotated_example" | string;
  title: string;
  body: string;
  url: string;
  file_uri: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  label_data: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_by_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface InstructionBundle {
  project_id: string;
  instructions: string;
  instructions_version: number;
  instructions_updated_at?: string | null;
  assets: InstructionAsset[];
  acknowledgement: {
    acknowledged: boolean;
    instructions_version?: number | null;
    acknowledged_at?: string | null;
  };
}

export interface Project {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  status: ProjectStatus;
  project_type: ProjectType;
  annotation_type: AnnotationType;
  task_type: ProjectTaskType;
  widget_type: ProjectWidgetType;
  source_project_id?: string | null;
  source_project_title?: string;
  source_config?: Record<string, unknown>;
  instructions: string;
  instructions_file_uri?: string;
  instructions_file_name?: string;
  instructions_version?: number;
  instructions_updated_at?: string | null;
  instructions_bundle?: InstructionBundle;
  label_schema: ProjectLabel[];
  participant_rules: ProjectParticipantRules;
  allowed_annotator_ids: string[];
  allowed_reviewer_ids: string[];
  allowed_annotator_count?: number;
  allowed_reviewer_count?: number;
  available_executor_count?: number;
  frame_interval_sec: number;
  assignments_per_task: number;
  agreement_threshold: number;
  iou_threshold: number;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectRequest {
  title: string;
  description?: string;
  status?: ProjectStatus;
  project_type?: ProjectType;
  annotation_type?: AnnotationType;
  task_type?: ProjectTaskType;
  widget_type?: ProjectWidgetType;
  source_project_id?: string | null;
  source_config?: Record<string, unknown>;
  instructions?: string;
  label_schema?: ProjectLabel[];
  participant_rules?: ProjectParticipantRules;
  allowed_annotator_ids?: string[];
  allowed_reviewer_ids?: string[];
  frame_interval_sec?: number;
  assignments_per_task?: number;
  agreement_threshold?: number;
  iou_threshold?: number;
}

export interface Participant extends User {}

export interface ProjectImportResponse {
  import_id: string;
  asset_id: string;
  asset_status: string;
  error_message?: string;
  preview: {
    assets_total: number;
    assets_processed: number;
    assets_failed: number;
    frames_total: number;
    errors: string[];
    sample_frames: string[];
    cleanup?: {
      duplicates_removed?: number;
      invalid_frames_removed?: number;
      duplicate_assets?: string[];
    };
    ffmpeg?: {
      available: boolean;
      message: string;
    };
    validation_annotations?: {
      items_total: number;
      boxes_total: number;
      intervals_total: number;
      errors: string[];
    };
  };
}

export interface ProjectFinalizeResponse {
  import_id: string;
  status: string;
  summary: Record<string, unknown>;
  overview: ProjectOverview;
}

export interface ProjectOverview {
  project_id: string;
  project: {
    title: string;
    status: string;
    project_type: string;
    annotation_type: string;
    task_type?: string;
    widget_type?: string;
    source_project_id?: string | null;
    source_project_title?: string;
  };
  task_contract?: TaskTypeSpec | Record<string, unknown>;
  readiness_gates?: Array<{
    key: string;
    label: string;
    ready: boolean;
  }>;
  next_action?: {
    key: string;
    label: string;
    route?: string;
    severity?: "success" | "info" | "warning" | string;
  };
  imports: Record<string, unknown>;
  source_sync?: {
    required: boolean;
    status: "not_required" | "not_synced" | "synced" | "failed" | string;
    created: number;
    skipped: number;
    errors: string[];
    details: Record<string, unknown>;
    synced_at?: string;
    source_project_id?: string | null;
    source_project_title?: string;
  };
  work_items: Record<string, unknown>;
  export?: {
    ready_items?: number;
    blocked_items?: number;
    readiness_rate?: number;
    pending_validation_items?: number;
    disputed_items?: number;
    insufficient_items?: number;
    artifacts?: ProjectExportArtifact[];
    [key: string]: unknown;
  };
  assignments: Record<string, unknown>;
  reviews: Record<string, unknown>;
  sync?: {
    recovered_assignments: number;
    interval_annotation_created: number;
    bbox_annotation_created: number;
    evaluated_items: number;
    accepted_items: number;
    requeued_or_blocked_items: number;
    interval_validation_created: number;
    bbox_validation_created: number;
  };
  annotators: Array<{
    user_id: string;
    username: string;
    rating: number;
    open_assignments: number;
    submitted_assignments: number;
    conflict_rate: number;
  }>;
}

export interface SecurityEventItem {
  id: string;
  event_type: string;
  severity: string;
  created_at: string;
  actor_id?: string | null;
  payload: Record<string, unknown>;
}

export interface QueueItem {
  assignment_id: string;
  project_id: string;
  project_title: string;
  work_item_id: string;
  frame_url: string;
  status: string;
  instruction: string;
  label_schema: ProjectLabel[];
  created_at: string;
}

export type ProjectExportArtifactName =
  | "raw_annotations"
  | "consensus_annotations"
  | "validated_dataset"
  | "validation_report";

export type ProjectExportFormat = "coco" | "yolo" | "voc" | "tfrecord" | "csv" | "json" | "jsonl" | "both";

export interface ProjectExportArtifact {
  artifact: ProjectExportArtifactName | string;
  title: string;
  ready: boolean;
  items_count: number;
  quality_level: "raw" | "consensus" | "validated" | "validation_report" | string;
  validated: boolean;
  message: string;
  formats: ProjectExportFormat[] | string[];
}

export interface IntervalQueueItem {
  assignment_id: string;
  task_id: string;
  project_id: string;
  project_title: string;
  asset_id: string;
  asset_uri: string;
  start_frame: number;
  end_frame: number;
  duration_sec?: number;
  frame_interval_sec: number;
  status: string;
  label_schema?: ProjectLabel[];
  preview_frame_uris?: string[];
  thumbnail_urls?: string[];
  metadata?: Record<string, unknown>;
}

export interface IntervalValidationQueueItem {
  assignment_id: string;
  interval_id: string;
  project_id: string;
  project_title: string;
  asset_id: string;
  asset_uri: string;
  media_uri?: string;
  media_kind?: "clip" | "source" | "none" | string;
  media_ready?: boolean;
  media_reason?: string;
  clip?: {
    clip_uri?: string;
    uri?: string;
    start_sec?: number;
    duration_sec?: number;
    ready?: boolean;
    reason?: string;
  };
  clip_ready?: boolean;
  clip_reason?: string;
  source_project_id?: string;
  source_interval_id?: string;
  start_frame: number;
  end_frame: number;
  start_sec: number;
  end_sec: number;
  duration_sec?: number;
  frame_interval_sec: number;
  status: string;
}

export interface BBoxValidationQueueItem {
  assignment_id: string;
  project_id: string;
  project_title: string;
  total: number;
  sequence?: Array<{ id: string }>;
  questions?: Array<Record<string, unknown>>;
  question_details?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface AnnotatorProjectSummary {
  stage_project_id?: string;
  parent_project_id?: string;
  project_id: string;
  project_title: string;
  stage?: "interval_annotation" | "interval_validation" | "bbox_annotation" | "bbox_validation" | string;
  task_type?: ProjectTaskType | string;
  widget_type?: ProjectWidgetType | string;
  stage_title?: string;
  linked_project_title?: string;
  route?: string;
  project_status: string;
  instructions: string;
  instructions_file_uri?: string;
  instructions_file_name?: string;
  label_schema: ProjectLabel[];
  available_count: number;
  active_count: number;
  draft_count: number;
  submitted_count: number;
  accepted_count: number;
  rejected_count: number;
  completed_count?: number;
  batch_count?: number;
  validation_ready_count?: number;
  total_assignments: number;
  next_assignment_id?: string | null;
  active_assignment_id?: string | null;
  last_activity_at?: string;
}

export interface AnnotatorProjectsResponse {
  available_projects: AnnotatorProjectSummary[];
  active_projects: AnnotatorProjectSummary[];
  completed_projects: AnnotatorProjectSummary[];
}

export interface AnnotatorProjectDetail {
  project_id: string;
  project_title: string;
  project_status: string;
  task_type?: ProjectTaskType | string;
  widget_type?: ProjectWidgetType | string;
  source_project_id?: string | null;
  source_project_title?: string;
  description: string;
  instructions: string;
  instructions_file_uri?: string;
  instructions_file_name?: string;
  instructions_version?: number;
  instructions_updated_at?: string | null;
  instructions_bundle?: InstructionBundle;
  label_schema: ProjectLabel[];
  frame_interval_sec: number;
  participant_rules: ProjectParticipantRules;
  stats: {
    available_count: number;
    active_count: number;
    submitted_count: number;
    accepted_count: number;
    rejected_count: number;
    completed_count: number;
    total_assignments: number;
    batch_count: number;
    validation_ready_count: number;
    validation_pending_count?: number;
    validation_approved_count?: number;
    validation_needs_changes_count?: number;
    interval_chunk_count?: number;
    interval_validation_count?: number;
    bbox_validation_count?: number;
    interval_agreement?: number;
    bbox_annotation_agreement?: number;
    bbox_validation_agreement?: number;
  };
  workflow?: {
    workflow_batches_total?: number;
    validation_ready_items?: number;
    [key: string]: unknown;
  };
  next_assignment_id?: string | null;
  active_assignment_id?: string | null;
}

export interface AssignmentWorkflowMeta {
  task_batch_id?: string;
  task_batch_number?: number;
  task_batch_size?: number;
  task_batch_target_size?: number;
  task_batch_total?: number;
  task_batch_index?: number;
  sequence_id?: string;
  sequence_index?: number;
  sequence_length?: number;
  min_sequence_size?: number;
  validation_ready?: boolean;
  asset_id?: string;
}

export interface AssignmentDetail {
  assignment_id: string;
  project_id: string;
  project_title: string;
  work_item_id: string;
  frame_url: string;
  frame: {
    frame_number: number;
    timestamp_sec: number;
    width: number;
    height: number;
  };
  status: string;
  queue_position?: number;
  instructions: string;
  instructions_bundle?: InstructionBundle;
  label_schema: ProjectLabel[];
  workflow_meta?: AssignmentWorkflowMeta;
  task_batch?: {
    task_batch_id: string;
    batch_number: number;
    total_batches: number;
    current_index: number;
    total: number;
    items: Array<{
      work_item_id: string;
      frame_id: string;
      frame_url: string;
      frame_number: number;
      timestamp_sec: number;
      width: number;
      height: number;
      status: string;
      assignment_id?: string | null;
      assignment_status?: string | null;
      queue_position?: number | null;
      workflow_meta?: AssignmentWorkflowMeta;
      agreement_score?: number;
      final_annotation?: { boxes: BoundingBox[] };
      final_box_count?: number;
      video_qc?: Record<string, unknown>;
      validation_status?: string;
      validation_comment?: string;
    }>;
  };
  draft: { boxes: BoundingBox[] };
  pre_annotations?: { boxes?: BoundingBox[]; [key: string]: unknown };
  comment: string;
  quality_signals: Record<string, unknown>;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

export interface AssignmentSubmitRequest {
  label_data: { boxes: BoundingBox[] };
  comment?: string;
  is_final?: boolean;
}

export interface AssignmentSubmitResponse {
  annotation_id: string;
  assignment_status: string;
  annotation_status: string;
  evaluation?: {
    state: "accepted" | "requeued" | "golden_checked" | string;
    metrics: Record<string, unknown>;
    review_id?: string;
    requeued_assignments?: number;
  } | null;
}

export interface ReviewQueueItem {
  review_id: string;
  project_id: string;
  project_title: string;
  work_item_id: string;
  frame_url: string;
  agreement_score: number;
  metrics: Record<string, unknown>;
  golden_total?: number;
  golden_errors?: number;
  golden_score?: number;
  annotations: Array<{
    annotation_id: string;
    annotator_id: string;
    annotator_username: string;
    label_data: { boxes: BoundingBox[] };
    comment: string;
  }>;
}

export interface ReviewDetail extends ReviewQueueItem {
  resolution?: { boxes: BoundingBox[] };
  status: string;
}

export interface ReviewResolveRequest {
  resolution: { boxes: BoundingBox[] };
  comment?: string;
}

export interface ReviewResolveResponse {
  review_id: string;
  work_item_id: string;
  status: string;
}

export interface ProjectExportPayload {
  export_version?: number;
  generated_at?: string;
  project: {
    id: string;
    title: string;
    annotation_type: string;
    task_type?: string;
    widget_type?: string;
    artifact?: string;
    export_format?: string;
  };
  quality_report: Record<string, unknown>;
  manifest?: Array<Record<string, unknown>>;
  coco?: {
    train: {
      images: Array<Record<string, unknown>>;
      annotations: Array<Record<string, unknown>>;
      categories: Array<Record<string, unknown>>;
    };
    val: {
      images: Array<Record<string, unknown>>;
      annotations: Array<Record<string, unknown>>;
      categories: Array<Record<string, unknown>>;
    };
  };
  yolo?: {
    labels: string[];
    data_yaml: Record<string, unknown>;
    records: Array<{
      frame_uri: string;
      image_path: string;
      label_file: string;
      split: string;
      lines: string[];
    }>;
  };
  voc?: {
    records: Array<Record<string, unknown>>;
  };
  json?: Array<Record<string, unknown>>;
  jsonl?: string;
  csv?: Array<Record<string, unknown>>;
}

export interface ValidationQueueItem {
  project_id: string;
  project_title: string;
  task_batch_id: string;
  batch_number: number;
  frames_total: number;
  approved_frames: number;
  needs_changes_frames: number;
  flagged_frames: number;
  average_agreement: number;
  validation_status: "pending" | "needs_changes" | string;
}

export interface ValidationBatchDetail {
  project_id: string;
  project_title: string;
  task_batch_id: string;
  batch_number: number;
  frames_total: number;
  items: Array<{
    work_item_id: string;
    frame_id: string;
    frame_url: string;
    frame_number: number;
    timestamp_sec: number;
    width: number;
    height: number;
    status: string;
    assignment_id?: string | null;
    assignment_status?: string | null;
    queue_position?: number | null;
    workflow_meta?: AssignmentWorkflowMeta;
    agreement_score?: number;
    final_annotation?: { boxes: BoundingBox[] };
    final_box_count?: number;
    video_qc?: Record<string, unknown>;
    validation_status?: string;
    validation_comment?: string;
  }>;
  all_approved: boolean;
}

export interface ValidationBatchResolveRequest {
  items: Array<{
    work_item_id: string;
    decision: "approve" | "needs_changes";
    comment?: string;
  }>;
  batch_comment?: string;
}

export interface ValidationBatchResolveResponse {
  project_id: string;
  task_batch_id: string;
  approved_items: number;
  requeued_items: number;
  status: string;
}

export interface AnnotateRequest {
  label_data: Record<string, unknown>;
  is_final?: boolean;
  status?: string;
  annotation_format?: AnnotationFormat | string;
  auto_label?: boolean;
  input_context?: Record<string, unknown>;
}

// ------------------ Quality (обновлено) ------------------
export interface QualityReviewRequest {
  task_id: string;
  annotation_ids?: string[];              // новый формат: массив ID аннотаций
  annotation_a_id?: string;               // обратная совместимость
  annotation_b_id?: string;               // обратная совместимость
  arbitrator?: string | null;
  arbitration_requested?: boolean;
  arbitration_comment?: string | null;
}

export interface AnnotatorQualityItem {
  accuracy: number;
  f1: number;
  confusion_matrix: Record<string, Record<string, number>>;
  error_rate: number;
}

export interface QualityReviewResponse {
  id: string;
  task_id: string;
  dataset_id: string;
  review_status: string;
  metrics: Record<string, unknown>;
  final_label_data: Record<string, unknown> | null;
  annotator_quality: Record<string, AnnotatorQualityItem>;
  em_iterations: number;
  convergence_achieved: boolean;
}

export interface QualityMetricsItem {
  task_id: string;
  annotator_id?: string;
  precision: number;
  recall: number;
  f1: number;
  confusion_matrix?: Record<string, Record<string, number>>;
  details?: Record<string, unknown>;
  created_at?: string;
}

// ------------------ Rating History ------------------
export interface RatingHistoryItem {
  id: string;
  user_id: string;
  task_id: string;
  f1_score: number;
  difficulty: number;
  accuracy: number;
  task_score: number;
  rating_delta: number;
  rating_before: number;
  rating_after: number;
  iteration_count: number;
  annotation_format: string;
  created_at: string;
}

// ------------------ Finance ------------------
export interface TransactionFilters {
  status?: TransactionStatus;
  limit?: number;
  offset?: number;
}

export interface PaymentRequestBody {
  amount: string | number;
  currency?: string;
  task_id?: string | null;
  description?: string;
  metadata?: Record<string, unknown>;
}

// ------------------ Stats ------------------
export interface UserStats {
  rating: number;
  level: "novice" | "intermediate" | "advanced" | "expert";
  level_label: string;
  level_color: string;
  completed_tasks: number;
  total_annotations: number;
  average_f1: number;
  reviews_count: number;
  balance: string;
  next_level_rating: number;
}

// ------------------ Leaderboard ------------------
export interface LeaderboardEntry {
  position: number;
  user_id: string;
  username: string;
  email: string;
  rating: number;
  completed_tasks: number;
  unique_tasks: number;
  total_annotations: number;
  average_f1: number;
}

export interface LeaderboardResponse {
  leaderboard: LeaderboardEntry[];
  current_user: LeaderboardEntry | null;
  total_participants: number;
}

// ------------------ Notifications ------------------
export interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  data: Record<string, unknown>;
  is_read: boolean;
  created_at: string;
  read_at: string | null;
}

export interface NotificationsResponse extends ApiListResponse<Notification> {
  unread_count: number;
}
