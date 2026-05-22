"""
Модель пользователя для проекта "Сервис по сбору Dataset для ИИ".

Использует bcrypt для хеширования паролей.
Для разработки используется 4 раунда (быстро), для production - 12+.
Добавлено детальное логирование для отладки блокировок.
"""

from __future__ import annotations

import logging
import time
import bcrypt
from datetime import datetime
from django.conf import settings
from mongoengine import (
    BooleanField, DateTimeField, Document, DecimalField, EmailField,
    FloatField, IntField, StringField, ListField
)

logger = logging.getLogger(__name__)


class User(Document):
    """
    Кастомный пользователь (MongoEngine). Пароль хранится только в виде хеша.

    Роли:
    - customer: заказчик (создает датасеты и задачи)
    - annotator: исполнитель (размечает данные)
    - reviewer: проверяющий качество разметки
    - admin: администратор (полный доступ)
    """

    ROLE_CUSTOMER = "customer"      # Заказчик
    ROLE_ANNOTATOR = "annotator"    # Исполнитель
    ROLE_REVIEWER = "reviewer"      # Проверяющий
    ROLE_ADMIN = "admin"            # Администратор

    ROLE_CHOICES = (
        (ROLE_CUSTOMER, "customer"),
        (ROLE_ANNOTATOR, "annotator"),
        (ROLE_REVIEWER, "reviewer"),
        (ROLE_ADMIN, "admin"),
    )

    # Поля пользователя
    email = EmailField(required=True, unique=True)
    username = StringField(required=True, unique=True, max_length=150)
    role = StringField(
        required=True,
        choices=[c[0] for c in ROLE_CHOICES],
        default=ROLE_CUSTOMER
    )
    password_hash = StringField(required=True)
    is_active = BooleanField(default=True)

    # Рейтинг исполнителя (обновляется после QC-арбитража/метрик).
    rating = FloatField(default=0.0)
    completed_assignments = IntField(default=0, min_value=0)
    conflict_rate = FloatField(default=0.0, min_value=0.0, max_value=1.0)

    # Баланс пользователя для выплат/расчетов (обновляется атомарными $inc в finance).
    balance = DecimalField(default=0, precision=20, rounding=None)

    # Дополнительные поля для аннотаторов и ревьюеров
    specialization = StringField(max_length=100, default="")
    group_name = StringField(max_length=100, default="")      # устаревшее поле, оставлено для совместимости
    groups = ListField(StringField(max_length=100), default=list)  # список групп/команд
    experience_level = StringField(max_length=50, default="")

    # ✅ Аватар пользователя (хранится как data URL: data:image/...;base64,...)
    avatar_file = StringField(default="")

    created_at = DateTimeField(default=datetime.utcnow)
    updated_at = DateTimeField(default=datetime.utcnow)

    # Индексы для ускорения поиска и уникальности
    meta = {
        "collection": "users",
        "strict": False,
        "indexes": [
            {"fields": ["email"], "unique": True},
            {"fields": ["username"], "unique": True},
            {"fields": ["role", "is_active"]},
            {"fields": ["groups"]},
        ]
    }

    def save(self, *args, **kwargs):
        """Сохранение пользователя с обновлением timestamp и логированием."""
        start_time = time.time()
        logger.info(f"Начало сохранения пользователя: {self.email}")
        self.updated_at = datetime.utcnow()
        result = super().save(*args, **kwargs)
        elapsed = round(time.time() - start_time, 3)
        logger.info(f"Пользователь сохранен успешно: {self.id} (время: {elapsed} сек)")
        return result

    def set_password(self, raw_password: str) -> None:
        """
        Хеширование пароля с использованием bcrypt.
        Для разработки: rounds=4 (быстро ~100ms), для production: rounds=12 (~300ms)
        """
        start_time = time.time()
        logger.info(f"Начало хеширования пароля для: {self.email}")

        rounds = getattr(settings, 'BCRYPT_ROUNDS', 4)
        logger.info(f"BCRYPT_ROUNDS={rounds}")

        salt = bcrypt.gensalt(rounds=rounds)
        self.password_hash = bcrypt.hashpw(
            raw_password.encode('utf-8'),
            salt
        ).decode('utf-8')

        total_time = round(time.time() - start_time, 3)
        logger.info(f"Хеширование завершено за {total_time} сек (rounds={rounds})")

    def check_password(self, raw_password: str) -> bool:
        """
        Проверка пароля через bcrypt.
        """
        start_time = time.time()
        logger.info(f"Начало проверки пароля для: {self.email}")

        try:
            result = bcrypt.checkpw(
                raw_password.encode('utf-8'),
                self.password_hash.encode('utf-8')
            )
            logger.info(f"Проверка пароля: {result}")
            return result
        except Exception as e:
            logger.error(f"Ошибка при проверке пароля: {e}", exc_info=True)
            return False
