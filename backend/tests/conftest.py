"""
Фикстуры pytest для тестирования backend.

Содержит:
- Фикстуры для подключения к тестовой MongoDB
- Фикстуры пользователей (customer, annotator, admin)
- Фикстуры датасетов, проектов, задач
- Фикстуры для тестирования аннотаций и качества
- Фикстуры для тестирования финансов

Все фикстуры изолированы - каждый тест получает чистую БД.
"""

import os
import pytest
from datetime import datetime
from decimal import Decimal

import mongoengine
from bson import ObjectId

# Настраиваем окружение для тестов перед импортом Django
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
os.environ.setdefault("PYTEST_CURRENT_TEST", "true")

import django
django.setup()

from apps.users.models import User
from apps.datasets_core.models import Dataset
from apps.projects.models import Project, Task
from apps.labeling.models import Annotation, LabelingSession
from apps.quality.models import QualityMetric, QualityReview
from apps.finance.models import Transaction, PaymentRequest
from apps.cv_annotation.models import (
    BBoxValidationAssignment,
    GoldenAnnotationAssignment,
    GoldenAttempt,
    GoldenFrame,
    ImportSession,
    ImportAsset,
    FrameItem,
    WorkItem,
    Assignment,
    WorkAnnotation,
    ReviewRecord,
)


# =============================================================================
# Безопасные тестовые пароли (из переменных окружения)
# =============================================================================
TEST_PASSWORD = os.getenv("TEST_PASSWORD", "test-password-for-dev-only")
TEST_ADMIN_PASSWORD = os.getenv("TEST_ADMIN_PASSWORD", "test-admin-password-for-dev-only")


# =============================================================================
# Фикстуры для подключения к тестовой базе данных
# =============================================================================

@pytest.fixture(scope="session")
def test_db_settings():
    """
    Настройки для тестовой базы данных.
    Использует отдельную БД чтобы не затрагивать основную.
    """
    return {
        "host": os.getenv("MONGODB_HOST", "localhost"),
        "port": int(os.getenv("MONGODB_PORT", "27017")),
        "db": "dataset_ai_test",  # Отдельная тестовая БД
        "username": os.getenv("MONGODB_USER", ""),
        "password": os.getenv("MONGODB_PASSWORD", ""),
    }


@pytest.fixture(scope="function")
def db(test_db_settings):
    """
    Фикстура для подключения к тестовой MongoDB.
    Очищает БД перед каждым тестом и после него.
    
    Использование:
        def test_something(db):
            # БД очищена и готова к работе
    """
    # Подключаемся к тестовой БД
    try:
        mongoengine.disconnect()
    except Exception:
        pass
    
    mongoengine.connect(
        db=test_db_settings["db"],
        host=test_db_settings["host"],
        port=test_db_settings["port"],
        username=test_db_settings["username"] if test_db_settings["username"] else None,
        password=test_db_settings["password"] if test_db_settings["password"] else None,
        authentication_source="admin" if test_db_settings["username"] else None,
    )
    
    # Очищаем все коллекции перед тестом
    _cleanup_database()
    
    yield
    
    # Очищаем после теста
    _cleanup_database()
    
    # Отключаемся
    mongoengine.disconnect()


def _cleanup_database():
    """Очищает все коллекции тестовой базы данных."""
    collections = [
        User, Dataset, Project, Task,
        Annotation, LabelingSession,
        QualityMetric, QualityReview,
        Transaction, PaymentRequest,
        ImportSession,
        ImportAsset,
        FrameItem,
        WorkItem,
        Assignment,
        WorkAnnotation,
        ReviewRecord,
        BBoxValidationAssignment,
        GoldenFrame,
        GoldenAnnotationAssignment,
        GoldenAttempt,
    ]
    for model in collections:
        try:
            model.objects.delete()
        except Exception:
            pass


# =============================================================================
# Фикстуры пользователей
# =============================================================================

@pytest.fixture
def user_customer(db):
    """
    Создает пользователя с ролью customer (заказчик).
    
    Использование:
        def test_customer_action(user_customer):
            # user_customer - заказчик с ролью ROLE_CUSTOMER
    """
    user = User(
        email="customer@example.com",
        username="customer_user",
        role=User.ROLE_CUSTOMER,
    )
    user.set_password(TEST_PASSWORD)
    user.save()
    return user


@pytest.fixture
def user_annotator(db):
    """
    Создает пользователя с ролью annotator (исполнитель/разметчик).
    
    Использование:
        def test_annotator_action(user_annotator):
            # user_annotator - исполнитель с ролью ROLE_ANNOTATOR
    """
    user = User(
        email="annotator@example.com",
        username="annotator_user",
        role=User.ROLE_ANNOTATOR,
    )
    user.set_password(TEST_PASSWORD)
    user.balance = Decimal("100.00")  # Начальный баланс для тестов
    user.save()
    return user


