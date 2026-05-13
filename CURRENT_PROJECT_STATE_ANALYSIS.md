# Текущее состояние проекта по сбору и разметке датасетов

Документ описывает фактическое состояние проекта на основе текущей структуры репозитория, backend/frontend-кода и существующей документации. Основной акцент сделан на workflow сбора и разметки CV-датасетов, распределении задач, контроле качества, формировании итоговой разметки, коэффициентах и метриках.

## 1. Общее назначение проекта

Проект представляет собой веб-платформу для подготовки датасетов под задачи машинного обучения. В текущей реализации сильнее всего проработан сценарий Computer Vision: заказчик создает проект, загружает изображения или видео, система формирует задания, исполнители размечают объекты bounding box'ами, после чего разметка проходит несколько уровней контроля качества и может быть экспортирована в ML-форматах.

В проекте есть две линии функциональности:

1. Современный CV workflow в `backend/apps/cv_annotation`, который содержит основной актуальный пайплайн: импорт, видеоинтервалы, assignments, bbox-разметку, consensus, validation, golden frames и экспорт.
2. Legacy generic workflow в `datasets_core`, `projects`, `labeling`, `quality`, который поддерживает датасеты, обычные задачи, generic/classification/NER-аннотации и отдельную систему quality review через Dawid-Skene / pairwise metrics.

Фактически проект сейчас является гибридом: старые модули сохранены для совместимости, а основная бизнес-логика дипломного сценария по видео и bbox сосредоточена в `cv_annotation`.

## 2. Технологический стек и запуск

Backend:

- Python, Django, Django REST Framework.
- MongoDB через MongoEngine как основное хранилище доменных данных.
- SQLite оставлен для стандартных Django-механизмов.
- Redis используется как cache/session backend и брокер Celery.
- Celery присутствует, но в настройках разработки `CELERY_TASK_ALWAYS_EAGER = True`, поэтому задачи выполняются синхронно.

Frontend:

- React + TypeScript + Vite.
- Axios API client.
- React Query для запросов.
- Zustand для auth/store-состояния.
- Tailwind-подобные utility-классы.

Инфраструктура:

- `docker-compose.yml` поднимает MongoDB, Redis, backend, Celery worker и frontend.
- Backend в compose опубликован на `8001:8000`.
- Frontend в compose опубликован на `3001:5173`.

## 3. Роли пользователей

В `apps/users/models.py` определены роли:

- `customer` - заказчик, создает проекты, задает workflow, загружает данные, экспортирует результат.
- `annotator` - исполнитель, выполняет интервальную разметку, bbox-разметку и bbox-validation.
- `reviewer` - проверяющий; роль есть в модели, но актуальный 4-step workflow переносит значимую часть валидации на исполнителей.
- `admin` - полный доступ.

У пользователя есть рейтинг `rating`, баланс `balance`, специализация `specialization`, группа `group_name` и список групп `groups`. Эти поля используются при отборе исполнителей для задач.

## 4. Основные доменные сущности CV workflow

Актуальные CV-сущности находятся в `backend/apps/cv_annotation/models.py`.

### ImportSession

Сессия импорта данных в проект. Хранит статус, summary, preview и ошибки.

Статусы:

- `draft`
- `ready`
- `finalized`
- `failed`

### ImportAsset

Загруженный файл в рамках импорта: изображение или видео.

Типы:

- `image`
- `video`

Статусы обработки:

- `uploaded`
- `processed`
- `failed`

Для видео хранит `frame_count`, metadata и результат разбиения на кадры.

### FrameItem

Отдельный кадр или изображение, которое дальше становится единицей разметки. Для видео кадры имеют `frame_number`, `timestamp_sec`, ширину и высоту.

### VideoInterval

Интервал видео, где предположительно есть целевой объект.

Статусы:

- `draft`
- `approved`
- `rejected`
- `disputed`
- `insufficient_validators`

Источники:

- `auto`
- `manual`

### VideoChunkTask / VideoChunkAssignment / VideoChunkAnnotation

Механизм этапа выделения интервалов. Видео режется на chunks, исполнителям выдаются assignment'ы по чанкам, а результатом является список интервалов.

### IntervalValidationAssignment

Задание на независимую проверку интервала другим исполнителем. Важное правило: валидатор не может валидировать свой собственный интервал.

### WorkItem

