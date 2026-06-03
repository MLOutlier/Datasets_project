"""
Django settings for Dataset AI project.

Настройки с детальным логированием и таймаутами для отладки блокировок.
"""

import os
import logging
from pathlib import Path
from datetime import timedelta

BASE_DIR = Path(__file__).resolve().parent.parent

# =============================================================================
# ЛОГИРОВАНИЕ
# =============================================================================
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# =============================================================================
# ОБЩИЕ НАСТРОЙКИ
# =============================================================================
# SECRET_KEY должен быть явно установлен в .env!
SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-key-change-in-production")
if not SECRET_KEY:
    raise ValueError("SECRET_KEY must be set in environment variables")
DEBUG = os.getenv("DEBUG", "True").lower() in ("true", "1", "yes")
ALLOWED_HOSTS = os.getenv("ALLOWED_HOSTS", "localhost,127.0.0.1,0.0.0.0").split(",")

# =============================================================================
# CORS
# =============================================================================
CORS_ALLOWED_ORIGINS = os.getenv(
    "CORS_ALLOWED_ORIGINS",
    "http://localhost:3000,http://localhost:5173,http://127.0.0.1:3000,http://127.0.0.1:5173,http://0.0.0.0:5173"
).split(",")
CORS_ALLOW_CREDENTIALS = True
CORS_ALLOW_ALL_ORIGINS = DEBUG  # ✅ Для разработки разрешить все

# =============================================================================
# ПРИЛОЖЕНИЯ
# =============================================================================
INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "corsheaders",
    "apps.core",      # Health checks
    "apps.users",
    "apps.datasets_core",
    "apps.projects",
    "apps.labeling",
    "apps.quality",
    "apps.finance",
    "apps.cv_annotation",
]

# =============================================================================
# MIDDLEWARE
# =============================================================================
# ВАЖНО: CorsMiddleware должен быть ПЕРВЫМ в списке!
MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",  # ✅ ПЕРВЫМ для обработки CORS
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"

# =============================================================================
# MONGODB НАСТРОЙКИ
# =============================================================================
MONGO_URI = os.getenv("MONGO_URI")
if not MONGO_URI:
    raise ValueError("MONGO_URI must be set in environment variables")

logger.info(f"MONGO_URI настроен: {MONGO_URI.split('@')[-1].split('/')[0] if '@' in MONGO_URI else MONGO_URI}")

# =============================================================================
# BCRYPT НАСТРОЙКИ
# =============================================================================
# Разработка: 4 раунда (~100ms), Production: 12 раундов (~300ms)
BCRYPT_ROUNDS = int(os.environ.get('BCRYPT_ROUNDS', 4))
logger.info(f"BCRYPT_ROUNDS={BCRYPT_ROUNDS}")

# =============================================================================
# REDIS НАСТРОЙКИ
# =============================================================================
# REDIS_HOST = os.getenv("REDIS_HOST", "redis")
# REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
# REDIS_DB = int(os.getenv("REDIS_DB", "0"))

REDIS_URL = os.getenv("REDIS_URL")
CELERY_BROKER_URL = REDIS_URL
CELERY_RESULT_BACKEND = REDIS_URL

# =============================================================================
# БАЗЫ ДАННЫХ
# =============================================================================
# Django требует DATABASES - используем SQLite для сессий/admin (MongoDB используется через mongoengine)
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': BASE_DIR / 'db.sqlite3',
    }
}

# =============================================================================
# СЕССИИ
# =============================================================================
# Используем cache-based сессии через Redis (не требует SQL БД)
SESSION_ENGINE = 'django.contrib.sessions.backends.cache'
SESSION_CACHE_ALIAS = 'default'

# =============================================================================
# КЭШИРОВАНИЕ
# =============================================================================
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": f"redis://{REDIS_HOST}:{REDIS_PORT}/{REDIS_DB}",
        "TIMEOUT": 300,
    }
}