@pytest.fixture
def user_admin(db):
    """
    Создает пользователя с ролью admin (администратор).
    
    Использование:
        def test_admin_action(user_admin):
            # user_admin - админ с ролью ROLE_ADMIN
    """
    user = User(
        email="admin@example.com",
        username="admin_user",
        role=User.ROLE_ADMIN,
    )
    user.set_password(TEST_ADMIN_PASSWORD)
    user.save()
    return user


@pytest.fixture
def user_inactive(db):
    """
    Создает неактивного пользователя (для тестов блокировки).
    """
    user = User(
        email="inactive@example.com",
        username="inactive_user",
        role=User.ROLE_CUSTOMER,
        is_active=False,
    )
    user.set_password(TEST_PASSWORD)
    user.save()
    return user


@pytest.fixture
def user_reviewer(db):
    """Создает пользователя с ролью reviewer."""
    user = User(
        email="reviewer@example.com",
        username="reviewer_user",
        role=User.ROLE_REVIEWER,
    )
    user.set_password(TEST_PASSWORD)
    user.save()
    return user


@pytest.fixture
def jwt_token_reviewer(user_reviewer):
    """JWT токен для reviewer."""
    from apps.users.serializers import create_access_token
    return create_access_token(user_reviewer)


@pytest.fixture
def auth_headers_reviewer(jwt_token_reviewer):
    """Заголовки авторизации для reviewer."""
    return {"HTTP_AUTHORIZATION": f"Bearer {jwt_token_reviewer}"}


@pytest.fixture
def users(db, user_customer, user_annotator, user_admin):
    """
    Возвращает словарь всех пользователей.
    
    Использование:
        def test_multiple_users(users):
            customer = users["customer"]
            annotator = users["annotator"]
            admin = users["admin"]
    """
    return {
        "customer": user_customer,
        "annotator": user_annotator,
        "admin": user_admin,
    }


# =============================================================================
# Фикстуры для JWT токенов
# =============================================================================

@pytest.fixture
def jwt_token(user_customer):
    """
    Создает JWT токен для пользователя customer.
    
    Использование:
        def test_authenticated_request(client, jwt_token):
            headers = {"Authorization": f"Bearer {jwt_token}"}
            response = client.get("/api/datasets/", headers=headers)
    """
    from apps.users.serializers import create_access_token
    return create_access_token(user_customer)


@pytest.fixture
def jwt_token_annotator(user_annotator):
    """JWT токен для annotator."""
    from apps.users.serializers import create_access_token
    return create_access_token(user_annotator)


@pytest.fixture
def jwt_token_admin(user_admin):
    """JWT токен для admin."""
    from apps.users.serializers import create_access_token
    return create_access_token(user_admin)


@pytest.fixture
def auth_headers(jwt_token):
    """
    Заголовки авторизации для запросов.
    
    Использование:
        def test_api_request(client, auth_headers):
            response = client.get("/api/datasets/", **auth_headers)
    """
    return {"HTTP_AUTHORIZATION": f"Bearer {jwt_token}"}


@pytest.fixture
def auth_headers_annotator(jwt_token_annotator):
    """Заголовки авторизации для annotator."""
    return {"HTTP_AUTHORIZATION": f"Bearer {jwt_token_annotator}"}


@pytest.fixture
def auth_headers_admin(jwt_token_admin):
    """Заголовки авторизации для admin."""
    return {"HTTP_AUTHORIZATION": f"Bearer {jwt_token_admin}"}


# =============================================================================
# Фикстуры датасетов
# =============================================================================

@pytest.fixture
def dataset(user_customer):
    """
    Создает тестовый датасет для заказчика.
    
    Использование:
        def test_dataset_operations(db, dataset):
            # dataset принадлежит user_customer
    """
    ds = Dataset(
        owner=user_customer,
        name="Test Dataset",
        description="Тестовый датасет для unit-тестов",
        status=Dataset.STATUS_DRAFT,
        schema_version=1,
        metadata={
            "annotation_format": "classification_v1",
            "classes": ["cat", "dog", "bird"],
        },
    )
    ds.save()
    return ds


@pytest.fixture
def dataset_active(user_customer):
    """Создает активный датасет."""
    ds = Dataset(
        owner=user_customer,
        name="Active Dataset",
        description="Активный датасет",
        status=Dataset.STATUS_ACTIVE,
        schema_version=1,
        metadata={"annotation_format": "generic_v1"},
    )
    ds.save()
    return ds


