from django.apps import AppConfig


class UsersConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.users"

    def ready(self):
        # Импортируем сигналы для автоматического создания уведомлений
        import apps.users.notification_signals  # noqa
