"""
Утилиты для создания уведомлений в различных частях приложения.
"""
from .notifications import create_notification
from .models import User

def notify_task_assigned(user: User, assignment_id: str, project_id: str, project_title: str, project_type: str = "bbox"):
    """Уведомление о назначении задачи"""
    create_notification(
        user=user,
        type="task_assigned",
        title="📋 Новая задача!",
        message=f"Вам назначена задача в проекте «{project_title}»",
        data={
            "assignment_id": assignment_id,
            "project_id": project_id,
            "project_title": project_title,
            "project_type": project_type,
            "workflow_stage": "annotation"
        }
    )

def notify_task_submitted(annotator: User, reviewer: User, assignment_id: str, project_id: str, project_title: str):
    """Уведомление о том, что задача отправлена на проверку"""
    create_notification(
        user=reviewer,
        type="task_submitted",
        title="📤 Задача на проверке",
        message=f"Пользователь {annotator.username} отправил задачу на проверку в проекте «{project_title}»",
        data={
            "assignment_id": assignment_id,
            "project_id": project_id,
            "project_title": project_title,
            "workflow_stage": "review"
        }
    )

def notify_task_approved(user: User, assignment_id: str, project_id: str, project_title: str):
    """Уведомление о том, что задача принята"""
    create_notification(
        user=user,
        type="task_approved",
        title="✅ Задача принята!",
        message=f"Ваша разметка в проекте «{project_title}» принята. Рейтинг обновлён.",
        data={
            "assignment_id": assignment_id,
            "project_id": project_id,
            "project_title": project_title,
            "workflow_stage": "completed"
        }
    )

def notify_task_rejected(user: User, assignment_id: str, project_id: str, project_title: str, reason: str = None):
    """Уведомление о том, что задача отклонена"""
    message = f"Ваша разметка в проекте «{project_title}» отправлена на доработку"
    if reason:
        message += f": {reason}"
    create_notification(
        user=user,
        type="task_rejected",
        title="🔄 Задача на доработке",
        message=message,
        data={
            "assignment_id": assignment_id,
            "project_id": project_id,
            "project_title": project_title,
            "workflow_stage": "rework"
        }
    )

def notify_payment_received(user: User, amount: float, task_id: str = None, project_title: str = None):
    """Уведомление о получении оплаты"""
    message = f"На ваш счёт поступило {amount} USD"
    if project_title:
        message += f" за проект «{project_title}»"
    create_notification(
        user=user,
        type="payment_received",
        title="💰 Получена оплата!",
        message=message,
        data={"amount": amount, "task_id": task_id} if task_id else {"amount": amount}
    )

def notify_payment_sent(user: User, amount: float, to_user: User, task_id: str = None):
    """Уведомление об отправке оплаты"""
    create_notification(
        user=user,
        type="payment_received",
        title="💸 Отправлена оплата",
        message=f"Вы отправили {amount} USD пользователю {to_user.username}",
        data={
            "amount": amount,
            "to_user_id": str(to_user.id),
            "to_username": to_user.username,
            "task_id": task_id
        }
    )