@pytest.fixture
def datasets(db, user_customer):
    """
    Создает несколько датасетов для тестов пагинации.
    
    Использование:
        def test_pagination(db, datasets):
            # datasets - список из 5 датасетов
    """
    result = []
    for i in range(5):
        ds = Dataset(
            owner=user_customer,
            name=f"Dataset {i+1}",
            description=f"Описание датасета {i+1}",
            status=Dataset.STATUS_DRAFT,
            schema_version=1,
            metadata={"index": i},
        )
        ds.save()
        result.append(ds)
    return result


# =============================================================================
# Фикстуры проектов и задач
# =============================================================================

@pytest.fixture
def project(user_customer, dataset):
    """
    Создает тестовый проект.
    
    Использование:
        def test_project_operations(db, project):
            # project принадлежит user_customer
    """
    proj = Project(
        owner=user_customer,
        title="Test Project",
        description="Тестовый проект для разметки данных",
        status=Project.STATUS_ACTIVE,
    )
    proj.save()
    return proj


@pytest.fixture
def task(dataset, project):
    """
    Создает тестовую задачу разметки.
    
    Использование:
        def test_task_operations(db, task):
            # task связана с dataset и project
    """
    t = Task(
        dataset=dataset,
        project=project,
        title="Test Task",
        description="Задача на разметку изображений",
        status=Task.STATUS_PENDING,
        input_data={"image_url": "http://example.com/image.jpg"},
        difficulty_score=0.5,
    )
    t.save()
    return t


@pytest.fixture
def task_assigned(task, user_annotator):
    """
    Создает задачу, назначенную на исполнителя.
    """
    task.annotator = user_annotator
    task.status = Task.STATUS_IN_PROGRESS
    task.save()
    return task


@pytest.fixture
def tasks(db, dataset, project):
    """
    Создает несколько задач для тестов пагинации и фильтрации.
    """
    result = []
    statuses = [Task.STATUS_PENDING, Task.STATUS_IN_PROGRESS, Task.STATUS_REVIEW, Task.STATUS_COMPLETED]
    for i in range(8):
        t = Task(
            dataset=dataset,
            project=project,
            title=f"Task {i+1}",
            description=f"Описание задачи {i+1}",
            status=statuses[i % len(statuses)],
            input_data={"index": i},
            difficulty_score=0.1 * (i + 1),
        )
        t.save()
        result.append(t)
    return result


# =============================================================================
# Фикстуры аннотаций и сессий разметки
# =============================================================================

@pytest.fixture
def labeling_session(user_annotator, task, dataset):
    """
    Создает сессию разметки.
    
    Использование:
        def test_labeling_process(db, labeling_session):
            # labeling_session активна для task
    """
    session = LabelingSession(
        annotator=user_annotator,
        task=task,
        dataset=dataset,
        status=LabelingSession.STATUS_ACTIVE,
        ai_assisted=True,
    )
    session.save()
    return session


@pytest.fixture
def annotation(user_annotator, task, dataset):
    """
    Создает тестовую аннотацию.
    
    Использование:
        def test_annotation_operations(db, annotation):
            # annotation создана user_annotator для task
    """
    ann = Annotation(
        annotator=user_annotator,
        task=task,
        dataset=dataset,
        annotation_format="classification_v1",
        label_data={"class": "cat", "confidence": 0.95},
        predicted_data={"class": "dog", "confidence": 0.80},
        status=Annotation.STATUS_SUBMITTED,
        is_final=True,
    )
    ann.save()
    return ann


@pytest.fixture
def annotations_pair(db, task, dataset, user_annotator, user_customer):
    """
    Создает две аннотации для одной задачи (для cross-check).
    
    Использование:
        def test_quality_review(db, annotations_pair):
            ann_a, ann_b = annotations_pair
            # Две аннотации от разных пользователей
    """
    ann_a = Annotation(
        annotator=user_annotator,
        task=task,
        dataset=dataset,
        annotation_format="classification_v1",
        label_data={"class": "cat"},
        status=Annotation.STATUS_SUBMITTED,
        is_final=True,
    )
    ann_a.save()
    
    ann_b = Annotation(
        annotator=user_customer,  # Второй аннотатор
        task=task,
        dataset=dataset,
        annotation_format="classification_v1",
        label_data={"class": "cat"},
        status=Annotation.STATUS_SUBMITTED,
        is_final=True,
    )
    ann_b.save()
    
    return ann_a, ann_b


# =============================================================================
# Фикстуры контроля качества
# =============================================================================