# =============================================================================
# CELERY
# =============================================================================
# Отключаем для разработки чтобы не блокировало регистрацию
CELERY_TASK_ALWAYS_EAGER = True  # Выполнять задачи синхронно
CELERY_BROKER_URL = f"redis://{REDIS_HOST}:{REDIS_PORT}/{REDIS_DB}"
CELERY_RESULT_BACKEND = f"redis://{REDIS_HOST}:{REDIS_PORT}/{REDIS_DB}"
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TASK_SERIALIZER = "json"
CELERY_RESULT_SERIALIZER = "json"
CELERY_TIMEZONE = "UTC"

# =============================================================================
# REST FRAMEWORK
# =============================================================================
REST_FRAMEWORK = {
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.AllowAny",  # JWT проверяется вручную в views
    ],
    "DEFAULT_AUTHENTICATION_CLASSES": [],  # Отключаем стандартную аутентификацию (JWT вручную)
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.AnonRateThrottle",
        "rest_framework.throttling.UserRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {
        "anon": "1000/hour",  # Увеличено для разработки (было 100)
        "user": "10000/hour", # Увеличено для разработки (было 1000)
        "login": "10/hour",
        "register": "5/hour",
    },
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.PageNumberPagination",
    "PAGE_SIZE": 20,
}

# =============================================================================
# STATIC FILES
# =============================================================================
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

# =============================================================================
# MEDIA FILES (загруженные пользователями файлы)
# =============================================================================
MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

# Максимальный размер загружаемого файла (500MB для видео)
MAX_UPLOAD_SIZE = int(os.getenv("MAX_UPLOAD_SIZE", str(500 * 1024 * 1024)))

# Разрешенные расширения
ALLOWED_EXTENSIONS = os.getenv("ALLOWED_EXTENSIONS", "jpg,jpeg,png,gif,mp4,avi,mov,txt,csv,json").split(",")
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# =============================================================================
# JWT НАСТРОЙКИ
# =============================================================================
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", SECRET_KEY)
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
JWT_ACCESS_TTL_MINUTES = int(os.getenv("JWT_ACCESS_TTL_MINUTES", "60"))

# =============================================================================
# PASSWORD HASHERS
# =============================================================================
PASSWORD_HASHERS = [
    'django.contrib.auth.hashers.BCryptSHA256PasswordHasher',  # Быстрый bcrypt
]

# =============================================================================
# CORS НАСТРОЙКИ
# =============================================================================
# Для разработки разрешаем все origin (в production указать конкретные)
CORS_ALLOW_ALL_ORIGINS = True  # ✅ Разрешить все для разработки
CORS_ALLOW_CREDENTIALS = True  # ✅ Разрешить cookies и auth headers

# Явно разрешенные origin (альтернатива CORS_ALLOW_ALL_ORIGINS)
CORS_ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://0.0.0.0:5173",
]

# Разрешенные заголовки
CORS_ALLOW_HEADERS = [
    "accept",
    "accept-encoding",
    "authorization",
    "content-type",
    "dnt",
    "origin",
    "user-agent",
    "x-csrftoken",
    "x-requested-with",
]

# Разрешенные методы
CORS_ALLOW_METHODS = [
    "DELETE",
    "GET",
    "OPTIONS",
    "PATCH",
    "POST",
    "PUT",
]

# =============================================================================
# MONGODB ПОДКЛЮЧЕНИЕ
# =============================================================================
import mongoengine

try:
    connect = mongoengine.connect(host=MONGO_URI, alias='default')
    # Извлекаем имя хоста для логирования (убираем credentials если есть)
    host_info = MONGO_URI.split('@')[-1].split('/')[0] if '@' in MONGO_URI else MONGO_URI.split('//')[1].split('/')[0]
    logger.info(f"✓ MongoDB подключен: {host_info}")
except Exception as e:
    logger.error(f"✗ Ошибка подключения к MongoDB: {e}")
    raise

# =============================================================================
# ANNOTATOR RATING (Dawid-Skene + EWMA)
# =============================================================================
ANNOTATOR_RATING_ALPHA = float(os.getenv("ANNOTATOR_RATING_ALPHA", "0.1"))  # скорость обновления рейтинга
