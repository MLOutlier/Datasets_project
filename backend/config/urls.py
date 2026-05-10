from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path
from rest_framework.routers import DefaultRouter

from apps.core.views import HealthCheckView, MongoDBCheckView, RedisCheckView
from apps.datasets_core.views import DatasetCollectionView, DatasetDetailView
from apps.finance.views import PaymentViewSet, TransactionViewSet
from apps.labeling.views import AnnotationViewSet
from apps.projects.views import ProjectViewSet, TaskViewSet
from apps.quality.views import MetricsViewSet, ReviewViewSet
from apps.quality.views_dawid_skene import project_dawid_skene_view
from apps.quality.views_iou import check_iou_view
from apps.users.views import (
    BulkCreateAnnotatorsView,
    avatar_delete_view,
    avatar_upload_view,
    login,
    me_view,
    participants_view,
    register,
    user_stats_view,
)


router = DefaultRouter()

router.register(r"projects", ProjectViewSet, basename="project")
router.register(r"tasks", TaskViewSet, basename="task")
router.register(r"annotations", AnnotationViewSet, basename="annotation")
router.register(r"quality/review", ReviewViewSet, basename="quality-review")
router.register(r"quality/metrics", MetricsViewSet, basename="quality-metrics")
router.register(r"finance/payments", PaymentViewSet, basename="payment")
router.register(r"finance/transactions", TransactionViewSet, basename="transaction")

urlpatterns = [
    path("admin/", admin.site.urls),
    path(
        "api/",
        include(
            [
                path("health/", HealthCheckView.as_view(), name="health-check"),
                path("health/mongodb/", MongoDBCheckView.as_view(), name="health-mongodb"),
                path("health/redis/", RedisCheckView.as_view(), name="health-redis"),
                path("users/me/", me_view, name="user-me"),
                path("users/me/stats/", user_stats_view, name="user-stats"),
                path("users/me/avatar/", avatar_upload_view, name="avatar-upload"),
                path("users/me/avatar/delete/", avatar_delete_view, name="avatar-delete"),
                path("users/participants/", participants_view, name="user-participants"),
                path(
                    "users/bulk-create-annotators/",
                    BulkCreateAnnotatorsView.as_view(),
                    name="bulk-create-annotators",
                ),
                path("auth/register/", register, name="auth-register"),
                path("auth/login/", login, name="auth-login"),
                path("datasets/", DatasetCollectionView.as_view(), name="dataset-list"),
                path("datasets/<str:dataset_id>/", DatasetDetailView.as_view(), name="dataset-detail"),
                path(
                    "quality/project/<str:project_id>/dawid-skene/",
                    project_dawid_skene_view,
                    name="project-dawid-skene",
                ),
                path("quality/check-iou/", check_iou_view, name="quality-check-iou"),
            ]
            + router.urls
        ),
    ),
    path("api/", include("apps.cv_annotation.urls")),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

admin.site.site_header = "Dataset AI Admin"
admin.site.site_title = "Dataset AI Admin Portal"
admin.site.index_title = "Панель администратора"
