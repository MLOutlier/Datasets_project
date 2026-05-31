"""
Health check views для проверки подключения ко всем сервисам.

GET /api/health/ - проверка MongoDB, Redis, Django
"""

import logging
import shutil
import time
from datetime import datetime
from pathlib import Path

from django.conf import settings
from django.core.cache import cache
from mongoengine import connection
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

logger = logging.getLogger(__name__)


class HealthCheckView(APIView):
    """
    Проверка здоровья всех сервисов системы.

    GET /api/health/

    Response (200 - все сервисы работают):
    {
        "status": "healthy",
        "timestamp": "2024-01-01T12:00:00Z",
        "services": {
            "mongodb": {"status": "up", "latency_ms": 5},
            "redis": {"status": "up", "latency_ms": 2},
            "django": {"status": "up"}
        }
    }

    Response (503 - есть проблемы):
    {
        "status": "unhealthy",
        "timestamp": "...",
        "services": {
            "mongodb": {"status": "down", "error": "..."},
            ...
        }
    }
    """

    permission_classes = [permissions.AllowAny]

    def get(self, request):
        result = {
            "status": "healthy",
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "services": {}
        }
        http_status = status.HTTP_200_OK

        # ========== Проверка MongoDB ==========
        start_mongo = time.time()
        try:
            # Получаем соединение и выполняем ping
            conn = connection.get_connection()
            conn.admin.command('ping')
            mongo_latency = round((time.time() - start_mongo) * 1000, 2)

            result["services"]["mongodb"] = {
                "status": "up",
                "latency_ms": mongo_latency
            }
            logger.info(f"Health check: MongoDB up ({mongo_latency}ms)")

        except Exception as e:
            result["services"]["mongodb"] = {
                "status": "down",
                "error": str(e)
            }
            result["status"] = "unhealthy"
            http_status = status.HTTP_503_SERVICE_UNAVAILABLE
            logger.error(f"Health check: MongoDB down: {e}")

        # ========== Проверка Redis ==========
        start_redis = time.time()
        try:
            cache.set('health_check_key', 'test', timeout=5)
            value = cache.get('health_check_key')
            cache.delete('health_check_key')

            if value != 'test':
                raise Exception("Redis read/write mismatch")

            redis_latency = round((time.time() - start_redis) * 1000, 2)

            result["services"]["redis"] = {
                "status": "up",
                "latency_ms": redis_latency
            }
            logger.info(f"Health check: Redis up ({redis_latency}ms)")

        except Exception as e:
            result["services"]["redis"] = {
                "status": "down",
                "error": str(e)
            }
            result["status"] = "unhealthy"
            http_status = status.HTTP_503_SERVICE_UNAVAILABLE
            logger.error(f"Health check: Redis down: {e}")

        # ========== Проверка Django ==========
        result["services"]["django"] = {
            "status": "up",
            "debug": settings.DEBUG
        }

        # ========== Итоговый статус ==========
        if result["status"] == "healthy":
            logger.info("Health check: ALL SERVICES UP")
        else:
            logger.error(f"Health check: UNHEALTHY - {result}")

        return Response(result, status=http_status)


class MongoDBCheckView(APIView):
    """
    Проверка только MongoDB.

    GET /api/health/mongodb/
    """

    permission_classes = [permissions.AllowAny]

    def get(self, request):
        start = time.time()
        try:
            conn = connection.get_connection()
            conn.admin.command('ping')
            latency = round((time.time() - start) * 1000, 2)

            return Response({
                "status": "up",
                "latency_ms": latency,
                "host": settings.MONGO_URI
            })

        except Exception as e:
            return Response({
                "status": "down",
                "error": str(e)
            }, status=status.HTTP_503_SERVICE_UNAVAILABLE)


class RedisCheckView(APIView):
    """
    Проверка только Redis.

    GET /api/health/redis/
    """

    permission_classes = [permissions.AllowAny]

    def get(self, request):
        start = time.time()
        try:
            cache.set('test_key', 'test', timeout=5)
            value = cache.get('test_key')
            cache.delete('test_key')

            if value != 'test':
                raise Exception("Redis read/write mismatch")

            latency = round((time.time() - start) * 1000, 2)

            return Response({
                "status": "up",
                "latency_ms": latency,
                "location": settings.CACHES['default']['LOCATION']
            })

        except Exception as e:
            return Response({
                "status": "down",
                "error": str(e)
            }, status=status.HTTP_503_SERVICE_UNAVAILABLE)


class ReadinessCheckView(APIView):
    """
    Lightweight readiness endpoint for production probes.

    GET /api/ready/
    """

    permission_classes = [permissions.AllowAny]

    def get(self, request):
        checks = {}
        ready = True

        try:
            conn = connection.get_connection()
            conn.admin.command("ping")
            checks["mongodb"] = {"status": "ready"}
        except Exception as exc:
            checks["mongodb"] = {"status": "not_ready", "error": str(exc)}
            ready = False

        try:
            cache.set("readiness_check_key", "ok", timeout=5)
            value = cache.get("readiness_check_key")
            cache.delete("readiness_check_key")
            if value != "ok":
                raise RuntimeError("Redis read/write mismatch")
            checks["redis"] = {"status": "ready"}
        except Exception as exc:
            checks["redis"] = {"status": "not_ready", "error": str(exc)}
            ready = False

        media_root = Path(settings.MEDIA_ROOT)
        try:
            media_root.mkdir(parents=True, exist_ok=True)
            probe_path = media_root / ".readiness_check"
            probe_path.write_text("ok", encoding="utf-8")
            probe_path.unlink(missing_ok=True)
            checks["media_storage"] = {"status": "ready", "path": str(media_root)}
        except Exception as exc:
            checks["media_storage"] = {"status": "not_ready", "path": str(media_root), "error": str(exc)}
            ready = False

        ffmpeg_path = shutil.which("ffmpeg")
        checks["ffmpeg"] = {
            "status": "ready" if ffmpeg_path else "missing",
            "path": ffmpeg_path or "",
            "required_for_video": True,
        }

        checks["celery"] = {
            "status": "eager" if getattr(settings, "CELERY_TASK_ALWAYS_EAGER", False) else "configured",
            "always_eager": bool(getattr(settings, "CELERY_TASK_ALWAYS_EAGER", False)),
        }

        payload = {
            "status": "ready" if ready else "not_ready",
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "checks": checks,
        }
        return Response(payload, status=status.HTTP_200_OK if ready else status.HTTP_503_SERVICE_UNAVAILABLE)
