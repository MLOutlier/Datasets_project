import axios, { AxiosError, AxiosInstance, isAxiosError } from "axios";
import {
  AnnotateRequest,
  AnnotatorProjectDetail,
  AnnotatorProjectsResponse,
  Annotation,
  ApiErrorResponse,
  ApiListResponse,
  AssignmentDetail,
  AssignmentSubmitRequest,
  AssignmentSubmitResponse,
  AuthResponse,
  CreateProjectRequest,
  Dataset,
  GoldenCandidatesResponse,
  GoldenCandidate,
  GoldenSourceFrame,
  InstructionBundle,
  LoginRequest,
  Participant,
  PaymentRequestBody,
  Project,
  ProjectExportArtifactName,
  ProjectExportFormat,
  ProjectExportPayload,
  ProjectFinalizeResponse,
  ProjectImportResponse,
  ProjectSourceOptionsResponse,
  ProjectOverview,
  LeaderboardResponse,
  LeaderboardEntry,
  QualityMetricsItem,
  QualityReviewRequest,
  QualityReviewResponse,
  QueueItem,
  RegisterRequest,
  RatingHistoryItem,
  SecurityEventItem,
  Task,
  TaskRegistryResponse,
  Transaction,
  TransferRequest,
  User,
  ValidationBatchDetail,
  ValidationBatchResolveRequest,
  ValidationBatchResolveResponse,
  ValidationQueueItem,
  UserStats,
  VideoInterval,
} from "../types";


const ACCESS_TOKEN_KEY = "dataset_ai_access_token";
const REFRESH_TOKEN_KEY = "dataset_ai_refresh_token";