Главная единица bbox-разметки. Обычно соответствует одному кадру.

Хранит:

- статус разметки;
- agreement score;
- итоговую разметку `final_annotation`;
- источник итоговой разметки `final_source`;
- pre-annotations;
- validation status;
- workflow metadata;
- video QC payload.

### Assignment / WorkAnnotation

`Assignment` - назначение конкретного `WorkItem` конкретному аннотатору.

`WorkAnnotation` - результат разметки assignment'а: bbox-данные, комментарий, статус, признак финальности.

### ReviewRecord

Запись спорного случая. Создается при низком agreement или невозможности принять консенсус.

### GoldenFrame

Контрольный кадр с эталонной разметкой. Используется в bbox-validation пакетах как golden question.

### BBoxValidationAssignment

Пакет проверки bbox-разметки. Содержит реальные work items и golden frames.

По умолчанию:

- 20 реальных кадров;
- 10 golden frames;
- 3 валидатора на batch;
- минимальный golden score 0.8.

## 5. Текущий end-to-end workflow

Текущий рабочий процесс описан в `IMPLEMENTED_4STEP_WORKFLOW.md` и реализован в `cv_annotation/services/workflow.py`.

### Шаг 0. Создание и настройка проекта

Заказчик создает CV-проект с `project_type=cv` и `annotation_type=bbox`.

Настраиваются:

- классы объектов `label_schema`;
- цвета классов;
- инструкции;
- список разрешенных аннотаторов;
- `assignments_per_task`;
- `agreement_threshold`;
- `iou_threshold`;
- правила участников `participant_rules`;
- параметры видео;
- параметры golden validation.

Frontend-страница: `frontend/src/pages/ProjectWorkflowPage.tsx`.

### Шаг 1. Загрузка медиа

Заказчик загружает изображения или видео через import API.

Для изображения:

- создается один `FrameItem`;
- определяются размеры изображения.

Для видео:

- кадры извлекаются через `ffmpeg`;
- если обработка падает, asset получает статус `failed`;
- создаются `FrameItem`;
- создаются `VideoChunkTask` для этапа интервальной разметки.

Preview импорта показывает количество ассетов, кадров, ошибки, cleanup-статистику и диагностику `ffmpeg`.

### Шаг 2. Выделение интервалов видео

Видео делится на chunk-задания. Исполнители получают очередь:

- `GET /api/annotator/interval-chunks/queue/`
- `POST /api/annotator/interval-chunks/{assignment_id}/submit/`

Исполнитель отмечает интервалы, где есть объект. Система сохраняет их как `VideoInterval` со статусом `draft`.

Реализация: `submit_interval_chunk_assignment`.

Оценка реализации: процесс реализован прикладно и полезно. Хорошо, что интервалы являются отдельной сущностью и сохраняют автора. Ограничение: автоматическая генерация интервалов пока является простой baseline-эвристикой, а не настоящей моделью поиска объектов.

### Шаг 3. Валидация интервалов

Другие исполнители получают interval-validation задания:

- `GET /api/annotator/interval-validations/queue/`
- `POST /api/annotator/interval-validations/{assignment_id}/submit/`

Правила:

- автор интервала не может быть валидатором;
- по умолчанию требуется 3 валидатора;
- решение агрегируется большинством;
- если голосов недостаточно, интервал остается в `draft`;
- если есть конфликт или agreement ниже порога, система пытается создать дополнительное validation assignment;
- если консенсус не достигнут после лимита reannotation rounds, интервал получает `disputed`;
- если независимых валидаторов нет, статус становится `insufficient_validators`.

При `approved` интервале система может сразу создать `WorkItem` для кадров внутри интервала.

Оценка реализации: логика независимости валидатора и кворума реализована хорошо. Слабое место - нет полноценного арбитражного UI как центрального обязательного этапа; disputed-состояния есть в backend, но workflow в основном executor-driven.

### Шаг 4. Finalize import и генерация work items

При финализации импорта:

- для изображений создаются work items по всем кадрам;
- для видео создаются work items только по кадрам, попавшим в `approved` интервалы;
- кадры группируются в batches;
- каждому work item назначается несколько исполнителей согласно `assignments_per_task`;
- если исполнителей недостаточно, work item блокируется статусом `insufficient_annotators`.

Реализация: `create_work_items_for_import`.

### Шаг 5. BBox-разметка

