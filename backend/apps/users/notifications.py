from __future__ import annotations

from datetime import datetime, timezone
from mongoengine import (
    BooleanField, DateTimeField, DictField, Document,
    ReferenceField, StringField
)
from .models import User


class Notification(Document):
    """
    Уведомление для пользователя.
    """
    
    TYPE_TASK_ASSIGNED = "task_assigned"
    TYPE_TASK_SUBMITTED = "task_submitted"
    TYPE_TASK_APPROVED = "task_approved"
    TYPE_TASK_REJECTED = "task_rejected"
    TYPE_PAYMENT_RECEIVED = "payment_received"
    TYPE_PROJECT_CREATED = "project_created"
    TYPE_PROJECT_COMPLETED = "project_completed"
    
    TYPE_CHOICES = (
        (TYPE_TASK_ASSIGNED, "Назначена задача"),
        (TYPE_TASK_SUBMITTED, "Задача отправлена"),
        (TYPE_TASK_APPROVED, "Задача принята"),
        (TYPE_TASK_REJECTED, "Задача отклонена"),
        (TYPE_PAYMENT_RECEIVED, "Получена оплата"),
        (TYPE_PROJECT_CREATED, "Создан проект"),
        (TYPE_PROJECT_COMPLETED, "Проект завершён"),
    )
    
    user = ReferenceField(User, required=True, reverse_delete_rule=1)
    type = StringField(required=True, choices=[c[0] for c in TYPE_CHOICES])
    title = StringField(required=True, max_length=255)
    message = StringField(required=True, max_length=1000)
    data = DictField(default=dict)
    is_read = BooleanField(default=False)
    created_at = DateTimeField(default=lambda: datetime.now(timezone.utc))  # UTC
    read_at = DateTimeField(null=True)
    
    meta = {
        "collection": "notifications",
        "indexes": [
            ("user", "-created_at"),
            ("user", "is_read"),
        ]
    }
    
    def mark_as_read(self):
        if not self.is_read:
            self.is_read = True
            self.read_at = datetime.now(timezone.utc)
            self.save()


def create_notification(user: User, type: str, title: str, message: str, data: dict = None) -> Notification:
    notification = Notification(
        user=user,
        type=type,
        title=title,
        message=message,
        data=data or {}
    )
    notification.save()
    return notification