export function getAccessToken(): string | null {
  try {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setTokens(accessToken: string, refreshToken?: string | null) {
  try {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    if (refreshToken) {
      localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    } else {
      localStorage.removeItem(REFRESH_TOKEN_KEY);
    }
  } catch {
    // ignore
  }
}

export function clearTokens() {
  try {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    // ignore
  }
}

function normalizeApiBaseUrl(): string {
  return "";
}

const apiBaseUrl = normalizeApiBaseUrl();

export const api: AxiosInstance = axios.create({
  baseURL: apiBaseUrl,
  timeout: 30000,
});

api.interceptors.request.use((config) => {
  console.log('🔵 Axios Request:', config.method?.toUpperCase(), config.url);
  const token = getAccessToken();
  if (token) {
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => {
    console.log('🟢 Axios Response:', response.config.method?.toUpperCase(), response.config.url, response.status);
    return response;
  },
  (error: AxiosError<ApiErrorResponse>) => {
    console.log('🔴 Axios Error:', error.config?.method?.toUpperCase(), error.config?.url, error.response?.status);
    if (!isAxiosError(error)) return Promise.reject(error);
    const { response, config } = error;
    if (!response || !config) return Promise.reject(error);
    const status = response.status;
    if (status === 401) {
      const requestUrl = String(config.url || "");
      const isAuthEndpoint = requestUrl.includes("/api/auth/login/") || requestUrl.includes("/api/auth/register/");
      if (!isAuthEndpoint) {
        clearTokens();
      }
    }
    return Promise.reject(error);
  }
);

function extractDetail(err: unknown): string {
  if (isAxiosError(err)) {
    return err.response?.data?.detail ?? err.message;
  }
  return "Unknown error";
}

// ------------------ Auth API ------------------
export const authAPI = {
  async login(body: LoginRequest): Promise<AuthResponse> {
    const res = await api.post<AuthResponse>("/api/auth/login/", {
      identifier: (body as any).email || (body as any).identifier || "",
      password: (body as any).password,
    }, {
      headers: { "Content-Type": "application/json" },
    });
    return res.data;
  },
  async register(body: RegisterRequest): Promise<AuthResponse> {
    const res = await api.post<AuthResponse>("/api/auth/register/", body, {
      headers: { "Content-Type": "application/json" },
    });
    return res.data;
  },
  async me(): Promise<User> {
    const res = await api.get<User>("/api/users/me/");
    return res.data;
  },
};

export const participantsAPI = {
  async list(params?: "annotator" | "reviewer" | { role?: "annotator" | "reviewer"; search?: string; specialization?: string; group?: string; limit?: number; offset?: number }): Promise<ApiListResponse<Participant>> {
    const query = typeof params === "string" ? { role: params } : params;
    const res = await api.get<ApiListResponse<Participant>>("/api/users/participants/", { params: query });
    return res.data;
  },
};

export const projectsAPI = {
  async create(body: CreateProjectRequest): Promise<Project> {
    const res = await api.post<Project>("/api/projects/", body);
    return res.data;
  },
  async list(params?: { limit?: number; offset?: number; search?: string; status?: string; task_type?: string; annotation_type?: string }): Promise<ApiListResponse<Project>> {
    const res = await api.get<ApiListResponse<Project>>("/api/projects/", { params });
    return res.data;
  },
  async taskRegistry(): Promise<TaskRegistryResponse> {
    const res = await api.get<TaskRegistryResponse>("/api/projects/task-registry/");
    return res.data;
  },
  async sourceOptions(taskType: string): Promise<ProjectSourceOptionsResponse> {
    const res = await api.get<ProjectSourceOptionsResponse>("/api/projects/source-options/", { params: { task_type: taskType } });
    return res.data;
  },
  async get(id: string): Promise<Project> {
    const res = await api.get<Project>(`/api/projects/${id}/`);
    return res.data;
  },
  async update(id: string, body: Partial<CreateProjectRequest>): Promise<Project> {
    const res = await api.patch<Project>(`/api/projects/${id}/`, body);
    return res.data;
  },
  async pause(id: string): Promise<Project> {
    const res = await api.post<Project>(`/api/projects/${id}/pause/`, {});
    return res.data;
  },
  async resume(id: string): Promise<Project> {
    const res = await api.post<Project>(`/api/projects/${id}/resume/`, {});
    return res.data;
  },
  async delete(id: string): Promise<void> {
    await api.delete(`/api/projects/${id}/`);
  },
  async uploadInstructions(projectId: string, file: File): Promise<Pick<Project, "instructions_file_uri" | "instructions_file_name" | "instructions_version" | "instructions_updated_at">> {
    const formData = new FormData();
    formData.append("file", file);
    const res = await api.post(`/api/projects/${projectId}/instructions/upload/`, formData, {
      headers: { "Content-Type": "multipart/form-data" },
    });
    return res.data as any;
  },
  async instructions(projectId: string): Promise<InstructionBundle> {
    const res = await api.get<InstructionBundle>(`/api/projects/${projectId}/instructions/`);
    return res.data;
  },
  async updateInstructions(projectId: string, instructions: string): Promise<InstructionBundle> {
    const res = await api.patch<InstructionBundle>(`/api/projects/${projectId}/instructions/`, { instructions });
    return res.data;
  },
  async createInstructionAsset(projectId: string, body: FormData | { asset_type: string; title?: string; body?: string; url?: string }): Promise<{ bundle: InstructionBundle }> {
    if (body instanceof FormData) {
      const res = await api.post<{ bundle: InstructionBundle }>(`/api/projects/${projectId}/instructions/assets/`, body, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return res.data;
    }
    const res = await api.post<{ bundle: InstructionBundle }>(`/api/projects/${projectId}/instructions/assets/`, body);
    return res.data;
  },
  async createInstructionExample(projectId: string, body: FormData | { example_type: "good" | "bad" | "annotated"; title?: string; body?: string; url?: string; label_data?: Record<string, unknown> }): Promise<{ bundle: InstructionBundle }> {
    if (body instanceof FormData) {
      const res = await api.post<{ bundle: InstructionBundle }>(`/api/projects/${projectId}/instructions/examples/`, body, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return res.data;
    }
    const res = await api.post<{ bundle: InstructionBundle }>(`/api/projects/${projectId}/instructions/examples/`, body);
    return res.data;
  },
  async importParticipantsCsv(projectId: string, file: File): Promise<Blob> {
    const formData = new FormData();
    formData.append("file", file);
    const res = await api.post<Blob>(`/api/projects/${projectId}/participants/import-csv/`, formData, {
      headers: { "Content-Type": "multipart/form-data" },
      responseType: "blob",
    });
    return res.data;
  },
  async manualDistributeAssignments(projectId: string, annotatorIds: string[], maxItems = 50): Promise<{ work_items_considered: number; assignments_created: number }> {
    const res = await api.post<{ work_items_considered: number; assignments_created: number }>(`/api/projects/${projectId}/assignments/manual-distribute/`, {
      annotator_ids: annotatorIds,
      max_items: maxItems,
    });
    return res.data;
  },
  async nextTask(projectId: string): Promise<Task> {
    const res = await api.get<Task>(`/api/projects/${projectId}/tasks/next/`);
    return res.data;
  },
  async genericTasks(projectId: string): Promise<{ summary: Record<string, number>; items: Task[] }> {
    const res = await api.get<{ summary: Record<string, number>; items: Task[] }>(`/api/projects/${projectId}/generic-tasks/`);
    return res.data;
  },
  async createGenericTasks(projectId: string, body: FormData | { items: unknown[] | string }): Promise<{ summary: Record<string, number>; created: number; skipped: number; total: number; dataset_id: string }> {
    if (body instanceof FormData) {
      const res = await api.post<{ summary: Record<string, number>; created: number; skipped: number; total: number; dataset_id: string }>(`/api/projects/${projectId}/generic-tasks/`, body, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return res.data;
    }
    const res = await api.post<{ summary: Record<string, number>; created: number; skipped: number; total: number; dataset_id: string }>(`/api/projects/${projectId}/generic-tasks/`, body);
    return res.data;
  },
  async exportDataset(projectId: string, format: "voc" | "coco" | "yolo" | "tfrecord" = "coco"): Promise<Blob> {
    const res = await api.get(`/api/projects/${projectId}/export/`, {
      params: { format, download: "1" },
      responseType: "blob",
    });
    return res.data as Blob;
  },
};

export const workflowAPI = {
  async upload(projectId: string, file: File, importId?: string | null): Promise<ProjectImportResponse> {
    const formData = new FormData();
    formData.append("file", file);
    if (importId) {
      formData.append("import_id", importId);
    }
    const res = await api.post<ProjectImportResponse>(`/api/projects/${projectId}/imports/`, formData, {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: 10 * 60 * 1000,
    });
    return res.data;
  },
  async finalize(projectId: string, importId: string): Promise<ProjectFinalizeResponse> {
    const res = await api.post<ProjectFinalizeResponse>(`/api/projects/${projectId}/imports/${importId}/finalize/`, {});
    return res.data;
  },
  async overview(projectId: string): Promise<ProjectOverview> {
    const res = await api.get<ProjectOverview>(`/api/projects/${projectId}/overview/`);
    return res.data;
  },
  async sync(projectId: string): Promise<ProjectOverview> {
    const res = await api.post<ProjectOverview>(`/api/projects/${projectId}/workflow/sync/`, {});
    return res.data;
  },
  async export(projectId: string, format: ProjectExportFormat = "both", artifact: ProjectExportArtifactName | string = "validated_dataset"): Promise<ProjectExportPayload> {
    const res = await api.get<ProjectExportPayload>(`/api/cv/projects/${projectId}/export/`, { params: { format, artifact } });
    return res.data;
  },
  async exportArchive(projectId: string, format: ProjectExportFormat = "both", artifact: ProjectExportArtifactName | string = "validated_dataset"): Promise<Blob> {
    const res = await api.get(`/api/cv/projects/${projectId}/export/`, {
      params: { format, artifact, download: "1" },
      responseType: "blob",
    });
    return res.data as Blob;
  },
  async securityEvents(projectId: string): Promise<ApiListResponse<SecurityEventItem>> {
    const res = await api.get<ApiListResponse<SecurityEventItem>>(`/api/projects/${projectId}/security-events/`);
    return res.data;
  },
  async goldenCandidates(projectId: string): Promise<GoldenCandidatesResponse> {
    const res = await api.get<GoldenCandidatesResponse>(`/api/projects/${projectId}/golden-candidates/`);
    return res.data;
  },
  async goldenSourceFrames(projectId: string, params?: { search?: string; limit?: number; offset?: number }): Promise<ApiListResponse<GoldenSourceFrame>> {
    const res = await api.get<ApiListResponse<GoldenSourceFrame>>(`/api/projects/${projectId}/golden-source-frames/`, { params });
    return res.data;
  },
  async createGoldenCandidate(projectId: string, body: {
    frame_id: string;
    case_type: "positive" | "negative";
    usage?: "control" | "instruction_example" | "both";
    expected_decision?: "approve" | "needs_changes";
    issue_type?: string;
    status?: "candidate" | "active";
    review_notes?: string;
    reference_annotation: Record<string, unknown>;
    probe_annotation?: Record<string, unknown>;
  }): Promise<GoldenCandidate> {
    const res = await api.post<GoldenCandidate>(`/api/projects/${projectId}/golden-candidates/`, body);
    return res.data;
  },
  async promoteGoldenCandidate(projectId: string, goldenFrameId: string, reviewNotes?: string): Promise<any> {
    const res = await api.post(`/api/projects/${projectId}/golden-candidates/${goldenFrameId}/promote/`, {
      review_notes: reviewNotes || "",
    });
    return res.data;
  },
  async retireGoldenCandidate(projectId: string, goldenFrameId: string, reviewNotes?: string): Promise<any> {
    const res = await api.post(`/api/projects/${projectId}/golden-candidates/${goldenFrameId}/retire/`, {
      review_notes: reviewNotes || "",
    });
    return res.data;
  },
  async listVideoIntervals(projectId: string, params?: { asset_id?: string; status?: string }): Promise<ApiListResponse<VideoInterval>> {
    const res = await api.get<ApiListResponse<VideoInterval>>(`/api/projects/${projectId}/video-intervals/`, { params });
    return res.data;
  },
  async saveVideoIntervals(
    projectId: string,
    assetId: string,
    intervals: Array<{
      id?: string;
      start_frame: number;
      end_frame: number;
      source?: "auto" | "manual";
      confidence?: number;
      metadata?: Record<string, unknown>;
    }>
  ): Promise<{ created: number; updated: number }> {
    const res = await api.post<{ created: number; updated: number }>(`/api/projects/${projectId}/video-intervals/`, { asset_id: assetId, intervals });
    return res.data;
  },
  async autoDraftVideoIntervals(projectId: string, assetId: string): Promise<{ created: number; updated: number; intervals_total: number }> {
    const res = await api.post<{ created: number; updated: number; intervals_total: number }>(
      `/api/projects/${projectId}/video-intervals/${assetId}/auto-draft/`,
      {}
    );
    return res.data;
  },
  async validateVideoIntervals(
    projectId: string,
    payload: { interval_ids: string[]; decision: "approved" | "rejected"; comment?: string }
  ): Promise<{ updated: number; decision: string }> {
    const res = await api.post<{ updated: number; decision: string }>(`/api/projects/${projectId}/video-intervals/validate/`, payload);
    return res.data;
  },
};

export const annotatorAPI = {
  async queue(): Promise<ApiListResponse<QueueItem>> {
    const res = await api.get<ApiListResponse<QueueItem>>("/api/annotator/queue/");
    return res.data;
  },
  async projects(): Promise<AnnotatorProjectsResponse> {
    const res = await api.get<AnnotatorProjectsResponse>("/api/annotator/projects/");
    return res.data;
  },
  async projectDetail(projectId: string): Promise<AnnotatorProjectDetail> {
    const res = await api.get<AnnotatorProjectDetail>(`/api/annotator/projects/${projectId}/`);
    return res.data;
  },
  async acknowledgeInstructions(projectId: string): Promise<InstructionBundle> {
    const res = await api.post<InstructionBundle>(`/api/annotator/projects/${projectId}/instructions/ack/`, {});
    return res.data;
  },
  async nextProjectAssignment(projectId: string): Promise<{ assignment_id: string; source: string }> {
    const res = await api.get<{ assignment_id: string; source: string }>(`/api/annotator/projects/${projectId}/next-assignment/`);
    return res.data;
  },
  async detail(assignmentId: string): Promise<AssignmentDetail> {
    const res = await api.get<AssignmentDetail>(`/api/annotator/assignments/${assignmentId}/`);
    return res.data;
  },
  async submit(assignmentId: string, body: AssignmentSubmitRequest): Promise<AssignmentSubmitResponse> {
    const res = await api.post<AssignmentSubmitResponse>(`/api/annotator/assignments/${assignmentId}/submit/`, body);
    return res.data;
  },
  async intervalChunkQueue(): Promise<ApiListResponse<any>> {
    const res = await api.get<ApiListResponse<any>>("/api/annotator/interval-chunks/queue/");
    return res.data;
  },
  async submitIntervalChunk(assignmentId: string, body: { intervals: Array<{ start_frame: number; end_frame: number; confidence?: number; label?: string }>; comment?: string }): Promise<any> {
    const res = await api.post(`/api/annotator/interval-chunks/${assignmentId}/submit/`, body);
    return res.data;
  },
  async intervalValidationQueue(): Promise<ApiListResponse<any>> {
    const res = await api.get<ApiListResponse<any>>("/api/annotator/interval-validations/queue/");
    return res.data;
  },
  async submitIntervalValidation(assignmentId: string, body: { decision: "approved" | "rejected"; comment?: string }): Promise<any> {
    const res = await api.post(`/api/annotator/interval-validations/${assignmentId}/submit/`, body);
    return res.data;
  },
  async bboxValidationQueue(): Promise<ApiListResponse<any>> {
    const res = await api.get<ApiListResponse<any>>("/api/annotator/bbox-validations/queue/");
    return res.data;
  },
  async submitBBoxValidation(
    assignmentId: string,
    body: { decisions: Record<string, string>; golden_decisions: Record<string, string> }
  ): Promise<any> {
    const res = await api.post(`/api/annotator/bbox-validations/${assignmentId}/submit/`, body);
    return res.data;
  },
};

export const validationAPI = {
  async queue(): Promise<ApiListResponse<ValidationQueueItem>> {
    const res = await api.get<ApiListResponse<ValidationQueueItem>>("/api/validation/queue/");
    return res.data;
  },
  async batchDetail(projectId: string, taskBatchId: string): Promise<ValidationBatchDetail> {
    const res = await api.get<ValidationBatchDetail>(`/api/validation/projects/${projectId}/batches/${encodeURIComponent(taskBatchId)}/`);
    return res.data;
  },
  async resolveBatch(projectId: string, taskBatchId: string, body: ValidationBatchResolveRequest): Promise<ValidationBatchResolveResponse> {
    const res = await api.post<ValidationBatchResolveResponse>(`/api/validation/projects/${projectId}/batches/${encodeURIComponent(taskBatchId)}/resolve/`, body);
    return res.data;
  },
};

export const datasetsAPI = {
  async list(params?: { limit?: number; offset?: number; status?: string; search?: string }): Promise<ApiListResponse<Dataset>> {
    const res = await api.get<ApiListResponse<Dataset>>("/api/datasets/", { params });
    return res.data;
  },
  async create(body: FormData | Record<string, unknown>): Promise<Dataset> {
    if (body instanceof FormData) {
      const res = await api.post<Dataset>("/api/datasets/", body, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return res.data;
    }
    const res = await api.post<Dataset>("/api/datasets/", body);
    return res.data;
  },
  async detail(id: string): Promise<Dataset> {
    const res = await api.get<Dataset>(`/api/datasets/${id}/`);
    return res.data;
  },
  async update(id: string, body: Record<string, unknown>): Promise<Dataset> {
    const res = await api.patch<Dataset>(`/api/datasets/${id}/`, body);
    return res.data;
  },
  async remove(id: string): Promise<void> {
    await api.delete(`/api/datasets/${id}/`);
  },
  async exportDataset(id: string, format: "voc" | "coco" | "yolo" | "tfrecord" = "coco"): Promise<Blob> {
    const res = await api.get(`/api/datasets/${id}/export/`, {
      params: { format },
      responseType: "blob",
    });
    return res.data as Blob;
  },
};

// ------------------ Tasks API ------------------
export const tasksAPI = {
  async create(body: Record<string, unknown>): Promise<Task> {
    const res = await api.post<Task>("/api/tasks/", body);
    return res.data;
  },
  async list(params?: { limit?: number; offset?: number; status?: string }): Promise<ApiListResponse<Task>> {
    const res = await api.get<ApiListResponse<Task>>("/api/tasks/", { params });
    return res.data;
  },
  async update(id: string, body: Record<string, unknown>): Promise<Task> {
    const res = await api.patch<Task>(`/api/tasks/${id}/`, body);
    return res.data;
  },
  async annotate(id: string, body: AnnotateRequest): Promise<Annotation> {
    const res = await api.patch<Annotation>(`/api/tasks/${id}/annotate/`, body);
    return res.data;
  },
};

// ------------------ Quality API (обновлено) ------------------
export const qualityAPI = {
  async createReview(body: QualityReviewRequest): Promise<{ id: string }> {
    const res = await api.post<{ id: string }>("/api/quality/review/", body);
    return res.data;
  },

  async metrics(datasetId: string, params?: { limit?: number; offset?: number }): Promise<{
    dataset_id: string;
    items: QualityMetricsItem[];
    limit?: number;
    offset?: number;
    total?: number;
  }> {
    const res = await api.get<{
      dataset_id: string;
      items: QualityMetricsItem[];
      limit?: number;
      offset?: number;
      total?: number;
    }>(`/api/quality/metrics/${datasetId}/`, { params });
    return res.data;
  },
};

// ------------------ Rating History API ------------------
export const ratingAPI = {
  async history(params?: { limit?: number; offset?: number }): Promise<ApiListResponse<RatingHistoryItem>> {
    const res = await api.get<ApiListResponse<RatingHistoryItem>>("/api/rating/history/", { params });
    return res.data;
  },

  async annotatorHistory(userId: string, params?: { limit?: number; offset?: number }): Promise<ApiListResponse<RatingHistoryItem>> {
    const res = await api.get<ApiListResponse<RatingHistoryItem>>(`/api/rating/history/${userId}/`, { params });
    return res.data;
  },
};

// ------------------ Finance API ------------------
export const financeAPI = {
  async transactions(params?: { limit?: number; offset?: number; status?: string }): Promise<ApiListResponse<Transaction>> {
    const res = await api.get<ApiListResponse<Transaction>>("/api/finance/transactions/", { params });
    return res.data;
  },
  
  async pay(body: PaymentRequestBody): Promise<Record<string, unknown>> {
    const res = await api.post<Record<string, unknown>>("/api/finance/payments/pay/", body);
    return res.data;
  },
  
  async withdraw(body: PaymentRequestBody): Promise<Record<string, unknown>> {
    const res = await api.post<Record<string, unknown>>("/api/finance/payments/withdraw/", body);
    return res.data;
  },
  
  async transfer(body: TransferRequest): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      amount: body.amount,
      currency: body.currency || "USD",
      description: body.description || "",
    };
    
    if (body.to_username) {
      payload.to_username = body.to_username;
    } else if (body.to_email) {
      payload.to_email = body.to_email;
    } else if (body.to_user_id) {
      payload.to_user_id = body.to_user_id;
    }
    
    const res = await api.post<Record<string, unknown>>("/api/finance/payments/transfer/", payload);
    return res.data;
  },
};


// ------------------ Users API (массовое создание + аватар) ------------------
export const usersAPI = {
  async bulkCreateAnnotators(file: File, groups: string, specialization?: string, experienceLevel?: string): Promise<Blob> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('groups', groups);
    if (specialization) formData.append('specialization', specialization);
    if (experienceLevel) formData.append('experience_level', experienceLevel);
    
    const res = await api.post<Blob>('/api/users/bulk-create-annotators/', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      responseType: 'blob',
    });
    return res.data;
  },

  // ✅ Загрузка аватарки
  async uploadAvatar(file: File): Promise<{ avatar_url: string; message: string }> {
    const formData = new FormData();
    formData.append('file', file);
    
    const res = await api.post<{ avatar_url: string; message: string }>(
      '/api/users/me/avatar/',
      formData,
      {
        headers: { 'Content-Type': 'multipart/form-data' },
      }
    );
    return res.data;
  },

  // ✅ Удаление аватарки
  async deleteAvatar(): Promise<{ message: string }> {
    const res = await api.delete<{ message: string }>('/api/users/me/avatar/delete/');
    return res.data;
  },
};

// ------------------ Stats API ------------------
export const statsAPI = {
  async myStats(): Promise<UserStats> {
    const res = await api.get<UserStats>("/api/users/me/stats/");
    return res.data;
  },
};

// ------------------ Leaderboard API ------------------
export const leaderboardAPI = {
  async getProjectLeaderboard(projectId: string): Promise<LeaderboardResponse> {
    const res = await api.get<LeaderboardResponse>(`/api/projects/${projectId}/leaderboard/`);
    return res.data;
  },
};

// ------------------ Dawid-Skene Quality API ------------------
export const dawidSkeneAPI = {
  async getProjectQuality(projectId: string): Promise<{
    project_id: string;
    annotators: Array<{
      user_id: string;
      username: string;
      accuracy: number;
      f1: number;
      error_rate: number;
      confusion_matrix: Record<string, Record<string, number>>;
      rating: number;
      rating_history: Array<{
        rating_before: number;
        rating_after: number;
        rating_delta: number;
        task_id: string;
        created_at: string;
      }>;
    }>;
  }> {
    const res = await api.get(`/api/quality/project/${projectId}/dawid-skene/`);
    return res.data;
  },
};

export function throwApiError(err: unknown): never {
  throw new Error(extractDetail(err));
}
