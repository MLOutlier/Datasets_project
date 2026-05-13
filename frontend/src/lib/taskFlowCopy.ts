import type { ProjectTaskType } from "../types";

type TaskFlowCopy = {
  group: "video" | "bbox" | "generic";
  projectTitle: string;
  projectDescription: string;
  annotatorTitle: string;
  annotatorDescription: string;
  annotatorRoute?: (projectId: string) => string;
  importTitle: string;
  importDescription: string;
};

const DEFAULT_COPY: TaskFlowCopy = {
  group: "bbox",
  projectTitle: "BBox-разметка",
  projectDescription: "Здесь управляют импортом, очередями и экспортом для bbox workflow.",
  annotatorTitle: "Открыть очередь",
  annotatorDescription: "Переход к актуальному исполнительскому экрану для этого проекта.",
  annotatorRoute: (projectId) => `/labeling/projects/${projectId}`,
  importTitle: "Импорт медиа",
  importDescription: "Загрузка изображений или видео для дальнейшей разметки.",
};

const TASK_FLOW_COPY: Record<string, TaskFlowCopy> = {
  video_annotation: {
    group: "video",
    projectTitle: "Интервалы видео",
    projectDescription: "Загруженное видео сразу нарезается на интервалы для разметки.",
    annotatorTitle: "Открыть интервалы",
    annotatorDescription: "Переход к экрану выделения интервалов в видео.",
    annotatorRoute: (projectId) => `/labeling/intervals?projectId=${projectId}&stage=intervals`,
    importTitle: "Импорт видео",
    importDescription: "После загрузки видео задания на интервалы становятся доступны автоматически.",
  },
  video_interval_validation: {
    group: "video",
    projectTitle: "Валидация интервалов",
    projectDescription: "Проверка интервалов, полученных из source video-проекта.",
    annotatorTitle: "Открыть валидацию",
    annotatorDescription: "Переход к очереди проверки интервалов.",
    annotatorRoute: (projectId) => `/labeling/intervals?projectId=${projectId}&stage=interval-validation`,
    importTitle: "Источник данных",
    importDescription: "Этот проект получает задания из source-проекта через Sync workflow.",
  },
  bbox_annotation: {
    group: "bbox",
    projectTitle: "BBox-разметка",
    projectDescription: "Импорт изображений или кадров и выдача заданий на разметку объектов.",
    annotatorTitle: "Открыть очередь",
    annotatorDescription: "Переход к очереди bbox-разметки для проекта.",
    annotatorRoute: (projectId) => `/labeling/projects/${projectId}`,
    importTitle: "Импорт изображений",
    importDescription: "После загрузки можно финализировать импорт и создать work items.",
  },
  bbox_validation: {
    group: "bbox",
    projectTitle: "BBox-валидация",
    projectDescription: "Проверка уже размеченных work items из source-проекта.",
    annotatorTitle: "Открыть валидацию",
    annotatorDescription: "Переход к очереди проверки bbox-разметки.",
    annotatorRoute: (projectId) => `/labeling/bbox-validation?projectId=${projectId}`,
    importTitle: "Источник данных",
    importDescription: "Этот проект работает только с очередью из source-проекта.",
  },
  text_annotation: {
    group: "generic",
    projectTitle: "Текстовая разметка",
    projectDescription: "Проект для legacy generic-задач и ручного набора items.",
    annotatorTitle: "Открыть очередь",
    annotatorDescription: "Переход к экрану исполнения generic-задач.",
    annotatorRoute: (projectId) => `/labeling/generic/${projectId}`,
    importTitle: "Настройка generic-задач",
    importDescription: "Создание ручных задач или CSV-импорта для generic workflow.",
  },
  image_annotation: {
    group: "generic",
    projectTitle: "Разметка изображений",
    projectDescription: "Legacy image labeling без bbox-рисования.",
    annotatorTitle: "Открыть очередь",
    annotatorDescription: "Переход к экрану исполнения generic-задач.",
    annotatorRoute: (projectId) => `/labeling/generic/${projectId}`,
    importTitle: "Настройка generic-задач",
    importDescription: "Создание ручных задач или CSV-импорта для generic workflow.",
  },
  classification: {
    group: "generic",
    projectTitle: "Классификация",
    projectDescription: "Выбор одного класса из схемы проекта.",
    annotatorTitle: "Открыть очередь",
    annotatorDescription: "Переход к экрану исполнения generic-задач.",
    annotatorRoute: (projectId) => `/labeling/generic/${projectId}`,
    importTitle: "Настройка generic-задач",
    importDescription: "Создание ручных задач или CSV-импорта для generic workflow.",
  },
  comparison: {
    group: "generic",
    projectTitle: "Сравнение",
    projectDescription: "Выбор между альтернативами A и B.",
    annotatorTitle: "Открыть очередь",
    annotatorDescription: "Переход к экрану исполнения generic-задач.",
    annotatorRoute: (projectId) => `/labeling/generic/${projectId}`,
    importTitle: "Настройка generic-задач",
    importDescription: "Создание ручных задач или CSV-импорта для generic workflow.",
  },
};

export function getTaskFlowCopy(taskType?: string | null): TaskFlowCopy {
  return TASK_FLOW_COPY[String(taskType || "")] || DEFAULT_COPY;
}

export function getTaskGroupLabel(taskType?: string | null): string {
  return getTaskFlowCopy(taskType).group === "video" ? "Видео" : getTaskFlowCopy(taskType).group === "bbox" ? "BBox" : "Общее";
}

export function getTaskLandingTitle(taskType?: string | null): string {
  return getTaskFlowCopy(taskType).projectTitle;
}

export function getTaskLandingDescription(taskType?: string | null): string {
  return getTaskFlowCopy(taskType).projectDescription;
}

export function getTaskAnnotatorRoute(taskType: ProjectTaskType | string | undefined, projectId: string): string | undefined {
  return getTaskFlowCopy(taskType).annotatorRoute?.(projectId);
}
