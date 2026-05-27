"""
Сигналы для автоматического создания уведомлений при различных событиях.
"""

from django.db.models.signals import post_save
from django.dispatch import receiver
from ..cv_annotation.models import Assignment
from ..quality.models import QualityReview
from .notification_utils import notify_task_assigned, notify_task_approved, notify_task_rejected


@receiver(post_save, sender=Assignment)
def assignment_created_handler(sender, instance, created, **kwargs):
    """Уведомление при назначении задачи"""
    if created and instance.status == Assignment.STATUS_ASSIGNED:
        project_title = instance.project.title if instance.project else "проекте"
        notify_task_assigned(instance.annotator, str(instance.id), project_title)


@receiver(post_save, sender=QualityReview)
def review_completed_handler(sender, instance, **kwargs):
    """Уведомление при завершении проверки качества"""
    if instance.review_status in [QualityReview.STATUS_COMPLETED, QualityReview.STATUS_ARBITRATED]:
        metrics = instance.metrics or {}
        aggregate_f1 = metrics.get("aggregate_f1", 0.0)
        project_title = getattr(instance.task.project, 'title', 'проекте') if instance.task.project else 'проекте'
        
        for ann in instance.annotations:
            accuracy = (metrics.get("annotator_metrics", {}).get(str(ann.annotator.id), {}).get("accuracy", 0.0))
            if accuracy >= 0.7:
                notify_task_approved(ann.annotator, str(instance.task.id), project_title)
            else:
                notify_task_rejected(ann.annotator, str(instance.task.id), project_title)