@pytest.fixture
def quality_review(db, task, dataset, annotations_pair):
    """
    Создает review для контроля качества.
    
    Использование:
        def test_quality_flow(db, quality_review):
            # quality_review сравнивает две аннотации
    """
    ann_a, ann_b = annotations_pair
    
    review = QualityReview(
        task=task,
        dataset=dataset,
        annotation_a=ann_a,
        annotation_b=ann_b,
        review_status=QualityReview.STATUS_PENDING,
        metrics={"precision": 0.9, "recall": 0.85, "f1": 0.87},
        final_label_data={"class": "cat"},
    )
    review.save()
    return review


@pytest.fixture
def quality_metric(db, task, dataset):
    """
    Создает метрику качества.
    """
    metric = QualityMetric(
        dataset=dataset,
        task=task,
        precision=0.92,
        recall=0.88,
        f1=0.90,
        details={"accuracy": 0.91, "samples": 100},
    )
    metric.save()
    return metric


# =============================================================================
# Фикстуры финансов
# =============================================================================

@pytest.fixture
def transaction(user_customer):
    """
    Создает тестовую транзакцию.
    
    Использование:
        def test_transaction_flow(db, transaction):
            # transaction типа payment для user_customer
    """
    tx = Transaction(
        user=user_customer,
        type=Transaction.TYPE_PAYMENT,
        status=Transaction.STATUS_PENDING,
        amount=Decimal("50.00"),
        currency="USD",
        external_id="stripe_pi_123456",
        metadata={"description": "Пополнение баланса"},
    )
    tx.save()
    return tx


@pytest.fixture
def transaction_completed(user_customer):
    """Создает завершенную транзакцию."""
    tx = Transaction(
        user=user_customer,
        type=Transaction.TYPE_PAYMENT,
        status=Transaction.STATUS_COMPLETED,
        amount=Decimal("100.00"),
        currency="USD",
        external_id="stripe_pi_789012",
    )
    tx.save()
    return tx


@pytest.fixture
def payout_transaction(user_annotator):
    """Создает транзакцию выплаты исполнителю."""
    tx = Transaction(
        user=user_annotator,
        type=Transaction.TYPE_PAYOUT,
        status=Transaction.STATUS_PENDING,
        amount=Decimal("25.00"),
        currency="USD",
        metadata={"description": "Выплата за разметку"},
    )
    tx.save()
    return tx


@pytest.fixture
def payment_request(transaction):
    """
    Создает платежный запрос.
    
    Использование:
        def test_payment_request(db, payment_request):
            # payment_request связан с transaction
    """
    pr = PaymentRequest(
        payment_type=PaymentRequest.PAYMENT_PAY,
        status=PaymentRequest.STATUS_PENDING,
        transaction=transaction,
        stripe_payment_intent_id="pi_123456",
        webhook_payload={"event": "payment.succeeded"},
    )
    pr.save()
    return pr


@pytest.fixture
def transactions_batch(db, user_customer):
    """
    Создает несколько транзакций для тестов пагинации.
    """
    result = []
    for i in range(10):
        tx = Transaction(
            user=user_customer,
            type=Transaction.TYPE_PAYMENT if i % 2 == 0 else Transaction.TYPE_PAYOUT,
            status=Transaction.STATUS_COMPLETED if i % 3 == 0 else Transaction.STATUS_PENDING,
            amount=Decimal(f"{10.00 + i}"),
            currency="USD",
            metadata={"index": i},
        )
        tx.save()
        result.append(tx)
    return result


# =============================================================================
# Вспомогательные фикстуры
# =============================================================================

@pytest.fixture
def client():
    """
    Возвращает DRF API client для тестов.
    
    Использование:
        def test_api_endpoint(client):
            response = client.get("/api/datasets/")
    """
    from rest_framework.test import APIClient
    return APIClient()


@pytest.fixture
def sample_image_data():
    """
    Возвращает тестовые данные изображения (base64 placeholder).
    """
    return {
        "image_url": "http://example.com/test.jpg",
        "width": 800,
        "height": 600,
        "format": "jpeg",
    }


@pytest.fixture
def sample_text_data():
    """
    Возвращает тестовые текстовые данные.
    """
    return {
        "text": "Это тестовый текст для NLP разметки.",
        "language": "ru",
        "length": 45,
    }


@pytest.fixture
def mock_ml_model(monkeypatch):
    """
    Mock для ML модели (AI-assisted разметка).
    
    Использование:
        def test_ai_labeling(mock_ml_model):
            # ML модель возвращает предсказуемый результат
    """
    def mock_predict(self, input_data):
        return {"predicted_class": "mock_class", "confidence": 0.99}
    
    monkeypatch.setattr(
        "apps.labeling.models.LabelingSession.auto_label",
        mock_predict,
    )