Аннотатор открывает assigned task:

- видит кадр;
- видит классы;
- видит инструкцию;
- может использовать pre-annotation;
- рисует bbox;
- сохраняет draft или отправляет финальный результат.

Frontend:

- `AnnotationPage.tsx`;
- `AnnotationCanvas.tsx`;
- `AnnotatorProjectPage.tsx`;
- route `/labeling/assignments/:assignmentId`.

Backend:

- `save_assignment_annotation`;
- `evaluate_work_item`.

Оценка реализации: базовый UX для bbox-разметки реализован. Есть autosave, горячие клавиши, undo/redo, копирование рамок. Это хороший уровень для MVP. При этом поддерживается только bbox, а polygon/segmentation/keypoints пока не реализованы.

### Шаг 6. Автоматический consensus и итоговая разметка

Когда по `WorkItem` набирается достаточное число финальных аннотаций, вызывается `evaluate_work_item`.

Система:

1. Загружает все submitted-аннотации.
2. Сравнивает каждую пару через bbox IoU.
3. Строит consensus-кластеры bbox.
4. Принимает только те кластеры, где есть большинство источников и достаточное качество.
5. Если consensus проходит порог, записывает `final_annotation`.
6. Если consensus не проходит, создает `ReviewRecord` и requeue'ит work item новому независимому аннотатору.

Итоговая разметка создается не простым выбором одной аннотации, а через объединение согласованных рамок:

- рамки одного класса кластеризуются по IoU;
- внутри кластера координаты агрегируются медианой;
- рамка принимается, если ее подтвердило большинство аннотаций;
- дополнительно проверяются средний IoU и разброс координат.

Это сильная часть реализации: итоговая разметка получается устойчивее, чем при выборе одного исполнителя.

## 6. Алгоритм распределения задач между участниками

Основная функция: `select_annotators_for_project`.

Система строит пул кандидатов из `ProjectMembership` с ролью `annotator` и `is_active=True`.

Фильтры и настройки:

- `allowed_annotators`;
- `assignment_scope`;
- `specialization`;
- `group`;
- `stage_pools`;
- stage-specific списки вида `bbox_annotation_user_ids`, `interval_validation_user_ids` и т.п.

Поддерживаемые stage:

- `interval_annotation`;
- `interval_validation`;
- `bbox_annotation`;
- `bbox_validation`.

Сортировка кандидатов:

1. Сначала те, кто совпадает по специализации.
2. Затем те, кто совпадает по группе.
3. Затем с меньшей текущей нагрузкой.
4. Затем с большим рейтингом.
5. Затем более ранние пользователи.

Нагрузка считается как количество открытых `Assignment` в статусах:

- `assigned`;
- `in_progress`;
- `draft`.

Для interval chunks отдельно считается нагрузка по `VideoChunkAssignment`.

Оценка реализации:

- Плюсы: учитываются специализация, группа, выбранный пул, текущая нагрузка и рейтинг; есть защита от назначения одного work item одному и тому же исполнителю повторно.
- Минусы: нет настоящей оптимизации расписания, дедлайнов, стоимости, доступности по времени, SLA и уведомлений; рейтинг используется как tie-breaker, а не как часть вероятностной модели доверия.
- Для дипломного MVP алгоритм выглядит достаточно убедительно: он прозрачен, объясним и покрывает главную проблему равномерного распределения.

## 7. Коэффициенты, пороги и параметры workflow

Основные значения заданы в `workflow.py` и могут переопределяться через `project.participant_rules`.

### Пакетирование задач

- `DEFAULT_TASK_BATCH_SIZE = 10`
- `DEFAULT_MIN_SEQUENCE_SIZE = 3`

Work items группируются в batches по 10 кадров. `min_sequence_size=3` отмечает, готов ли batch для межкадровых проверок.

### Интервалы видео

- `DEFAULT_INTERVAL_VALIDATORS_PER_ITEM = 3`
- `DEFAULT_VIDEO_CHUNK_DURATION_SEC = 45`
- `DEFAULT_VIDEO_CHUNK_MIN_DURATION_SEC = 30`
- `DEFAULT_VIDEO_CHUNK_MAX_DURATION_SEC = 60`
- `DEFAULT_INTERVAL_REVIEW_PADDING_SEC = 2.0`

По умолчанию один interval должен быть проверен тремя независимыми валидаторами.

### BBox validation

- `DEFAULT_BBOX_VALIDATORS_PER_BATCH = 3`
- `DEFAULT_BBOX_REAL_ITEMS_PER_BATCH = 20`
- `DEFAULT_BBOX_GOLDEN_ITEMS_PER_BATCH = 10`
- `DEFAULT_GOLDEN_MIN_SCORE = 0.8`

Пакет bbox-validation состоит из 20 реальных кадров и 10 контрольных. Если валидатор набирает golden score ниже 0.8, пакет отклоняется.

### Reannotation и golden candidates

- `DEFAULT_GOLDEN_CANDIDATE_THRESHOLD = 0.9`
- `DEFAULT_GOLDEN_PROMOTION_TARGET = 10`
- `DEFAULT_MAX_REANNOTATION_ROUNDS = 2`
- `DEFAULT_BBOX_COORDINATE_SPREAD_THRESHOLD = 0.25`

Если consensus не достигнут после 2 дополнительных циклов, work item переводится в disputed/blocked состояние. Кадры с хорошим качеством могут становиться кандидатами в golden frames.

### Проектные пороги

В модели `Project`:

- `assignments_per_task`, default `2`;
- `agreement_threshold`, default `0.75`;
- `iou_threshold`, default `0.5`;
- `frame_interval_sec`, default `1.0`.

`iou_threshold=0.5` используется как базовый порог совпадения bbox. `agreement_threshold=0.75` используется при приемке consensus и validation decisions.

## 8. Метрики качества bbox

### IoU

Intersection over Union рассчитывается как:

`intersection_area / union_area`

Если рамки не пересекаются или имеют невалидную геометрию, IoU равен 0.

### Precision / Recall / F1

В `compare_bbox_annotations` и `greedy_iou_matching` используются:

- `TP` - matched bbox с IoU выше порога и тем же label;
- `FP` - лишние bbox;
- `FN` - пропущенные bbox;
- `precision = TP / (TP + FP)`;
- `recall = TP / (TP + FN)`;
- `F1 = 2 * precision * recall / (precision + recall)`.

В `compare_bbox_annotations` дополнительно считается:

- `average_iou`;
- `quality_score = f1 * average_iou`, если есть matches;
- иначе `quality_score = f1`.

### Consensus quality

В `build_consensus_bbox_annotation` рамки объединяются в кластеры:

- только внутри одного label;
- только если IoU с representative выше `project.iou_threshold`;
- representative пересчитывается медианой координат.

Кластер принимается, если:

- `source_count >= floor(total_annotations / 2) + 1`;
- `average_iou >= project.iou_threshold`;
- `coordinate_spread <= bbox_coordinate_spread_threshold`.

Итоговый `consensus_f1` считается в `_consensus_bbox_quality_score`:

- для принятых кластеров берется `coverage * mean_iou`;
- затем применяется штраф за отклоненные кластеры.

Оценка реализации: алгоритм хорошо объясним, устойчив к выбросам за счет медианы и большинства. Это сильнее обычного pairwise F1. Ограничение: greedy clustering зависит от порядка обхода рамок и не решает сложные случаи множественных близких объектов так строго, как Hungarian matching.

## 9. Golden questions и bbox-validation

Golden frames нужны для проверки валидаторов.

Логика:

- валидатор получает пакет из real items и golden items;
- порядок вопросов перемешивается детерминированно через `random.Random(str(assignment.id))`;
- golden decision сравнивается с expected decision;
- если golden score ниже `golden_min_score`, весь validation assignment отклоняется;
- реальные решения при этом не применяются.

Для реальных items:

- собираются голоса `approve` / `needs_changes`;
- требуется до 3 независимых голосов, но фактическое число ограничивается доступными независимыми валидаторами;
- если голосов недостаточно, work item остается pending;
- если большинство за `needs_changes` или agreement ниже порога, work item requeue'ится;
- если большинство за approve, `validation_status = approved`;
- после approve work item может быть зарегистрирован как golden candidate.

Оценка реализации: концепция реализована хорошо и близка к реальному crowdsourcing QC. Слабое место: начальная bootstrap-логика golden frames зависит от наличия качественных финальных кадров, поэтому в новом проекте golden-контроль может быть сначала слабее, чем в зрелом проекте.

## 10. Dawid-Skene и legacy quality review

В `backend/apps/quality/services/dawid_skene.py` реализован EM-алгоритм Dawid-Skene для категориальных меток.

Параметры:

- `CONVERGENCE_THRESHOLD = 0.001`
- `MAX_ITERATIONS = 20`
- `MIN_ITERATIONS = 5`

Алгоритм:

1. Собирает множество меток.
2. Инициализирует confusion matrix каждого аннотатора: 80% на диагонали, 20% на ошибки.
3. E-step оценивает вероятности истинных меток.
4. M-step обновляет confusion matrices.
5. Останавливается при сходимости после минимум 5 итераций или после 20 итераций.
6. Возвращает accuracy, error_rate и confusion_matrix по каждому аннотатору.

Рейтинг в legacy quality обновляется через EWMA:

`new_rating = alpha * task_score + (1 - alpha) * old_rating`

где:

- `alpha = ANNOTATOR_RATING_ALPHA`, default `0.1`;
- `task_score = accuracy * (0.5 + 0.5 * difficulty_score)`.

Оценка реализации:

- Dawid-Skene полезен для classification/generic задач.
- Для bbox он не является главным механизмом; bbox оценивается через IoU/consensus.
- В serializer есть потенциальная недоработка: результат `dawid_skene_em` возвращает `true_labels`, но serializer ожидает `final_label` и `final_confidence`. Поэтому legacy final_label_data может быть неполным.
- Для актуального CV workflow это не критично, потому что основной путь идет через `cv_annotation`.

## 11. Межкадровая проверка и видео QC

В `video_qc.py` реализована простая межкадровая проверка:

- берется текущий `WorkItem`;
- берется предыдущий кадр;
- сравниваются bbox одного label;
- считается лучший IoU;
- если `projected_iou < threshold`, кадр помечается `flag_for_review`.

Также есть функция `interpolate_boxes`, которая линейно интерполирует координаты bbox между start/end boxes при одинаковом label.

Оценка реализации:

- Это полезная базовая проверка стабильности.
- Но это еще не полноценный tracking: алгоритмы CSRT/KCF/MOSSE и другие перечислены в UI как настройки, но фактическая backend-логика tracking-by-algorithm не реализована.
- Интерполяция есть как сервисная функция, но не выглядит полностью встроенной в основной pipeline автоматической генерации промежуточных разметок.

## 12. AI pre-annotation

Предразметка включается через `participant_rules.ai_prelabel_enabled`.

Текущая функция `generate_preannotation_for_frame` создает baseline bbox:

- рамка по центру изображения;
- размер примерно 20% ширины и 20% высоты;
- label `"object"`;
- confidence не ниже 0.7.

Оценка реализации:

- Это уже не пустая заглушка, но еще не AI-модель.
- Для демонстрации UX предразметки достаточно.
- Для реального качества датасета нужно подключить модель детекции или сегментации и сопоставить label с проектной схемой.

## 13. Экспорт итогового датасета

Экспорт реализован в `build_dataset_export` и `build_dataset_export_archive`.

Поддерживаемые форматы:

- COCO;
- YOLO;
- Pascal VOC;
- CSV;
- `both` как комбинированный payload;
- ZIP-архив.

В экспорт попадают только work items, которые:

- имеют `status = completed`;
- имеют `validation_status = approved`;
- имеют валидные bbox в `final_annotation`.

Исключенные элементы попадают в quality report с причиной:

- не завершены;
- не прошли validation;
- нет валидных рамок;
- невалидная геометрия bbox.

Разделение train/val:

- детерминированное через SHA-256 от `project.id:frame.id`;
- примерно 20% уходит в val, если элементов больше одного.

Quality report содержит:

- общее количество work items;
- completed / in_review / rejected_or_flagged;
- validation breakdown;
- completion rate;
- average agreement;
- included/excluded export items;
- train/val split;
- assignment statistics;
- review statistics;
- golden state.

Оценка реализации: экспортная часть хорошая для MVP, потому что есть несколько стандартных форматов и ZIP. Ограничение: в архив добавляются изображения по текущим media paths; если файл недоступен, ошибка тихо пропускается.

## 14. Frontend-состояние

Основные страницы:

- `/projects` - список проектов.
- `/projects/create` - создание проекта.
- `/projects/:projectId` - карточка проекта.
- `/projects/:projectId/workflow` - настройка workflow.
- `/labeling` - список/очередь разметки.
- `/labeling/projects/:projectId` - проект со стороны исполнителя.
- `/labeling/assignments/:assignmentId` - bbox-разметка.
- `/labeling/intervals` - интервальные задачи/валидация.
- `/labeling/bbox-validation` - bbox validation.
- `/quality` - legacy/ручная batch quality страница.
- `/finance` - финансы.

Сильные стороны:

- У исполнителя есть отдельные страницы для проекта, assignment и validation.
- Workflow settings позволяют настроить labels, цвета, инструкции, assignment scope, AI prelabel, thresholds.
- Есть импорт участников из CSV и ручное распределение задач.

Ограничения:

- Интерфейс местами смешивает русский и английский.
- Некоторые настройки показываются в UI, но backend использует их частично.
- Reviewer-ветка присутствует в backend views, но основной актуальный workflow делает validation через annotator queues.

## 15. Финансовый модуль

В `finance` есть:

- `Transaction`;
- `PaymentRequest`;
- типы payment, payout, earnings, transfer;
- статусы pending/completed/failed/reversed;
- баланс пользователя обновляется через Mongo `$inc`.

Оценка реализации: модуль выглядит как MVP/stub. Он пригоден для демонстрации пополнений, выплат и переводов, но не содержит полноценной интеграции с платежной системой, антифрода, бухгалтерских статусов или тарифной модели оплаты за конкретные задания.

## 16. Надежность, безопасность и аудит

Есть `SecurityEvent` для событий:

- import cleanup;
- preannotation;
- review resolve;
- video QC;
- assignment distribution;
- golden candidate;
- export generated.

В настройках:

- JWT проверяется вручную во views;
- DRF permissions стоят `AllowAny`, потому что auth вынесен в кастомную логику;
- CORS в разработке открыт широко;
- bcrypt rounds по умолчанию 4 для разработки;
- максимальный размер upload по умолчанию 500 MB.

Оценка реализации:

- Для локального учебного стенда нормально.
- Для production нужно ужесточать auth/permissions, CORS, secret management, rate limits, права доступа к media, аудит и обработку PII.

## 17. Что реализовано хорошо

- Актуальный CV workflow доведен до связного 4-step процесса.
- Есть разделение между interval annotation и bbox annotation.
- Есть независимая validation-логика, запрещающая проверять собственные ответы.
- Есть configurable workflow parameters.
- Есть consensus-алгоритм, который формирует итоговую разметку медианой по согласованным bbox-кластерам.
- Есть requeue при низком качестве.
- Есть golden questions и threshold 80%.
- Есть экспорт в COCO/YOLO/VOC/CSV и ZIP.
- Есть quality report с причинами исключения кадров.
- Есть интерфейс настройки workflow и интерфейсы исполнителя.

## 18. Что реализовано частично или требует доработки

- AI pre-annotation сейчас baseline, не настоящая ML-модель.
- Автоматическое выделение интервалов видео тоже baseline-эвристика.
- Tracking algorithms указаны в UI, но полноценный трекинг не встроен в pipeline.
- Dawid-Skene относится к legacy quality flow и не является центральным механизмом CV workflow.
- Reviewer/admin arbitration есть как модели и views, но текущая валидация в основном executor-driven.
- Golden frames требуют bootstrap; на старте проекта контрольные вопросы могут отсутствовать или быть слабыми.
- Celery формально есть, но в dev-настройке задачи eager/sync.
- Поддерживается только bbox как основной CV annotation type.
- Production security нужно усиливать.

## 19. Итоговая оценка текущего состояния

Проект находится в хорошем состоянии для демонстрационного MVP/дипломного проекта по сбору и разметке CV-датасетов. Самая ценная часть - не просто CRUD датасетов, а реализованный workflow с распределением заданий, консенсусом, повторной разметкой, golden validation и экспортом результата.

Главная архитектурная особенность - вся сложная логика сконцентрирована в `cv_annotation/services/workflow.py`. Это ускорило разработку, но в будущем файл стоит разнести на отдельные сервисы: assignment distribution, interval workflow, bbox consensus, validation, golden frames, export.

Для защиты проекта можно честно формулировать так: система уже реализует полный путь от загрузки данных до выгрузки валидированного датасета, но некоторые интеллектуальные компоненты пока являются baseline-эвристиками и подготовлены как точки расширения для настоящих моделей компьютерного зрения.

